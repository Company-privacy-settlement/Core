import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../sdk/client/crypto.js';
import { RecordSchema } from '../../sdk/evidence.js';
import { sharedRecord, IndexTxRef, FinalBlockSchema } from '../../sdk/indexer/types.js';
import { SharedPolicySchema } from '../../sdk/shared.js';
import { AccountId, Atomic, Count } from '../../sdk/validation.js';

const Timestamp = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<1n<<64n);
export const PrivacyObservations = z.object({
  format:z.literal('core-privacy-observations-v1'), policy:SharedPolicySchema,
  snapshot:FinalBlockSchema, totalRecordCount:Count.max(8192),
  records:z.array(z.object({record:RecordSchema.strict(),transaction:IndexTxRef.nullable(),traffic:z.enum(['unclassified','declared-synthetic']).default('unclassified')}).strict()).max(8192),
  controllers:z.array(z.object({account:AccountId,controller:z.string().min(1).max(80),basis:z.literal('operator-declaration')}).strict()).max(1024).default([]),
  fundingEdges:z.array(z.object({transaction:IndexTxRef,from:AccountId,to:AccountId,amount:Atomic.refine(v=>BigInt(v)>0n),assetTokenId:AccountId.nullable(),blockHeight:Count,timestampNs:Timestamp}).strict()).max(8192).default([]),
  windowsSeconds:z.array(z.number().int().min(1).max(604800)).min(1).max(8).default([60,300,3600,86400]),
}).strict();
export type PrivacyInput=z.input<typeof PrivacyObservations>;
export type PrivacyDataset=z.output<typeof PrivacyObservations>;
function check(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
const round=(n:number)=>Number(n.toFixed(12));
const ratio=(n:number,d:number)=>d?round(n/d):null;
function concentration(weights:Map<string,bigint>){
  const total=[...weights.values()].reduce((a,b)=>a+b,0n);
  if(total===0n)return null;
  const sources=[...weights].sort(([a],[b])=>a.localeCompare(b)).map(([source,amount])=>({source,amountAtomic:amount.toString(),share:round(Number(amount)/Number(total))}));
  // Floating metrics describe source distribution; all money remains exact integer strings.
  const shares=[...weights.values()].map(n=>Number(n)/Number(total)),hhi=shares.reduce((a,p)=>a+p*p,0);
  return {totalAtomic:total.toString(),sourceCount:sources.length,sources,hhi:round(hhi),largestShare:round(Math.max(...shares)),inverseHhiSourceDiversity:round(1/hhi),entropyBits:round(-shares.reduce((a,p)=>a+p*Math.log2(p),0))};
}
function add(m:Map<string,bigint>,key:string,n:bigint){m.set(key,(m.get(key)??0n)+n);}
export function measurePrivacy(input:PrivacyInput){
  const d=PrivacyObservations.parse(input),p=d.policy,rows=[...d.records].sort((a,b)=>a.record.index-b.record.index),windows=[...d.windowsSeconds].sort((a,b)=>a-b);
  check(new Set(windows).size===windows.length,'Duplicate time window');
  check(new Set(d.controllers.map(x=>x.account)).size===d.controllers.length,'Conflicting controller declarations');
  const controllers=new Map(d.controllers.map(x=>[x.account,x.controller]));
  const indices=new Set<number>(),commitments=new Set<string>(),spent=new Set<string>(),requests=new Map<string,typeof rows[number]>();
  const lastLifecycle=new Map<string,string>();
  let previousIndex=-1,previousHeight=0,previousTime=0n,orphanLifecycle=0;
  for(const row of rows){
    const r=sharedRecord(row.record,p.tokenId,p.denomination),time=BigInt(Timestamp.parse(r.timestamp_ns));
    check(!indices.has(r.index)&&r.index<d.totalRecordCount,'Duplicate or out-of-range record');indices.add(r.index);
    check(r.block_height<=d.snapshot.height&&r.block_height>=previousHeight&&time>=previousTime,'Snapshot/order mismatch');
    if(previousIndex>=0)check(r.index>previousIndex,'Record index order');previousIndex=r.index;previousHeight=r.block_height;previousTime=time;
    if(r.kind==='deposit'||r.kind==='transfer'){
      check(r.commitment!==null&&!commitments.has(r.commitment),'Duplicate output commitment');commitments.add(r.commitment);
    }
    if(r.kind==='transfer'||r.kind==='withdrawal_requested'){
      check(r.nullifier!==null&&!spent.has(r.nullifier),'Duplicate spend request');spent.add(r.nullifier);
    }
    if(r.kind==='withdrawal_requested'){requests.set(r.nullifier!,row);lastLifecycle.set(r.nullifier!,'withdrawal_requested');}
    if(['withdrawal_retried','withdrawal_failed','withdrawal_succeeded'].includes(r.kind)){
      const request=requests.get(r.nullifier!);if(!request)orphanLifecycle++;
      if(request){const q=request.record;check(q.vault===r.vault&&q.recipient===r.recipient&&q.disclosure_root===r.disclosure_root,'Recovery changed the original binding');check(lastLifecycle.get(r.nullifier!)!=='withdrawal_succeeded','Finalized withdrawal reopened');}
      lastLifecycle.set(r.nullifier!,r.kind);
    }
  }
  const deposits=rows.filter(x=>x.record.kind==='deposit'),outputs=rows.filter(x=>['deposit','transfer'].includes(x.record.kind));
  const depositSigners=[...new Set(deposits.flatMap(x=>x.transaction?[x.transaction.signer]:[]))].sort();
  const requestRows=[...requests.values()];
  const withdrawalSigners=[...new Set(requestRows.flatMap(x=>x.transaction?[x.transaction.signer]:[]))].sort();
  const direct=new Map<string,bigint>(),declared=new Map<string,bigint>();let unknownFunding=0n,unmappedDeclared=0n;
  for(const row of deposits){const n=BigInt(row.record.amount!),signer=row.transaction?.signer;if(signer){add(direct,signer,n);const controller=controllers.get(signer);if(controller)add(declared,controller,n);else unmappedDeclared+=n;}else unknownFunding+=n;}
  const seenEdges=new Set<string>(),upstream=new Map<string,bigint>(),funded=new Map<string,Set<string>>();let ignoredEdges=0;
  for(const edge of d.fundingEdges){
    check(edge.assetTokenId===(p.tokenId??null),'Mixed funding assets');check(edge.transaction.signer===edge.from,'Funding signer differs from stated source');
    check(edge.blockHeight<=d.snapshot.height,'Funding edge after snapshot');
    const id=edge.transaction.hash+':'+edge.from+':'+edge.to;check(!seenEdges.has(id),'Duplicate funding edge');seenEdges.add(id);
    const later=deposits.some(x=>x.transaction?.signer===edge.to&&x.record.block_height>=edge.blockHeight&&BigInt(x.record.timestamp_ns)>=BigInt(edge.timestampNs));
    if(!later){ignoredEdges++;continue;}add(upstream,edge.from,BigInt(edge.amount));
    const set=funded.get(edge.from)??new Set<string>();set.add(edge.to);funded.set(edge.from,set);
  }
  const links=requestRows.map(row=>{
    const r=row.record,time=BigInt(r.timestamp_ns);
    // Spent outputs are not removed: public nullifiers do not identify their input commitments.
    const candidates=outputs.filter(x=>x.record.index<r.index&&x.record.block_height<=r.block_height&&BigInt(x.record.timestamp_ns)<=time&&x.record.amount===r.amount);
    const nonsynthetic=candidates.filter(x=>x.traffic!=='declared-synthetic');
    const signer=row.transaction?.signer;
    const same=candidates.filter(x=>!!signer&&x.transaction?.signer===signer);
    const byWindow=windows.map(seconds=>{
      const within=(x:typeof rows[number])=>time-BigInt(x.record.timestamp_ns)<=BigInt(seconds)*1000000000n;
      return {seconds,amountTimeCandidates:candidates.filter(within).length,excludingDeclaredSynthetic:nonsynthetic.filter(within).length,samePublicSignerCandidates:signer?same.filter(within).length:null};
    });
    const lags=candidates.map(x=>time-BigInt(x.record.timestamp_ns)),nearest=lags.length?lags.reduce((a,b)=>a<b?a:b):null;
    return {recordIndex:r.index,nullifier:r.nullifier,transaction:row.transaction,
      lifecycle:lastLifecycle.get(r.nullifier!)!,candidateOutputCount:candidates.length,depositCandidates:candidates.filter(x=>x.record.kind==='deposit').length,
      internalTransferCandidates:candidates.filter(x=>x.record.kind==='transfer').length,excludingDeclaredSynthetic:nonsynthetic.length,
      samePublicSignerCandidates:signer?same.length:null,nearestPriorLagNs:nearest?.toString()??null,nearestPriorTies:nearest===null?0:lags.filter(n=>n===nearest).length,windows:byWindow};
  });
  const windowSummary=windows.map(seconds=>{const counts=links.map(x=>x.windows.find(w=>w.seconds===seconds)!.amountTimeCandidates);return{seconds,requests:counts.length,zeroCandidates:counts.filter(n=>n===0).length,singletonCandidates:counts.filter(n=>n===1).length,multipleCandidates:counts.filter(n=>n>1).length,singletonShare:ratio(counts.filter(n=>n===1).length,counts.length)};});
  const knownDirect=concentration(direct),complete=rows.length===d.totalRecordCount&&rows.every((x,i)=>x.record.index===i);
  check(!complete||orphanLifecycle===0,'Complete journal has a lifecycle record before its original request');
  return {format:'core-privacy-baseline-v1',policy:p,snapshot:d.snapshot,inputSha256:createHash('sha256').update(canonical(d)).digest('hex'),
    coverage:{providedRecords:rows.length,totalRecordCount:d.totalRecordCount,contiguousFromGenesis:complete,missingTransactionAttributions:rows.filter(x=>!x.transaction).length,orphanLifecycleRecords:orphanLifecycle},
    participation:{observedDepositSigners:depositSigners,observedDepositSignerCount:depositSigners.length,observedWithdrawalSigners:withdrawalSigners,observedWithdrawalSignerCount:withdrawalSigners.length,
      independentPeopleVerified:null,verifiedBusinessParticipants:null,declaredControllerCount:deposits.length&&unknownFunding===0n&&unmappedDeclared===0n?declared.size:null,
      controllerAssurance:'Operator declarations only; common funders, keys or addresses do not establish independent people.',
      declaredSyntheticOutputs:outputs.filter(x=>x.traffic==='declared-synthetic').length,unclassifiedOutputs:outputs.filter(x=>x.traffic==='unclassified').length},
    funding:{directDepositSigner:{known:knownDirect,unknownAmountAtomic:unknownFunding.toString(),allDepositFundingAttributed:unknownFunding===0n&&deposits.length>0},
      declaredController:{known:concentration(declared),unmappedAmountAtomic:(unknownFunding+unmappedDeclared).toString()},
      observedUpstream:{known:concentration(upstream),providedEdges:d.fundingEdges.length,ignoredUnrelatedOrLaterEdges:ignoredEdges,sharedFundingSources:[...funded].filter(([,set])=>set.size>1).map(([source,set])=>({source,depositSigners:[...set].sort()})),completeFundingHistoryVerified:false}},
    linkability:{amountScope:'One registry, network, token and fixed denomination; amounts are public, never pooled across proof domains.',requests:links,windowSummary,
      interpretation:'Candidate counts and same-signer/nearest-time heuristics are associations within the supplied observation set, not proven input-note links or posterior probabilities. Zero candidates in a window does not prove privacy. Prior spent outputs remain candidates; internal transfers are counted without assigning their original funder.'},
    claims:{effectiveAnonymityEstablished:false,independentIdentitiesVerified:false,completeFundingHistory:false,chainReverifiedByAnalyzer:false},
    limits:['Address and controller counts are not customer/person counts.','Declared synthetic traffic is not verified independent participation.','Source HHI and inverse HHI describe funding concentration, not an effective anonymity set.','Missing history or transaction attribution can hide correlations.','RPC/source authenticity must be checked independently of file integrity.']};
}
