import {canonical} from '../../sdk/client/crypto.js';
import {preflightFt,observeSettlement,type OperationsSource} from '../../sdk/operations.js';
import {discoverSharedVaults,loadSharedTree,type SharedPolicy,type SharedChainSource} from '../../sdk/shared.js';
import {quoteFtFees,type ContractCall} from '../../sdk/ft.js';
import {parseRelayRequest,relayRequestId,relayCall,type RelayWithdrawal} from './protocol.js';
import{RelayStore,type Execution,type Prepared}from'./store.js';
import {randomInt} from 'node:crypto';
import {Timing, hasHistoricalRoot, schedulingConfig, safeRelayError, type TimingChoice} from './scheduling.js';
export interface RelaySigner{accountId:string;publicKey:string;fresh():Promise<void>;prepare(call:ContractCall):Promise<Prepared>;submit(prepared:Prepared,call:ContractCall):Promise<boolean>;reconcile(prepared:Prepared,call:ContractCall):Promise<boolean>;}
export class ProofRelay{
 private draining=false;
 constructor(readonly policy:SharedPolicy,readonly source:OperationsSource,readonly signer:RelaySigner,readonly store:RelayStore,private verify:(r:RelayWithdrawal)=>Promise<void>,private now:()=>number=Date.now){}
 private reference(r:RelayWithdrawal){return{kind:'withdrawal' as const,nullifier:r.spend.public_inputs[0],expectedVault:r.vault,expectedRecipient:r.recipient,expectedDisclosureRoot:r.disclosureRoot};}
 async status(id:string){const r=this.store.request(id);if(!r)throw Error('RELAY_NOT_FOUND');parseRelayRequest(this.policy,r);const schedule=this.store.schedule(id,this.now()),settlement=await observeSettlement(this.source,this.policy,this.reference(r));return{id,principal:this.policy.denomination,assetTokenId:this.policy.tokenId??null,schedule,waitingForReconciliation:!!schedule&&schedule.state==='waiting'&&this.store.unresolved(),executions:this.store.executions(id).map(({call,prepared,...e})=>({...e,transactionHash:prepared?.hash??null})),settlement};}
 async submit(raw:unknown){
  const r=parseRelayRequest(this.policy,raw),id=relayRequestId(r),known=this.store.existing(r);if(known)return this.status(known);
  await this.preflight(r);
  const started=this.start(r);if(started.created)await this.dispatch(started.execution);return this.status(id);
 }
 private async preflight(r:RelayWithdrawal){
  await this.verify(r);await this.signer.fresh();
  const block=await this.source.finalBlock(),source:SharedChainSource={network:this.source.network,factory:this.source.factory,finalizedBlock:async()=>block.hash,config:b=>this.source.config(b),records:(f,l,b)=>this.source.records(f,l,b),vaultConfig:(a,b)=>this.source.vaultConfig(a,b),codeSha256:(a,b)=>this.source.codeSha256(a,b),accessKeys:(a,b)=>this.source.accessKeys(a,b),commitments:b=>this.source.commitments(b)};
  const member:any=await this.source.contractView(this.policy.registry,'get_vault',{account_id:r.vault},block.hash);if(!member||!Number.isSafeInteger(member.index))throw Error('RELAY_VAULT_INVALID');
  const catalog=await discoverSharedVaults(source,this.policy,{fromIndex:member.index,maxRecords:1});if(!catalog.vaults.some(v=>v.accountId===r.vault&&v.canWithdraw))throw Error('RELAY_NO_LIQUIDITY');
  if(await this.source.contractView(this.policy.registry,'is_spent',{nullifier:r.spend.public_inputs[0]},block.hash)!==false)throw Error('RELAY_ALREADY_SPENT');
  const tree=await loadSharedTree(source,catalog);if(!await hasHistoricalRoot(tree,r.spend.public_inputs[2]))throw Error('RELAY_REFRESH_PROOF_ROOT');
  if(this.policy.tokenId){const ready=await preflightFt(this.source,this.policy,{operation:'withdraw',payer:this.signer.accountId,vault:r.vault,recipient:r.recipient});if(!ready.prerequisitesSatisfied)throw Error('RELAY_PREPROVISION_REQUIRED');}
 }
 private start(r:RelayWithdrawal,scheduled?:{revision:number;now:number}){
  return this.store.begin(r,0,relayCall(this.policy,r),this.policy.tokenId?quoteFtFees(this.policy.denomination).withdrawalFeeTransferTokens:'0',scheduled);
 }
 async enqueue(raw:unknown,timing:TimingChoice,controlToken:string){
  const r=parseRelayRequest(this.policy,raw);Timing.parse(timing);
  if(!this.store.existing(r))await this.preflight(r);
  this.store.enqueue(r,timing,controlToken,this.now());return this.status(relayRequestId(r));
 }
 async scheduleControl(id:string,token:string,revision:number,action:'cancel'|'resume'|'reschedule',timing?:TimingChoice){
  this.store.control(id,token,revision,action,this.now(),timing);return this.status(id);
 }
 // A bounded delivery batch consists of separate immutable transactions. It never
 // merges principals, waits for more users, or retries an ambiguous signature.
 async drain(){
  if(this.draining)return {started:[],busy:true};this.draining=true;const started:string[]=[];
  try{
   const ready=this.store.ready(this.now());
   for(let i=ready.length-1;i>0;i--){const j=randomInt(i+1);[ready[i],ready[j]]=[ready[j],ready[i]];}
   for(const s of ready.slice(0,schedulingConfig.maxBatchSize)){
    if(this.store.unresolved())break;
    try{
     const r=parseRelayRequest(this.policy,this.store.request(s.requestId));await this.preflight(r);
     const e=this.start(r,{revision:s.revision,now:this.now()});
     if(e.created){started.push(s.requestId);await this.dispatch(e.execution);}
    }catch(error){if(safeRelayError(error)!=='RELAY_SIGNER_BUSY_OR_UNRESOLVED')this.store.block(s.requestId,safeRelayError(error),this.now(),s.revision);}
   }
   return {started,busy:this.store.unresolved()};
  }finally{this.draining=false;}
 }
 async retry(id:string,expectedAttempt:number){
  const r=this.store.request(id);if(!r)throw Error('RELAY_NOT_FOUND');parseRelayRequest(this.policy,r);await this.verify(r);
  if(!this.store.executions(id).some(e=>e.sequence===0))throw Error('RELAY_RETRY_NOT_AVAILABLE');
  const prior=this.store.executions(id).find(e=>e.sequence===expectedAttempt);if(prior)return this.status(id);
  const status=await this.status(id),record=status.settlement.record;
  if(!Number.isSafeInteger(expectedAttempt)||expectedAttempt<1||!status.settlement.retryAvailable||!record||record.attempt!==expectedAttempt)throw Error('RELAY_RETRY_NOT_AVAILABLE');
  await this.signer.fresh();const started=this.store.begin(r,expectedAttempt,relayCall(this.policy,r,true),'0');if(started.created)await this.dispatch(started.execution);return this.status(id);
 }
 private async dispatch(e:Execution){
  const r=this.store.request(e.requestId)!;if(canonical(relayCall(this.policy,r,e.kind==='retry'))!==canonical(e.call))throw Error('RELAY_JOURNAL_CALL_CHANGED');
  try{const prepared=await this.signer.prepare(e.call);this.store.intent(e,prepared);this.store.submitted(e);if(await this.signer.submit(prepared,e.call))this.store.final(e);else this.store.uncertain(e);}
  catch{this.store.uncertain(e);throw Error('RELAY_RECONCILIATION_REQUIRED');}
 }
 async reconcile(id:string){
  const r=this.store.request(id);if(!r)throw Error('RELAY_NOT_FOUND');parseRelayRequest(this.policy,r);
  for(const e of this.store.executions(id)){if(e.state==='final')continue;if(!e.prepared)throw Error('RELAY_PREPARATION_REQUIRES_OPERATOR_REVIEW');if(canonical(relayCall(this.policy,r,e.kind==='retry'))!==canonical(e.call))throw Error('RELAY_JOURNAL_CALL_CHANGED');if(await this.signer.reconcile(e.prepared,e.call))this.store.final(e);}
  return this.status(id);
 }
}
