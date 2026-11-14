import { canonical } from './crypto.js';
import { invoiceHash, invoicePaymentRoots, parseSignedInvoice, validateInvoiceStatus, verifySignedInvoice, type InvoiceStatus } from './invoices.js';
import { account, object, parsePolicy } from './payment.js';
import { organizationOrigin } from './organizations.js';
import type { Policy } from './types.js';
import type { OrganizationInvoice, OrganizationInvoiceClient } from './organization-invoices.js';

export type DashboardState = InvoiceStatus['state'] | 'unchecked' | 'unavailable' | 'stale';
export type InvoiceObservation = { status:InvoiceStatus; apiOrigin:string; observedAt:string };
export type InvoiceDashboardRow = { record:OrganizationInvoice; observation:InvoiceObservation|null; unavailable:boolean };
export type InvoiceDashboardFilter = { search?:string; state?:DashboardState|'all'; registry?:string; asset?:string; from?:string; to?:string };
const uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const utc=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
/** Complete, bounded organization snapshot. Newer concurrent creations appear on the next refresh. */
export async function loadOrganizationInvoices(client:Pick<OrganizationInvoiceClient,'list'>,org:string,signal:AbortSignal):Promise<OrganizationInvoice[]> {
  if(!uuid(org))throw new Error('Invalid organization');
  const result:OrganizationInvoice[]=[],ids=new Set<string>();let before:number|undefined;
  for(let page=0;page<20;page++) {
    signal.throwIfAborted();const value=await client.list(before,signal);signal.throwIfAborted();
    if(!value||!Array.isArray(value.items)||value.items.length>50)throw new Error('Invalid organization invoice page');
    let previous=before??Number.MAX_SAFE_INTEGER;
    for(const raw of value.items) {
      const r=object(raw);
      if(Object.keys(r).sort().join('|')!=='createdAt|createdBy|id|invoice|organizationId|sequence'||!uuid(r.id)||r.organizationId!==org||typeof r.sequence!=='number'||!Number.isSafeInteger(r.sequence)||r.sequence<1||r.sequence>=previous||ids.has(String(r.id))||!utc(r.createdAt))throw new Error('Organization invoice snapshot binding mismatch');
      const signed=await verifySignedInvoice(r.invoice);signal.throwIfAborted();
      if(account(r.createdBy)!==signed.invoice.merchantAccount||signed.invoice.policy.network!=='testnet')throw new Error('Organization invoice creator mismatch');
      const record:OrganizationInvoice={id:String(r.id),organizationId:org,sequence:r.sequence,createdAt:String(r.createdAt),createdBy:String(r.createdBy),invoice:signed};
      ids.add(record.id);previous=record.sequence;result.push(record);
    }
    if(value.nextCursor===null)return result;
    if(value.items.length!==50||value.nextCursor!==previous)throw new Error('Organization invoice cursor mismatch');
    before=previous;
  }
  throw new Error('Organization invoice snapshot exceeds supported limit');
}
export function invoiceDashboardState(row:InvoiceDashboardRow,now=Date.now()):DashboardState {
  if(!row.observation)return row.unavailable?'unavailable':'unchecked';
  const s=row.observation.status,time=Date.parse(s.checkedAt.updatedAt),observed=Date.parse(row.observation.observedAt);
  if(s.coverageLimited||(s.reusedPaymentReferences??0)>0)return 'review_required';
  if(!Number.isFinite(time)||!Number.isFinite(observed)||time>now+60000||observed>now+60000||now-time>300000||now-observed>300000)return 'stale';
  return s.state;
}
export function filterInvoiceDashboard(rows:InvoiceDashboardRow[],filter:InvoiceDashboardFilter,now=Date.now()) {
  const query=(filter.search??'').trim().normalize('NFKC').toLocaleLowerCase('en-US');
  const day=(value:string|undefined)=>{if(!value)return undefined;if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value)throw new Error('Invalid date filter');return value;};
  const from=day(filter.from),to=day(filter.to);if(from&&to&&from>to)throw new Error('Start date must precede end date');
  return rows.filter(row=>{
    const r=row.record,i=r.invoice.invoice,date=i.createdAt.slice(0,10);
    return (!filter.state||filter.state==='all'||invoiceDashboardState(row,now)===filter.state)&&(!filter.registry||i.policy.registry===filter.registry)&&(!filter.asset||(i.policy.tokenId??'NEAR')===filter.asset)&&(!from||date>=from)&&(!to||date<=to)&&(!query||[r.id,i.id,i.title,i.reference,i.recipient,i.merchantAccount,i.policy.registry,i.policy.tokenId??'NEAR'].some(s=>s.normalize('NFKC').toLocaleLowerCase('en-US').includes(query)));
  });
}
export async function invoiceDashboardObservation(record:OrganizationInvoice,trusted:Policy,apiOrigin:string,input:unknown,now=Date.now()):Promise<InvoiceObservation> {
  const policy=parsePolicy(trusted),signed=await verifySignedInvoice(record.invoice),s=validateInvoiceStatus(input,signed.invoice),roots=await invoicePaymentRoots(signed.invoice);
  if(canonical(policy)!==canonical(signed.invoice.policy)||s.invoiceHash!==await invoiceHash(signed.invoice)||(signed.invoice.version===1?s.settlementRoot!==roots[0]:s.settlementRoot!==null||canonical(s.settlementRoots)!==canonical(roots)))throw new Error('Dashboard settlement binding mismatch');
  const ids=new Set<string>();
  for(const c of s.confirmations) {
    if(!/^(0|[1-9][0-9]*)$/.test(c.nullifier)||c.nullifier.length>77||!Number.isSafeInteger(c.recordIndex)||!Number.isSafeInteger(c.blockHeight)||ids.has(c.nullifier))throw new Error('Invalid finalized invoice confirmation');
    ids.add(c.nullifier);
    if(c.transaction&&(typeof c.transaction.hash!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(c.transaction.hash)||account(c.transaction.signer)!==c.transaction.signer))throw new Error('Invalid finalized transaction reference');
  }
  if(!utc(s.checkedAt.updatedAt)||Date.parse(s.checkedAt.updatedAt)>now+60000)throw new Error('Invalid invoice checkpoint time');
  return {status:structuredClone(s),apiOrigin:organizationOrigin(apiOrigin),observedAt:new Date(now).toISOString()};
}
/** CSV is readable business data. Prefix spreadsheet formula cells and quote every value. */
export function exportInvoiceDashboard(rows:InvoiceDashboardRow[],format:'csv'|'json',now=Date.now()):string {
  if(rows.length>1000)throw new Error('Invoice export exceeds supported limit');
  const data=rows.map(row=>{
    const r=row.record,i=parseSignedInvoice(r.invoice).invoice,s=row.observation?.status;
    return {organizationId:r.organizationId,recordId:r.id,invoiceId:i.id,title:i.title,reference:i.reference,merchant:i.merchantAccount,recipient:i.recipient,network:i.policy.network,registry:i.policy.registry,asset:i.policy.tokenId??'NEAR',createdAt:i.createdAt,expiresAt:i.expiresAt,units:i.units,expectedTokens:(BigInt(i.policy.denomination)*BigInt(i.units)).toString(),state:invoiceDashboardState(row,now),observedState:s?.state??null,paidTokens:s?.paidTokens??null,remainingTokens:s?.remainingTokens??null,confirmedPayments:s?.confirmedPayments??null,confirmationRecordIndices:s?.confirmations.map(c=>c.recordIndex)??null,confirmationTransactionHashes:s?.confirmations.flatMap(c=>c.transaction?[c.transaction.hash]:[])??null,coverageLimited:s?.coverageLimited??null,indexHeight:s?.checkedAt.height??null,indexHash:s?.checkedAt.hash??null,indexUpdatedAt:s?.checkedAt.updatedAt??null,observedAt:row.observation?.observedAt??null,apiOrigin:row.observation?.apiOrigin??null,chainFreshnessChecked:false};
  });
  if(format==='json')return JSON.stringify({format:'core-invoice-dashboard-export-v1',exportedAt:new Date(now).toISOString(),scope:'filtered organization snapshot',amountUnit:'asset atomic units',rows:data},null,2)+'\n';
  const columns=['organizationId','recordId','invoiceId','title','reference','merchant','recipient','network','registry','asset','createdAt','expiresAt','units','expectedTokens','state','observedState','paidTokens','remainingTokens','confirmedPayments','confirmationRecordIndices','confirmationTransactionHashes','coverageLimited','indexHeight','indexHash','indexUpdatedAt','observedAt','apiOrigin','chainFreshnessChecked'] as const;
  const cell=(input:unknown)=>{let s=input===null||input===undefined?'':Array.isArray(input)?JSON.stringify(input):String(input);if(/^[\s\u0000-\u0020]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\ufeff'+[columns.map(cell).join(','),...data.map(row=>columns.map(c=>cell(row[c])).join(','))].join('\r\n')+'\r\n';
}
