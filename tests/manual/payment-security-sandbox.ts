import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Worker,type NearAccount} from 'near-workspaces';
import {createNote,proveSpend,encodeVerificationKey,sha256,quoteFees,shutdownProver} from '../../sdk/core.js';
import {discoverSharedVaults,loadSharedTree,predictSharedVault,type SharedPolicy} from '../../sdk/shared.js';
import {RelayRpcSource} from '../../server/relay/signer.js';
import {ensureSandbox} from '../../scripts/sandbox.js';

const NEAR=10n**24n,GAS=300000000000000n,STORAGE=20000000000000000000000n;
const contracts=resolve(process.env.CORE_CONTRACT_REPO??'../Contract');
const forestWasm=await readFile(resolve(contracts,'artifacts/core_forest.wasm'));
const vaultWasm=await readFile(resolve(contracts,'artifacts/core_shared_vault.wasm'));
const vk=encodeVerificationKey(JSON.parse(await readFile('artifacts/verification_key.json','utf8')));
await ensureSandbox();const worker=await Worker.init(),root=worker.rootAccount,results:any[]=[];
try{
 for(const ft of [false,true]){
  const tag=ft?'ft':'native',denomination=ft?'1000000':NEAR.toString(),principal=BigInt(denomination),fee=principal*15n/10000n;
  const forest=await root.createSubAccount(tag+'-security',{initialBalance:35n*NEAR});
  const actors=await Promise.all([0,1].map(i=>root.createSubAccount(tag+'-actor'+i,{initialBalance:30n*NEAR})));
  const receivers=await Promise.all([0,1].map(i=>root.createSubAccount(tag+'-recipient'+i,{initialBalance:NEAR})));
  const treasury=await root.createSubAccount(tag+'-treasury',{initialBalance:NEAR});
  let token:NearAccount|undefined;
  if(ft){token=await root.createSubAccount('security-token',{initialBalance:10n*NEAR});await token.deploy(await readFile(resolve(contracts,'artifacts/core_test_ft.wasm')));await token.call(token,'new',{owner_id:root.accountId,total_supply:'1000000000'},{gas:GAS});}
  await forest.deploy(forestWasm);await forest.call(forest,ft?'new_ft':'new',{network:'sandbox',denomination,verification_key:vk,fee_recipient:treasury.accountId,...(token?{token_id:token.accountId}:{})},{attachedDeposit:NEAR,gas:GAS});
  const initial:any=await forest.view('get_config'),vaults:NearAccount[]=[];
  for(let i=0;i<2;i++){const salt=randomBytes(32).toString('hex'),id=predictSharedVault(forest.accountId,actors[0].accountId,salt);assert.equal(await actors[0].call(forest,'create_vault',{salt},{attachedDeposit:BigInt(initial.creation_deposit),gas:GAS}),true);vaults.push(root.getAccount(id));}
  const key=await forest.getKey();assert.ok(key);const sealed=await forest.batch(forest).deleteKey(key.getPublicKey()).transact();
  const policy:SharedPolicy={network:'sandbox',registry:forest.accountId,denomination,feeRecipient:treasury.accountId,registryWasmSha256:sha256(forestWasm),vaultWasmSha256:sha256(vaultWasm),verifierSha256:sha256(Buffer.from(vk,'base64')),...(token?{tokenId:token.accountId}:{})};
  const source=new RelayRpcSource('sandbox',forest.accountId,(worker.provider as any).connection.url);
  await source.read('tx',{tx_hash:sealed.transactionReceipt.hash,sender_account_id:forest.accountId,wait_until:'FINAL'});
  const tokenBalance=async(account:NearAccount)=>BigInt(await token!.view('ft_balance_of',{account_id:account.accountId}));
  const balance=async(account:NearAccount)=>token?tokenBalance(account):BigInt((await account.balance()).total.toString());
  let bounds:any;
  if(token){bounds=await token.view('storage_balance_bounds');for(const account of [forest,...vaults,...actors,...receivers,treasury])await root.call(token,'storage_deposit',{account_id:account.accountId,registration_only:true},{attachedDeposit:BigInt(bounds.min),gas:GAS});for(const account of actors)await root.call(token,'ft_transfer',{receiver_id:account.accountId,amount:'10000000'},{attachedDeposit:1n,gas:GAS});for(const actor of actors)await actor.call(forest,'prepay_storage',{}, {attachedDeposit:5n*STORAGE+5000000000000000000000n,gas:GAS});}
  let catalog=await discoverSharedVaults(source,policy);const notes=await Promise.all(Array.from({length:4},()=>createNote(catalog.pool)));
  for(let i=0;i<notes.length;i++){let deposited;const vault=vaults[i%2],args={commitment:notes[i].commitment,disclosure_root:'ab'.repeat(32)};if(token){await actors[0].call(vault,'prepay_storage',{}, {attachedDeposit:(i<2?25000000000000000000000n:STORAGE),gas:GAS});deposited=await actors[0].callRaw(token,'ft_transfer_call',{receiver_id:vault.accountId,amount:(principal+fee).toString(),msg:JSON.stringify(args)},{attachedDeposit:1n,gas:GAS});}else deposited=await actors[0].callRaw(vault,'deposit',args,{attachedDeposit:BigInt(quoteFees(denomination).depositAttached),gas:GAS});await source.read('tx',{tx_hash:deposited.transactionReceipt.hash,sender_account_id:actors[0].accountId,wait_until:'FINAL'});assert.equal((await vault.view<any>('get_deposit',{commitment:notes[i].commitment})).state,'Active');}
  catalog=await discoverSharedVaults(source,policy);const tree=await loadSharedTree(source,catalog);
  const plan=async(note:number,vault:NearAccount,recipient:string)=>{const disclosure_root=randomBytes(32).toString('hex'),proof=await proveSpend(catalog.pool,notes[note],tree,{kind:'withdraw',vault:vault.accountId,target:recipient,disclosureRoot:disclosure_root});return{vault:vault.accountId,recipient,disclosure_root,...proof.args};};
  const send=(actor:NearAccount,args:any)=>token?actor.callRaw(token,'ft_transfer_call',{receiver_id:forest.accountId,amount:fee.toString(),msg:JSON.stringify(args)},{attachedDeposit:1n,gas:GAS}):actor.callRaw(forest,'withdraw',args,{attachedDeposit:BigInt(quoteFees(denomination).withdrawalAttached),gas:GAS});
  const configs=()=>Promise.all(vaults.map(v=>v.view<any>('get_config')));
  const withdrawal=(nf:string)=>forest.view<any>('get_withdrawal',{nullifier:nf});
  const spent=(nf:string)=>forest.view<boolean>('is_spent',{nullifier:nf});
  // Initialize the shared Node verifier sequentially; concurrent first-use
  // snarkjs verification can leave an untracked worker pool alive at teardown.
  // Only transaction dispatch needs to race for these contract assertions.
  const same:Awaited<ReturnType<typeof plan>>[]=[];for(let i=0;i<vaults.length;i++)same.push(await plan(0,vaults[i],receivers[i].accountId));
  const before=await Promise.all(receivers.map(balance));
  const raced=await Promise.all(same.map((p,i)=>send(actors[i],p)));
  const accepted=await withdrawal(same[0].public_inputs[0]);assert.equal(accepted.state,'Complete');
  const after=await Promise.all(receivers.map(balance));assert.equal(after.reduce((n,b,i)=>n+b-before[i],0n),principal);assert.equal((await forest.view<any>('get_config')).outstanding_notes,3);
  assert.equal(accepted.recipient,same.find(p=>p.vault===accepted.vault)!.recipient);
  const liquidity=await configs(),selected=liquidity.findIndex(v=>v.available_notes===1);assert.ok(selected>=0);
  const distinct:Awaited<ReturnType<typeof plan>>[]=[];for(let i=0;i<2;i++)distinct.push(await plan(i+1,vaults[selected],receivers[i].accountId));
  const prior=await Promise.all(receivers.map(balance));
  const competed=await Promise.all(distinct.map((p,i)=>send(actors[i],p))),states=await Promise.all(distinct.map(p=>withdrawal(p.public_inputs[0])));
  assert.equal(states.filter(Boolean).length,1);const winner=states.findIndex(Boolean),loser=1-winner;assert.equal(states[winner].state,'Complete');assert.equal(await spent(distinct[loser].public_inputs[0]),false);
  const later=await Promise.all(receivers.map(balance));assert.equal(later.reduce((n,b,i)=>n+b-prior[i],0n),principal);assert.equal((await forest.view<any>('get_config')).outstanding_notes,2);
  const funded=(await configs()).findIndex(v=>v.available_notes===2);assert.ok(funded>=0);
  const missingName=tag+'-missing',missingId=missingName+'.'+root.accountId;
  let missing:NearAccount|undefined;if(token)missing=await root.createSubAccount(missingName,{initialBalance:NEAR});
  const failedPlan=await plan(3,vaults[funded],missingId),failed=await send(actors[0],failedPlan),nf=failedPlan.public_inputs[0];assert.equal((await withdrawal(nf)).state,'Retryable');assert.equal(await spent(nf),true);
  const pending:any=await forest.view('get_config');assert.equal(pending.pending_withdrawal_fees,fee.toString());assert.equal(pending.accrued_protocol_fees,(2n*fee).toString());assert.equal(pending.outstanding_notes,2);
  const reserved=await vaults[funded].view<any>('get_config');assert.equal(reserved.reserved_notes,1);assert.equal(reserved.available_notes,1);
  const changed=await send(actors[1],{...failedPlan,recipient:receivers[0].accountId});assert.ok(changed.receiptFailures.length>0);if(token)assert.equal(changed.parseResult(), '0');assert.equal((await withdrawal(nf)).recipient,missingId);
  const bypass=await actors[1].callRaw(vaults[funded],'payout',{nullifier:nf,recipient:receivers[0].accountId,disclosure_root:failedPlan.disclosure_root},{attachedDeposit:STORAGE/4n,gas:GAS});assert.ok(bypass.failed);
  const forged=await actors[1].callRaw(forest,'on_dispatched',{nullifier:nf,attempt:1},{gas:GAS});assert.ok(forged.failed);assert.equal((await withdrawal(nf)).state,'Retryable');
  if(token)await root.call(token,'storage_deposit',{account_id:missingId,registration_only:true},{attachedDeposit:BigInt(bounds.min),gas:GAS});else missing=await root.createSubAccount(missingName,{initialBalance:NEAR});
  const recipientBefore=await balance(missing!),actorFeeBefore=token?await tokenBalance(actors[1]):null;
  const retry=await actors[1].callRaw(forest,'retry_withdrawal',{nullifier:nf},{attachedDeposit:STORAGE,gas:GAS});assert.equal((await withdrawal(nf)).state,'Complete');assert.equal((await withdrawal(nf)).attempt,2);assert.equal(await balance(missing!)-recipientBefore,principal);if(token)assert.equal(await tokenBalance(actors[1]),actorFeeBefore);
  const done:any=await forest.view('get_config');assert.equal(done.pending_withdrawal_fees,'0');assert.equal(done.accrued_protocol_fees,(3n*fee).toString());assert.equal(done.outstanding_notes,1);assert.equal((await configs()).reduce((n,v)=>n+v.reserved_notes,0),0);
  if(token){
    const counts=[0,0];counts[same.findIndex(p=>p.vault===accepted.vault)]++;counts[winner]++;counts[0]++;
    for(let i=0;i<2;i++){assert.equal(await tokenBalance(actors[i]),10000000n-(i===0?4n*(principal+fee):0n)-BigInt(counts[i])*fee);const credit:any=await forest.view('get_storage_credit',{account_id:actors[i].accountId});assert.equal(credit.available,((5n-BigInt(counts[i]))*STORAGE).toString());}
    assert.equal(await tokenBalance(forest),3n*fee);assert.equal((await Promise.all(vaults.map(tokenBalance))).reduce((n,b)=>n+b,0n),principal+4n*fee);
  }
  const replayBefore=await balance(missing!),replayed=await actors[0].callRaw(forest,'retry_withdrawal',{nullifier:nf},{attachedDeposit:STORAGE,gas:GAS});assert.ok(replayed.failed);assert.equal(await balance(missing!),replayBefore);
  results.push({asset:token?'local TESTUSD fixture, NOT Circle-issued USDC':'NEAR',policy,realWasm:true,realGroth16:true,proofsPreparedSequentially:true,keylessRegistryAndVaults:true,sameNoteConcurrentDestinations:{hashes:raced.map(r=>r.transactionReceipt.hash),payouts:1,fullPrincipal:true},distinctNotesCompetingForOneLiquidSlot:{hashes:competed.map(r=>r.transactionReceipt.hash),payouts:1,loserNullifierUnspent:true},failure:{hash:failed.transactionReceipt.hash,nullifierReserved:true,liquidityReserved:true,feePendingNotEarned:true,ftRejectedCallsRefunded:!!token,ftRejectedStorageDebitRolledBack:!!token},mutationAndBypass:{recipientRejected:true,directVaultRejected:true,forgedCallbackRejected:true},recovery:{hash:retry.transactionReceipt.hash,originalRecipient:missingId,fullPrincipal:true,noSecondProtocolFee:true,noReplayPayout:true},remainingUnspentNotes:1,limits:'Remaining note intentionally retained only in the disposable sandbox. No public-network writes.'});
  console.log(JSON.stringify({asset:tag,passed:true,concurrentPayouts:2,recoveredPayouts:1}));
 }
 await mkdir('demo-output',{recursive:true});await writeFile('demo-output/payment-security-validation.json',JSON.stringify({format:'core-payment-security-validation-v1',checkedAt:new Date().toISOString(),passed:true,network:'sandbox',publicNetworkExecuted:false,productionAudit:false,results},null,2)+'\n');
}finally{await worker.tearDown();await shutdownProver();}
