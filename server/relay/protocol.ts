import {z} from 'zod';
import {groth16} from 'snarkjs';
import {canonical} from '../../sdk/client/crypto.js';
import {decodeBrowserProof} from '../../sdk/client/prover.js';
import {contextHash,domain,encodeVerificationKey,field,quoteFees,sha256,STORAGE_FEE,type Pool} from '../../sdk/core.js';
import {quoteFtFees,type ContractCall} from '../../sdk/ft.js';
import {SharedPolicySchema,type SharedPolicy} from '../../sdk/shared.js';
import {AccountId,Atomic,Sha256} from '../../sdk/validation.js';
const Scalar=z.string().max(77).refine(v=>{try{return field(v).toString()===v;}catch{return false;}});
export const RelayRequest=z.object({format:z.literal('core-relay-withdrawal-v1'),policyHash:Sha256,vault:AccountId,recipient:AccountId,disclosureRoot:Sha256,
 spend:z.object({proof:z.string().length(344).refine(v=>Buffer.from(v,'base64').length===256&&Buffer.from(v,'base64').toString('base64')===v),public_inputs:z.array(Scalar).length(5)}).strict()}).strict();
export type RelayWithdrawal=z.infer<typeof RelayRequest>;
export const RelayLimits=z.object({maxExecutions:z.number().int().min(1).max(10000),maxNearYoctoNear:Atomic,maxTokenAtomic:Atomic,maxGasPriceYoctoNear:Atomic.refine(v=>BigInt(v)>0n),maxRetries:z.number().int().min(0).max(5).default(2)}).strict();
export type Limits=z.input<typeof RelayLimits>;
export function relayPolicyHash(policy:SharedPolicy){return sha256(canonical(SharedPolicySchema.parse(policy)));}
export function relayPool(policy:SharedPolicy):Pool{return policy.tokenId?{network:policy.network,contract:policy.registry,denomination:policy.denomination,version:3,tokenId:policy.tokenId}:{network:policy.network,contract:policy.registry,denomination:policy.denomination,version:2};}
export function parseRelayRequest(policy:SharedPolicy,value:unknown){
 const r=RelayRequest.parse(value),pool=relayPool(policy);
 if(r.policyHash!==relayPolicyHash(policy)||r.spend.public_inputs[4]!==domain(pool)||r.spend.public_inputs[3]!==contextHash(pool,{kind:'withdraw',vault:r.vault,target:r.recipient,disclosureRoot:r.disclosureRoot}))throw Error('RELAY_BINDING_MISMATCH');
 if(r.recipient===policy.registry||r.recipient.endsWith('.'+policy.registry))throw Error('RELAY_RECIPIENT_INVALID');
 return r;
}
export function relayRequestId(request:RelayWithdrawal){return sha256(canonical(request));}
export function relayCall(policy:SharedPolicy,request:RelayWithdrawal,retry=false):ContractCall{
 const r=parseRelayRequest(policy,request),args={vault:r.vault,recipient:r.recipient,disclosure_root:r.disclosureRoot,...r.spend};
 if(retry)return{contract:policy.registry,method:'retry_withdrawal',args:{nullifier:r.spend.public_inputs[0]},attachedYoctoNear:STORAGE_FEE.toString(),gas:'300000000000000'};
 if(policy.tokenId)return{contract:policy.tokenId,method:'ft_transfer_call',args:{receiver_id:policy.registry,amount:quoteFtFees(policy.denomination).withdrawalFeeTransferTokens,msg:JSON.stringify(args)},attachedYoctoNear:'1',gas:'300000000000000'};
 return{contract:policy.registry,method:'withdraw',args,attachedYoctoNear:quoteFees(policy.denomination).withdrawalAttached,gas:'300000000000000'};
}
export function pinnedRelayVerifier(policy:SharedPolicy,key:unknown){
 const vk=JSON.parse(JSON.stringify(key));if(sha256(Buffer.from(encodeVerificationKey(vk),'base64'))!==policy.verifierSha256)throw Error('RELAY_VERIFIER_MISMATCH');
 return async(request:RelayWithdrawal)=>{const r=parseRelayRequest(policy,request);if(!await groth16.verify(vk,r.spend.public_inputs,decodeBrowserProof(r.spend)))throw Error('RELAY_INVALID_PROOF');};
}
/** Restrict the sponsor key to the exact fixed-policy calls, even if an internal caller is faulty. */
export function validateRelayCall(policy:SharedPolicy,call:ContractCall){
 if(call.method==='retry_withdrawal'){
  if(call.contract!==policy.registry||call.attachedYoctoNear!==STORAGE_FEE.toString()||call.gas!=='300000000000000')throw Error('RELAY_CALL_NOT_ALLOWED');
  z.object({nullifier:Scalar}).strict().parse(call.args);return;
 }
 let args:any=call.args;
 if(policy.tokenId){
  if(call.contract!==policy.tokenId||call.method!=='ft_transfer_call')throw Error('RELAY_CALL_NOT_ALLOWED');
  const outer=z.object({receiver_id:z.literal(policy.registry),amount:z.literal(quoteFtFees(policy.denomination).withdrawalFeeTransferTokens),msg:z.string().max(4096)}).strict().parse(args);args=JSON.parse(outer.msg);
 }else if(call.contract!==policy.registry||call.method!=='withdraw')throw Error('RELAY_CALL_NOT_ALLOWED');
 const raw=z.object({vault:AccountId,recipient:AccountId,disclosure_root:Sha256,proof:RelayRequest.shape.spend.shape.proof,public_inputs:RelayRequest.shape.spend.shape.public_inputs}).strict().parse(args);
 const r=parseRelayRequest(policy,{format:'core-relay-withdrawal-v1',policyHash:relayPolicyHash(policy),vault:raw.vault,recipient:raw.recipient,disclosureRoot:raw.disclosure_root,spend:{proof:raw.proof,public_inputs:raw.public_inputs}});
 if(canonical(relayCall(policy,r))!==canonical(call))throw Error('RELAY_CALL_NOT_ALLOWED');
}
