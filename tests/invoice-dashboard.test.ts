import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { invoiceFixture } from './fixtures/invoices.js';
import { invoiceHash, invoicePaymentRoots, invoiceStatusRequest, type InvoiceStatus } from '../sdk/client/invoices.js';
import { exportInvoiceDashboard, filterInvoiceDashboard, invoiceDashboardObservation, invoiceDashboardState, loadOrganizationInvoices, type InvoiceDashboardRow } from '../sdk/client/invoice-dashboard.js';
import type { OrganizationInvoice } from '../sdk/client/organization-invoices.js';
import { indexedInvoiceStatus } from '../sdk/invoices.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { HttpGateway } from '../sdk/client/http.js';
import { createReadOnlyApi } from '../server/api.js';

const now=Date.parse('2026-11-14T12:00:00.000Z'),signal=()=>new AbortController().signal;
async function fixture(units=2) {
  const f=await invoiceFixture(units),invoice={...f.invoice,policy:{...f.invoice.policy,network:'testnet' as const}},signed=await f.signedInvoice(invoice);
  const record:OrganizationInvoice={id:randomUUID(),organizationId:randomUUID(),sequence:1,createdAt:new Date(now).toISOString(),createdBy:invoice.merchantAccount,invoice:signed};
  return {...f,invoice,signed,record,row:{record,observation:null,unavailable:false} as InvoiceDashboardRow};
}
async function status(f:Awaited<ReturnType<typeof fixture>>,count=0):Promise<InvoiceStatus> {
  const expected=BigInt(f.invoice.policy.denomination)*BigInt(f.invoice.units),paid=BigInt(f.invoice.policy.denomination)*BigInt(count);
  return {invoiceHash:await invoiceHash(f.invoice),settlementRoot:(await invoicePaymentRoots(f.invoice))[0],state:count===0?'expired':paid<expected?'partial_expired':paid===expected?'paid':'overpaid',expectedTokens:String(expected),paidTokens:String(paid),remainingTokens:String(paid<expected?expected-paid:0n),overpaidTokens:String(paid>expected?paid-expected:0n),lateTokens:'0',confirmedPayments:count,coverageLimited:false,checkedAt:{height:100,hash:'B'.repeat(44),updatedAt:new Date(now).toISOString()},chainFreshnessChecked:false,confirmations:Array.from({length:count},(_,i)=>({recordIndex:i,nullifier:String(i+1),blockHeight:90,late:false,transaction:{hash:'C'.repeat(44),signer:f.payer}}))};
}
test('dashboard validates every organization record and completes descending pagination before exposing rows',async()=>{
  const f=await fixture(),all=Array.from({length:52},(_,i)=>({...f.record,id:randomUUID(),sequence:52-i}));const calls:(number|undefined)[]=[];
  const rows=await loadOrganizationInvoices({list:async before=>{calls.push(before);return before===undefined?{items:all.slice(0,50),nextCursor:3}:{items:all.slice(50),nextCursor:null};}},f.record.organizationId,signal());
  assert.equal(rows.length,52);assert.deepEqual(calls,[undefined,3]);
});
test('dashboard rejects foreign organization records, duplicate IDs, ascending pages and unsafe cursors',async()=>{
  const f=await fixture();
  for(const items of [[{...f.record,organizationId:randomUUID()}],[f.record,f.record],[f.record,{...f.record,id:randomUUID(),sequence:2}]])await assert.rejects(loadOrganizationInvoices({list:async()=>({items,nextCursor:null})},f.record.organizationId,signal()));
  await assert.rejects(loadOrganizationInvoices({list:async()=>({items:[f.record],nextCursor:1})},f.record.organizationId,signal()),/cursor/);
});
test('dashboard rejects modified merchant signatures and creator mismatches',async()=>{
  const f=await fixture();
  for(const record of [{...f.record,invoice:{...f.signed,invoice:{...f.invoice,title:'Changed'}}},{...f.record,createdBy:'other.testnet'}])await assert.rejects(loadOrganizationInvoices({list:async()=>({items:[record],nextCursor:null})},f.record.organizationId,signal()));
});
test('cancelled organization snapshot cannot publish late page or signature results',async()=>{
  const f=await fixture(),controller=new AbortController();let release!:(v:{items:OrganizationInvoice[];nextCursor:null})=>void;
  const pending=loadOrganizationInvoices({list:()=>new Promise(r=>{release=r;})},f.record.organizationId,controller.signal);controller.abort();release({items:[f.record],nextCursor:null});await assert.rejects(pending,/abort/i);
});
test('search covers reference, title, recipient and signed ID with normalized case-insensitive matching',async()=>{
  const f=await fixture();for(const search of [' PROJECT ','청구',f.invoice.reference.toLowerCase(),f.invoice.recipient,f.invoice.id])assert.equal(filterInvoiceDashboard([f.row],{search},now).length,1);
  assert.equal(filterInvoiceDashboard([f.row],{search:'missing'},now).length,0);
});
test('asset, group, status and inclusive issue dates filter a complete snapshot',async()=>{
  const f=await fixture(),paid={...f.row,observation:await invoiceDashboardObservation(f.record,f.invoice.policy,'https://core.example',await status(f,2),now)};
  assert.equal(filterInvoiceDashboard([paid],{state:'paid',asset:f.invoice.policy.tokenId,registry:f.invoice.policy.registry,from:'2026-11-12',to:'2026-11-12'},now).length,1);
  for(const filter of [{state:'unchecked' as const},{asset:'NEAR'},{registry:'wrong.testnet'},{from:'2026-11-13'}])assert.equal(filterInvoiceDashboard([paid],filter,now).length,0);
  assert.throws(()=>filterInvoiceDashboard([paid],{from:'2026-11-14',to:'2026-11-12'},now));assert.throws(()=>filterInvoiceDashboard([paid],{from:'2026-02-30'},now));
});
test('unread, failed, stale and incomplete observations cannot appear as a current paid invoice',async()=>{
  const f=await fixture(),observation=await invoiceDashboardObservation(f.record,f.invoice.policy,'https://core.example',await status(f,2),now);
  assert.equal(invoiceDashboardState(f.row,now),'unchecked');assert.equal(invoiceDashboardState({...f.row,unavailable:true},now),'unavailable');
  assert.equal(invoiceDashboardState({...f.row,observation},now),'paid');assert.equal(invoiceDashboardState({...f.row,observation},now+300001),'stale');
  const limited={...observation,status:{...observation.status,state:'review_required' as const,coverageLimited:true}};assert.equal(invoiceDashboardState({...f.row,observation:limited},now),'review_required');
});
test('mismatched policy, payment roots, totals, confirmation blocks and transaction references are rejected',async()=>{
  const f=await fixture(),s=await status(f,2);
  for(const change of [{invoiceHash:'de'.repeat(32)},{settlementRoot:'de'.repeat(32)},{paidTokens:'1'},{confirmations:[{...s.confirmations[0],blockHeight:101},s.confirmations[1]]},{confirmations:[{...s.confirmations[0],transaction:{hash:'invalid',signer:f.payer}},s.confirmations[1]]},{checkedAt:{...s.checkedAt,updatedAt:new Date(now+60001).toISOString()}}])await assert.rejects(invoiceDashboardObservation(f.record,f.invoice.policy,'https://core.example',{...s,...change},now));
  await assert.rejects(invoiceDashboardObservation(f.record,{...f.invoice.policy,denomination:'2000000'},'https://core.example',s,now));
});
test('reused v2 unit references need review even if aggregate finalized totals equal principal',async()=>{
  const f=await fixture(),invoice={...f.invoice,version:2 as const,paymentNonces:['cd'.repeat(32),'ef'.repeat(32)]},signed=await f.signedInvoice(invoice),roots=await invoicePaymentRoots(invoice),s=await status(f,2);
  const record={...f.record,invoice:signed},observation=await invoiceDashboardObservation(record,invoice.policy,'https://core.example',{...s,invoiceHash:await invoiceHash(invoice),settlementRoot:null,settlementRoots:roots,reusedPaymentReferences:1,confirmations:s.confirmations.map(c=>({...c,settlementRoot:roots[0]}))},now);
  assert.equal(invoiceDashboardState({...f.row,record,observation},now),'review_required');
});
test('CSV protects spreadsheet formulas, preserves Unicode/quotes and includes filtered records beyond display pages',async()=>{
  const f=await fixture(),rows=Array.from({length:23},(_,i)=>({...f.row,record:{...f.record,id:randomUUID(),invoice:{...f.signed,invoice:{...f.invoice,title:i===0?'=SUM(1,2)':'中文 "청구"',reference:i===1?' +SUM(1,2)':f.invoice.reference}}}}));
  const csv=exportInvoiceDashboard(rows,'csv',now);assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes('"\'=SUM(1,2)"'));assert.ok(csv.includes('"\' +SUM(1,2)"'));assert.ok(csv.includes('中文 ""청구""'));assert.equal(csv.split('\r\n').length,25);
});
test('JSON export keeps atomic amounts exact, explicit unknowns and index scope without invoice signature/nonces',async()=>{
  const f=await fixture(),s=await status(f,2),observation=await invoiceDashboardObservation(f.record,f.invoice.policy,'https://core.example',s,now),data=JSON.parse(exportInvoiceDashboard([f.row,{...f.row,observation}],'json',now));
  assert.equal(data.rows[0].paidTokens,null);assert.equal(data.rows[0].state,'unchecked');assert.equal(data.rows[1].paidTokens,'2000000');assert.equal(data.rows[1].indexHeight,100);assert.equal(data.rows[1].chainFreshnessChecked,false);assert.equal(data.rows[1].apiOrigin,'https://core.example');assert.deepEqual(data.rows[1].confirmationRecordIndices,[0,1]);assert.deepEqual(data.rows[1].confirmationTransactionHashes,['C'.repeat(44),'C'.repeat(44)]);
  const text=JSON.stringify(data);assert.equal(text.includes(f.signed.signature.signature),false);assert.equal(text.includes(f.invoice.nonce),false);
});
test('real finalized index history ignores requested/failed payouts and foreign references, then counts successful payment',async()=>{
  const f=await invoiceFixture(1),store=new IndexStore(':memory:',f.policy),worker=new SettlementIndexer(f.source,store),roots=await invoicePaymentRoots(f.invoice),request=await invoiceStatusRequest(f.invoice);
  const payment=(index:number,kind:'withdrawal_requested'|'withdrawal_failed'|'withdrawal_succeeded',root=roots[0])=>f.record(index,{kind,commitment:null,nullifier:String(index+1),recipient:f.recipient,disclosure_root:root,protocol_fee_charged:kind==='withdrawal_requested'?'1500':'0',protocol_fee_earned:kind==='withdrawal_succeeded'?'1500':'0',storage_fee_charged:kind==='withdrawal_requested'?'20000000000000000000000':'0',timestamp_ns:String(BigInt(Date.parse(f.invoice.createdAt))*1000000n)});
  try {
    f.records.push(payment(0,'withdrawal_requested'),payment(1,'withdrawal_failed'),payment(2,'withdrawal_succeeded','ff'.repeat(32)));await worker.sync();
    let s=await indexedInvoiceStatus(store,f.policy,request,now);assert.equal(s.paidTokens,'0');assert.equal(s.confirmedPayments,0);
    f.state.height++;f.records.push(payment(3,'withdrawal_succeeded'));await worker.sync();s=await indexedInvoiceStatus(store,f.policy,request,now);assert.equal(s.state,'paid');assert.equal(s.confirmedPayments,1);assert.equal(s.confirmations[0].recordIndex,3);
  } finally {store.close();}
});
test('archived HTTP history works after merchant key rotation while checkout still requires a current merchant key',async t=>{
  const f=await invoiceFixture(1),store=new IndexStore(':memory:',f.policy);t.after(()=>store.close());await new SettlementIndexer(f.source,store).sync();
  const server=createReadOnlyApi({source:f.source,policy:f.policy,index:store});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const gateway=new HttpGateway(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  const archived=await gateway.invoiceHistory(f.signed);assert.equal(archived.paidTokens,'0');await assert.rejects(gateway.invoiceStatus(f.signed),/current merchant/);
  const controller=new AbortController();controller.abort();await assert.rejects(gateway.invoiceHistory(f.signed,{signal:controller.signal}));
});
