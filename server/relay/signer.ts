import {KeyPair,InMemorySigner,transactions,utils} from 'near-api-js';
import bs58 from 'bs58';
import {z} from 'zod';
import {canonical} from '../../sdk/client/crypto.js';
import {sha256} from '../../sdk/core.js';
import {NearRpcOperationsSource} from '../../sdk/operations.js';
import type{SharedPolicy}from'../../sdk/shared.js';
import{AccountId,Atomic,Count}from'../../sdk/validation.js';
import type{ContractCall}from'../../sdk/ft.js';
import{validateRelayCall}from'./protocol.js';
import type{RelaySigner}from'./service.js';
import type{Prepared}from'./store.js';
function requireThat(v:unknown,error:string):asserts v{if(!v)throw Error(error);}
function decode(bytes:Buffer){const raw=transactions.Transaction.decode(bytes),data=raw.publicKey?.ed25519Key?.data;requireThat(data?.length===32,'RELAY_ED25519_REQUIRED');return transactions.createTransaction(raw.signerId,utils.PublicKey.fromString('ed25519:'+bs58.encode(data)),raw.receiverId,BigInt(raw.nonce),raw.actions,Uint8Array.from(raw.blockHash));}
export class RelayRpcSource extends NearRpcOperationsSource{read(method:string,params:unknown){return this.rpc(method,params);}}
export class NearRelaySigner implements RelaySigner{
 readonly publicKey:string;
 constructor(readonly accountId:string,private pair:KeyPair,readonly policy:SharedPolicy,readonly source:RelayRpcSource,readonly maxGasPriceYoctoNear:string){AccountId.parse(accountId);this.publicKey=pair.getPublicKey().toString();requireThat(this.publicKey.startsWith('ed25519:'),'RELAY_ED25519_REQUIRED');Atomic.parse(maxGasPriceYoctoNear);}
 async fresh(){
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('RELAY_TLS_REQUIRED');
  const status=await this.source.read('status',[]),network=this.policy.network;
  requireThat(status.sync_info?.syncing===false&&(network==='testnet'?status.chain_id==='testnet':!['mainnet','testnet'].includes(status.chain_id)),'RELAY_NETWORK_MISMATCH');
  const age=Date.now()-Date.parse(status.sync_info.latest_block_time);requireThat(Number.isFinite(age)&&age>=-30000&&age<=120000,'RELAY_STALE_RPC');
  const block=await this.source.finalBlock(),header=await this.source.read('block',{block_id:block.hash}),latest=status.sync_info.latest_block_height;
  const finalAge=Date.now()-Number(BigInt(header.header.timestamp_nanosec)/1000000n);requireThat(Number.isSafeInteger(latest)&&block.height<=latest&&latest-block.height<=10&&Number.isFinite(finalAge)&&finalAge>=-30000&&finalAge<=120000,'RELAY_STALE_FINAL_BLOCK');
  const gas=await this.source.read('gas_price',[block.hash]);requireThat(BigInt(Atomic.parse(gas.gas_price))<=BigInt(this.maxGasPriceYoctoNear),'RELAY_GAS_PRICE_LIMIT');
 }
 async prepare(call:ContractCall):Promise<Prepared>{
  validateRelayCall(this.policy,call);await this.fresh();const block=await this.source.finalBlock();
  const access=await this.source.read('query',{request_type:'view_access_key',account_id:this.accountId,public_key:this.publicKey,block_id:block.hash});requireThat(access.permission==='FullAccess'&&Number.isSafeInteger(access.nonce),'RELAY_DEDICATED_KEY_REQUIRED');
  const account=z.object({amount:Atomic,storage_usage:Count}).parse(await this.source.account(this.accountId,block.hash)),protocol=await this.source.read('EXPERIMENTAL_protocol_config',{block_id:block.hash});
  const storage=BigInt(account.storage_usage)*BigInt(Atomic.parse(protocol.runtime_config.storage_amount_per_byte)),needed=BigInt(call.attachedYoctoNear)+BigInt(call.gas)*BigInt(this.maxGasPriceYoctoNear);
  requireThat(BigInt(account.amount)>=storage+needed,'RELAY_NEAR_BUDGET_UNFUNDED');
  const tx=transactions.createTransaction(this.accountId,utils.PublicKey.fromString(this.publicKey),call.contract,BigInt(access.nonce)+1n,[transactions.functionCall(call.method,Buffer.from(JSON.stringify(call.args)),BigInt(call.gas),BigInt(call.attachedYoctoNear))],bs58.decode(block.hash));
  const bytes=Buffer.from(tx.encode());return{hash:bs58.encode(Buffer.from(sha256(bytes),'hex')),unsignedTransaction:bytes.toString('base64')};
 }
 private checked(p:Prepared,call:ContractCall){
  validateRelayCall(this.policy,call);const bytes=Buffer.from(p.unsignedTransaction,'base64');requireThat(bytes.length<=8192&&bytes.toString('base64')===p.unsignedTransaction&&bs58.encode(Buffer.from(sha256(bytes),'hex'))===p.hash,'RELAY_INTENT_HASH_MISMATCH');
  const tx=decode(bytes),expected=transactions.createTransaction(this.accountId,utils.PublicKey.fromString(this.publicKey),call.contract,tx.nonce,[transactions.functionCall(call.method,Buffer.from(JSON.stringify(call.args)),BigInt(call.gas),BigInt(call.attachedYoctoNear))],tx.blockHash);
  requireThat(Buffer.from(expected.encode()).equals(bytes),'RELAY_INTENT_CALL_MISMATCH');return tx;
 }
 private finalized(raw:any,p:Prepared,call:ContractCall){
  const expected=this.checked(p,call);if(raw?.final_execution_status!=='FINAL')return false;
  const tx=raw.transaction;requireThat(tx?.hash===p.hash&&tx.signer_id===this.accountId&&tx.receiver_id===call.contract&&tx.public_key===this.publicKey&&BigInt(tx.nonce)===expected.nonce,'RELAY_FINAL_IDENTITY_MISMATCH');
  requireThat(tx.signature?.startsWith('ed25519:')&&utils.PublicKey.fromString(this.publicKey).verify(bs58.decode(p.hash),bs58.decode(tx.signature.slice(8))),'RELAY_FINAL_SIGNATURE_MISMATCH');
  const action=tx.actions?.[0]?.FunctionCall;requireThat(tx.actions?.length===1&&action?.method_name===call.method&&String(action.gas)===call.gas&&action.deposit===call.attachedYoctoNear&&canonical(JSON.parse(Buffer.from(action.args,'base64').toString()))===canonical(call.args),'RELAY_FINAL_ACTION_MISMATCH');
  requireThat(raw.status&&(Object.hasOwn(raw.status,'SuccessValue')||Object.hasOwn(raw.status,'Failure'))&&Array.isArray(raw.receipts_outcome),'RELAY_FINAL_RECEIPTS_REQUIRED');return true;
 }
 async submit(p:Prepared,call:ContractCall){
  const tx=this.checked(p,call),signer=await InMemorySigner.fromKeyPair(this.policy.network,this.accountId,this.pair),[hash,signed]=await transactions.signTransaction(tx,signer,this.accountId,this.policy.network);requireThat(bs58.encode(hash)===p.hash,'RELAY_SIGNED_HASH_MISMATCH');
  await this.fresh();const raw=await this.source.read('send_tx',{signed_tx_base64:Buffer.from(signed.encode()).toString('base64'),wait_until:'FINAL'});return this.finalized(raw,p,call);
 }
 async reconcile(p:Prepared,call:ContractCall){const raw=await this.source.transaction(p.hash,this.accountId);return raw?this.finalized(raw,p,call):false;}
}
