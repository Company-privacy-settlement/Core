import assert from 'node:assert/strict';
import { z } from 'zod';
import { recordFingerprint } from '../../sdk/evidence.js';
import { sharedRecord } from '../../sdk/indexer/types.js';
import { Count } from '../../sdk/validation.js';
import { PrivacyObservations, type PrivacyDataset } from './privacy-baseline.js';
import { verifyPublicWalletEvidence, verifyRecordedWalletTransaction } from './testnet-wallet-verification.js';

/** This adapter is specifically for the recorded two-note native qualification, not arbitrary FT history. */
export async function collectNativePrivacyObservations(evidence:unknown,transport:typeof fetch=fetch){
 const verification=await verifyPublicWalletEvidence(evidence,transport),e=evidence as any,p=e.policy;
 const read=async(method:'query'|'tx'|'block',params:unknown)=>{
  const response=await transport(e.rpcUrl,{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'core-privacy-read',method,params})});
  assert.ok(response.ok&&response.body,'RPC unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;assert.ok(size<=4194304,'RPC response exceeds bound');chunks.push(c.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.ok(!b.error&&b.result!==undefined);return b.result;
 };
 const view=async(method_name:string,args:unknown)=>{
  const r=await read('query',{request_type:'call_function',account_id:p.registry,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64'),block_id:e.snapshot.hash});
  assert.equal(r.block_hash,e.snapshot.hash);assert.equal(r.block_height,e.snapshot.height);assert.ok(Array.isArray(r.result)&&r.result.length<=1048576);return JSON.parse(Buffer.from(r.result).toString('utf8'));
 };
 const cfg=z.object({record_count:Count.max(1024)}).parse(await view('get_config',{}));
 const records:PrivacyDataset['records']=[];
 for(let from=0;from<cfg.record_count;from+=50){const n=Math.min(50,cfg.record_count-from),page=z.array(z.unknown()).length(n).parse(await view('get_records',{from_index:from,limit:n}));
  for(let i=0;i<page.length;i++){const record=sharedRecord(page[i],undefined,p.denomination);assert.equal(record.index,from+i);records.push({record,transaction:null,traffic:'unclassified'});}
 }
 const blocks=new Map<string,any>();
 for(const expected of e.transactions.filter((t:any)=>['deposit-0','deposit-1','withdraw-cross-vault','withdraw-to-missing-account','retry-original-withdrawal'].includes(t.label))){
  const raw=await read('tx',{tx_hash:expected.hash,sender_account_id:expected.signer,wait_until:'NONE'});verifyRecordedWalletTransaction(raw,expected);
  for(const receipt of raw.receipts_outcome){
   const outcome=receipt.outcome;if(outcome.executor_id!==p.registry||!outcome.status||(!Object.hasOwn(outcome.status,'SuccessValue')&&!Object.hasOwn(outcome.status,'SuccessReceiptId')))continue;
   for(const log of outcome.logs??[]){if(!log.startsWith('EVENT_JSON:'))continue;const event=JSON.parse(log.slice(11));if(event.standard!=='core_shared'||event.version!=='2.0.0')continue;
    assert.ok(Array.isArray(event.data));
    for(const value of event.data){const record=sharedRecord(value,undefined,p.denomination);assert.equal(event.event,record.kind);const row=records[record.index];assert.ok(row);assert.equal(recordFingerprint(row.record),recordFingerprint(record),'Receipt differs from immutable journal');
     if(!blocks.has(receipt.block_hash)){const b=await read('block',{block_id:receipt.block_hash});assert.equal(b.header.hash,receipt.block_hash);const canonical=await read('block',{block_id:b.header.height});assert.equal(canonical.header.hash,receipt.block_hash);blocks.set(receipt.block_hash,b.header);}
     const header=blocks.get(receipt.block_hash);assert.equal(header.height,record.block_height);assert.equal(header.timestamp_nanosec,record.timestamp_ns);assert.ok(header.height<=e.snapshot.height);
     if(row.transaction)assert.equal(row.transaction.hash,expected.hash);row.transaction={hash:expected.hash,signer:expected.signer};
    }
   }
  }
 }
 assert.ok(records.length>0&&records.every(r=>r.transaction),'Every record must be anchored in verified FINAL receipts');
 // The operator of this recorded fixture declares control of its payer; this is not on-chain identity verification.
 const dataset=PrivacyObservations.parse({format:'core-privacy-observations-v1',policy:p,snapshot:e.snapshot,totalRecordCount:cfg.record_count,records,controllers:[{account:e.accounts.payer,controller:'native-qualification-operator',basis:'operator-declaration'}],fundingEdges:[],windowsSeconds:[60,300,3600,86400]});
 return {dataset,verification:{...verification,journalRecords:records.length,everyJournalRecordReceiptAnchored:true,recordTimestampsCanonical:true,upstreamFundingCollected:false}};
}
