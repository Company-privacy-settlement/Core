import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {indexFixture} from './fixtures/indexer.js';
import {measurePrivacy,type PrivacyInput} from '../scripts/lib/privacy-baseline.js';
const h=(s:string)=>bs58.encode(createHash('sha256').update(s).digest());
function fixture(){
 const f=indexFixture(true),d:PrivacyInput={format:'core-privacy-observations-v1',policy:f.policy,snapshot:{height:10000,hash:h('snapshot')},totalRecordCount:0,records:[],windowsSeconds:[60,300],controllers:[],fundingEdges:[]};
 function add(kind:string,seconds:number,signer:string|null='payer.test.near',changes:Record<string,unknown>={}){
  const i=d.records.length,fee=(BigInt(f.policy.denomination)*15n/10000n).toString();
  const row={record:f.record(i,{kind,block_height:seconds+1,timestamp_ns:String(BigInt(seconds)*1000000000n),commitment:['deposit','transfer'].includes(kind)?String(i+1):null,nullifier:kind==='deposit'?null:String(i+1000),vault:kind==='transfer'?null:f.vault,recipient:['deposit','transfer'].includes(kind)?null:'recipient.test.near',protocol_fee_charged:['deposit','withdrawal_requested'].includes(kind)?fee:'0',protocol_fee_earned:['deposit','withdrawal_succeeded'].includes(kind)?fee:'0',storage_fee_charged:['deposit','transfer','withdrawal_requested','withdrawal_retried'].includes(kind)?'20000000000000000000000':'0',...changes}),transaction:signer?{hash:h('tx'+i),signer}:null,traffic:'unclassified' as 'unclassified'|'declared-synthetic'};
  d.records.push(row);d.totalRecordCount=d.records.length;return row;
 }
 return{d,add,run:()=>measurePrivacy(d)};
}
test('empty data reports null identities, concentration and rates without an anonymity claim',()=>{
 const r=fixture().run();assert.equal(r.participation.independentPeopleVerified,null);assert.equal(r.funding.directDepositSigner.known,null);assert.equal(r.linkability.windowSummary[0].singletonShare,null);assert.ok(Object.values(r.claims).every(v=>v===false));
});
test('two vaults funded by one payer give one signer and 100% concentration, not two users',()=>{
 const f=fixture();f.add('deposit',10);f.add('deposit',20,undefined,{vault:'other-vault.test.near'});f.add('withdrawal_requested',30);const r=f.run();assert.equal(r.participation.observedDepositSignerCount,1);assert.equal(r.participation.independentPeopleVerified,null);assert.equal(r.funding.directDepositSigner.known!.hhi,1);assert.equal(r.funding.directDepositSigner.known!.largestShare,1);assert.equal(r.linkability.requests[0].candidateOutputCount,2);assert.equal(r.linkability.requests[0].samePublicSignerCandidates,2);
});
test('equal sources give HHI .5; declared common control collapses groups but cannot verify people',()=>{
 const f=fixture();f.add('deposit',10,'alice.test.near');f.add('deposit',20,'bob.test.near');f.d.controllers=[{account:'alice.test.near',controller:'one-operator',basis:'operator-declaration'},{account:'bob.test.near',controller:'one-operator',basis:'operator-declaration'}];const r=f.run();assert.equal(r.funding.directDepositSigner.known!.hhi,.5);assert.equal(r.funding.directDepositSigner.known!.inverseHhiSourceDiversity,2);assert.equal(r.funding.directDepositSigner.known!.entropyBits,1);assert.equal(r.participation.declaredControllerCount,1);assert.equal(r.funding.declaredController.known!.hhi,1);assert.equal(r.participation.independentPeopleVerified,null);f.d.controllers.pop();assert.equal(f.run().participation.declaredControllerCount,null);
});
test('missing attribution remains explicit instead of turning unknown funders into independent users',()=>{
 const f=fixture();f.add('deposit',10,null);f.add('withdrawal_requested',20,null);const r=f.run();assert.equal(r.coverage.missingTransactionAttributions,2);assert.equal(r.funding.directDepositSigner.allDepositFundingAttributed,false);assert.equal(r.funding.directDepositSigner.unknownAmountAtomic,f.d.policy.denomination);assert.equal(r.linkability.requests[0].samePublicSignerCandidates,null);assert.equal(r.linkability.requests[0].windows[0].samePublicSignerCandidates,null);
});
test('time windows include their boundary, exclude future deposits and preserve nearest-time ties',()=>{
 const f=fixture();f.add('deposit',10,'alice.test.near');f.add('deposit',70);f.add('deposit',70);f.add('withdrawal_requested',130);f.add('deposit',140);const r=f.run(),q=r.linkability.requests[0];assert.equal(q.candidateOutputCount,3);assert.equal(q.windows[0].amountTimeCandidates,2);assert.equal(q.windows[1].amountTimeCandidates,3);assert.equal(q.nearestPriorTies,2);assert.equal(q.nearestPriorLagNs,'60000000000');assert.equal(r.linkability.windowSummary[0].multipleCandidates,1);
});
test('internal transfers remain candidates and spending does not reveal which prior output to remove',()=>{
 const f=fixture();f.add('deposit',10);f.add('withdrawal_requested',20);f.add('transfer',30,'relay.test.near');f.add('withdrawal_requested',40);const r=f.run();assert.equal(r.linkability.requests.length,2);assert.equal(r.linkability.requests[1].candidateOutputCount,2);assert.equal(r.linkability.requests[1].internalTransferCandidates,1);assert.equal(r.funding.directDepositSigner.known!.totalAtomic,f.d.policy.denomination);
});
test('failure, retry and completion are one original request with immutable payout bindings',()=>{
 const f=fixture();f.add('deposit',10);const q=f.add('withdrawal_requested',20);for(const [i,kind]of ['withdrawal_failed','withdrawal_retried','withdrawal_succeeded'].entries())f.add(kind,30+i,undefined,{nullifier:q.record.nullifier,disclosure_root:q.record.disclosure_root});const r=f.run();assert.equal(r.linkability.requests.length,1);assert.equal(r.linkability.requests[0].lifecycle,'withdrawal_succeeded');f.d.records[3].record.recipient='other.test.near';assert.throws(f.run,/binding/);
});
test('declared synthetic traffic is labelled and separately excluded without verifying business participants',()=>{
 const f=fixture();f.add('deposit',10,'cover.test.near').traffic='declared-synthetic';f.add('deposit',20);f.add('withdrawal_requested',30);const r=f.run();assert.equal(r.participation.declaredSyntheticOutputs,1);assert.equal(r.linkability.requests[0].candidateOutputCount,2);assert.equal(r.linkability.requests[0].excludingDeclaredSynthetic,1);assert.equal(r.participation.verifiedBusinessParticipants,null);
});
test('shared upstream faucet is a concentration signal rather than proof of common control',()=>{
 const f=fixture();f.add('deposit',10,'alice.test.near');f.add('deposit',20,'bob.test.near');f.d.fundingEdges=['alice.test.near','bob.test.near'].map((to,i)=>({transaction:{hash:h('fund'+i),signer:'faucet.test.near'},from:'faucet.test.near',to,amount:'100',assetTokenId:null,blockHeight:1,timestampNs:'0'}));const r=f.run();assert.equal(r.funding.observedUpstream.known!.hhi,1);assert.equal(r.funding.observedUpstream.sharedFundingSources[0].depositSigners.length,2);assert.equal(r.participation.declaredControllerCount,null);assert.equal(r.funding.observedUpstream.completeFundingHistoryVerified,false);f.d.fundingEdges.push(f.d.fundingEdges[0]);assert.throws(f.run,/Duplicate funding/);
});
test('funding rejects cross-asset/snapshot edges and ignores funding that occurs after deposits',()=>{
 const f=fixture();f.add('deposit',10);const edge={transaction:{hash:h('fund'),signer:'funder.test.near'},from:'funder.test.near',to:'payer.test.near',amount:'100',assetTokenId:null as string|null,blockHeight:12,timestampNs:'11000000000'};f.d.fundingEdges=[edge];assert.equal(f.run().funding.observedUpstream.ignoredUnrelatedOrLaterEdges,1);edge.blockHeight=10001;assert.throws(f.run,/snapshot/);edge.blockHeight=1;edge.assetTokenId='other.test.near';assert.throws(f.run,/assets/);
});
test('partial history exposes a lower candidate count without claiming full coverage or anonymity',()=>{
 const f=fixture();f.add('deposit',10);f.add('deposit',20);f.add('withdrawal_requested',30);f.d.records.splice(1,1);const r=f.run();assert.equal(r.coverage.contiguousFromGenesis,false);assert.equal(r.linkability.requests[0].candidateOutputCount,1);assert.equal(r.claims.effectiveAnonymityEstablished,false);
});
test('malformed, duplicate and cross-domain data fail closed',()=>{
 const mutations=[(f:ReturnType<typeof fixture>)=>{f.d.records[1].record.commitment=f.d.records[0].record.commitment;},(f:ReturnType<typeof fixture>)=>{f.d.records.push(f.d.records[0]);},(f:ReturnType<typeof fixture>)=>{f.d.records[0].record.asset_token_id='other.test.near';},(f:ReturnType<typeof fixture>)=>{f.d.records[0].record.amount='1';},(f:ReturnType<typeof fixture>)=>{f.d.records[0].record.timestamp_ns='18446744073709551616';},(f:ReturnType<typeof fixture>)=>{f.d.records[1].record.timestamp_ns='0';},(f:ReturnType<typeof fixture>)=>{f.d.records[1].record.block_height=10001;},(f:ReturnType<typeof fixture>)=>{f.d.windowsSeconds=[60,60];},(f:ReturnType<typeof fixture>)=>{(f.d as any).noteSecret='rejected';}];for(const change of mutations){const f=fixture();f.add('deposit',10);f.add('deposit',20);change(f);assert.throws(f.run);}
 const dup=fixture();dup.add('deposit',10);const q=dup.add('withdrawal_requested',20);dup.add('withdrawal_requested',30,undefined,{nullifier:q.record.nullifier});assert.throws(dup.run,/Duplicate spend/);
});
test('complete journals reject orphan lifecycle events while partial extracts disclose them',()=>{
 const f=fixture();f.add('withdrawal_succeeded',10);assert.throws(f.run,/original request/);f.d.totalRecordCount=10;f.d.records[0].record.index=5;const r=f.run();assert.equal(r.coverage.orphanLifecycleRecords,1);assert.equal(r.coverage.contiguousFromGenesis,false);
});

test('large atomic totals remain exact beyond JavaScript safe integers',()=>{
 const f=fixture();f.add('deposit',10,'alice.test.near');f.add('deposit',20,'bob.test.near');const r=f.run();assert.equal(r.funding.directDepositSigner.known!.totalAtomic,(2n*BigInt(f.d.policy.denomination)).toString());assert.equal(r.funding.directDepositSigner.known!.hhi,.5);
});
test('singleton and zero-window cases are reported separately, not inverted into anonymity guarantees',()=>{
 const f=fixture();f.add('deposit',10);f.add('withdrawal_requested',20);f.add('withdrawal_requested',400);const r=f.run();assert.equal(r.linkability.windowSummary[0].singletonCandidates,1);assert.equal(r.linkability.windowSummary[0].zeroCandidates,1);assert.equal(r.linkability.windowSummary[0].singletonShare,.5);assert.equal(r.claims.effectiveAnonymityEstablished,false);
});
