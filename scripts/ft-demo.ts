import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { NearRpcOperationsSource, preflightFt, observeSettlement } from '../sdk/operations.js';
import { createReadOnlyApi } from '../server/api.js';
import { HttpGateway, OperationJournal, SettlementSession, type Call } from '../sdk/client/index.js';
import { fileJournalStorage } from '../sdk/client-node.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { NearRpcIndexSource } from '../sdk/indexer/source.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { TransactionDiscovery } from '../sdk/indexer/discovery.js';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker, type NearAccount, type TransactionResult } from 'near-workspaces';
import { createNote, proveSpend, encodeVerificationKey, sha256, STORAGE_FEE, shutdownProver } from '../sdk/core.js';
import { NearRpcSharedSource, discoverSharedVaults, loadSharedTree, predictSharedVault, type SharedPolicy } from '../sdk/shared.js';
import { buildFtDeposit, buildFtWithdrawal, buildFtRegistration, buildStoragePrepayment, quoteFtFees, type ContractCall } from '../sdk/ft.js';
import { createFreshRecipient } from '../sdk/wallet.js';
import { createReceipt, disclose, type Receipt } from '../sdk/disclosure.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { ensureSandbox } from './sandbox.js';

const NEAR = 10n ** 24n, USD = 1_000_000n, GAS = 300n * 10n ** 12n;
const forestWasm = await readFile('artifacts/core_forest.wasm'), vaultWasm = await readFile('artifacts/core_shared_vault.wasm');
const mockWasm = await readFile(resolve(process.env.CORE_CONTRACT_REPO || '../Contract', 'artifacts/core_test_ft.wasm'));
const vk = encodeVerificationKey(JSON.parse(await readFile('artifacts/verification_key.json','utf8')));
await ensureSandbox(); const worker = await Worker.init();
let apiServer: ReturnType<typeof createReadOnlyApi> | undefined;
let indexedApi:ReturnType<typeof createReadOnlyApi>|undefined,indexStore:IndexStore|undefined,indexReader:IndexStore|undefined;
try {
  const root = worker.rootAccount;
  const forest = await root.createSubAccount('forest'.padEnd(20,'x'),{initialBalance:25n*NEAR});
  const token = await root.createSubAccount('u'.repeat(54),{initialBalance:10n*NEAR});
  const fake = await root.createSubAccount('fake',{initialBalance:10n*NEAR});
  const alice = await root.createSubAccount('alice',{initialBalance:30n*NEAR});
  const bob = await root.createSubAccount('bob',{initialBalance:30n*NEAR});
  const relay = await root.createSubAccount('relay',{initialBalance:15n*NEAR});
  const treasury = await root.createSubAccount('treasury',{initialBalance:NEAR});
  for (const contract of [token,fake]) { await contract.deploy(mockWasm); await contract.call(contract,'new',{owner_id:root.accountId,total_supply:'10000000000'},{gas:GAS}); }
  await forest.deploy(forestWasm);
  await forest.call(forest,'new_ft',{network:'sandbox',denomination:USD.toString(),token_id:token.accountId,verification_key:vk,fee_recipient:treasury.accountId},{attachedDeposit:NEAR,gas:GAS});
  const config:any = await forest.view('get_config');
  async function createVault(owner:NearAccount) {
    const salt=randomBytes(32).toString('hex'), id=predictSharedVault(forest.accountId,owner.accountId,salt);
    const tx=await owner.callRaw(forest,'create_vault',{salt},{attachedDeposit:BigInt(config.creation_deposit),gas:GAS}); assert.equal(tx.parseResult(),true,tx.summary()); return root.getAccount(id);
  }
  const a=await createVault(alice),b=await createVault(bob);
  const key=await forest.getKey(); assert.ok(key); const deleted = await forest.batch(forest).deleteKey(key.getPublicKey()).transact();
  const rpc=(worker.provider as any).connection.url as string;
  const evidence = new NearRpcEvidenceSource('sandbox',forest.accountId,rpc);
  async function final(tx: TransactionResult) { const out:any = await evidence.getTransaction({hash:tx.transactionReceipt.hash,signer:tx.transactionReceipt.signer_id,recordIndex:0}); assert.equal(out.final_execution_status,'FINAL'); }
  await final(deleted);
  const source=new NearRpcSharedSource('sandbox',forest.accountId,rpc);
  const policy:SharedPolicy={network:'sandbox',registry:forest.accountId,denomination:USD.toString(),tokenId:token.accountId,feeRecipient:treasury.accountId,registryWasmSha256:sha256(forestWasm),vaultWasmSha256:sha256(vaultWasm),verifierSha256:sha256(Buffer.from(vk,'base64'))};
  const operations = new NearRpcOperationsSource('sandbox',forest.accountId,rpc);
  apiServer = createReadOnlyApi({source:operations,policy}); apiServer.listen(0,'127.0.0.1'); await once(apiServer,'listening');
  const apiAddress=apiServer.address(); assert.ok(apiAddress && typeof apiAddress!=='string');
  const apiUrl=`http://127.0.0.1:${apiAddress.port}`;
  async function api(path:string,value:unknown) { const response=await fetch(apiUrl+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}); const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result; }
  const notFunded=await api('/v1/ft/preflight',{operation:'deposit',payer:alice.accountId,vault:a.accountId});
  assert.equal(notFunded.canPrepare,false); assert.ok(notFunded.blockers.some((b:any)=>b.code==='PAYER_NOT_REGISTERED'));
  assert.ok(notFunded.blockers.some((b:any)=>b.code==='INSUFFICIENT_TOKENS'));
  let catalog=await discoverSharedVaults(source,policy); assert.equal(catalog.pool.version,3);
  async function call(owner:NearAccount, plan:ContractCall) { const tx = await owner.callRaw(root.getAccount(plan.contract),plan.method,plan.args,{attachedDeposit:BigInt(plan.attachedYoctoNear),gas:BigInt(plan.gas)}); await final(tx); return tx; }
  async function register(ft:NearAccount, accountId:string) { const bounds:any=await ft.view('storage_balance_bounds'); await call(root,buildFtRegistration(ft.accountId,accountId,bounds.min)); }
  for (const account of [alice,bob,relay,treasury,forest,a,b]) await register(token,account.accountId);
  for (const user of [alice,bob,relay]) await root.call(token,'ft_transfer',{receiver_id:user.accountId,amount:'100000000',memo:null},{attachedDeposit:1n,gas:GAS});
  async function balance(ft:NearAccount,account:NearAccount|string) { return BigInt(await ft.view<string>('ft_balance_of',{account_id:typeof account==='string'?account:account.accountId})); }
  async function prepay(owner:NearAccount,target:NearAccount) { const credit:any=await target.view('get_storage_credit',{account_id:owner.accountId}); const plan=buildStoragePrepayment(target.accountId,owner.accountId,credit); if(plan) await call(owner,plan); }
  async function send(owner:NearAccount,to:NearAccount,amount:bigint,msg:string,ft=token) { const tx = await owner.callRaw(ft,'ft_transfer_call',{receiver_id:to.accountId,amount:amount.toString(),memo:null,msg},{attachedDeposit:1n,gas:GAS}); await final(tx); return tx; }
  async function state(contract:NearAccount,method:string,args:Record<string,unknown>,expected:string) {
    for(let i=0;i<30;i++) { const value:any=await contract.view(method,args); if(value?.state===expected)return value; await new Promise(r=>setTimeout(r,150)); }
    assert.fail(`${method} did not reach ${expected}: ${JSON.stringify(await contract.view(method,args))}`);
  }
  const receipts=new Map<string,Receipt>(),transactions:TransactionResult[]=[];
  await mkdir('demo-output',{recursive:true});
  const journal=new OperationJournal(fileJournalStorage(`demo-output/wallet-${randomBytes(12).toString('hex')}.encrypted.json`),randomBytes(32).toString('hex'));
  await journal.create();const gateway=new HttpGateway(apiUrl);
  async function walletFlow(owner:NearAccount,tokenCall:Call,expectedKinds:string[]){
    const kinds:string[]=[],signed:TransactionResult[]=[];
    const session=new SettlementSession(journal,gateway,{identity:async()=>({network:'sandbox',accountId:owner.accountId}),sign:async(plan,context)=>{
      assert.equal(context.identity.accountId,owner.accountId);const tx=await call(owner,plan);signed.push(tx);
      const ref={hash:tx.transactionReceipt.hash,signer:owner.accountId};const checked=await gateway.verify(ref,plan);
      assert.equal(checked.status,'final');assert.equal((checked as {effect:string}).effect,'accepted');return ref;
    }},policy);
    const op=await session.importPlan({tokenCall});
    for(let attempt=0;attempt<30;attempt++){
      const review=await session.review(op.id);if(review.action==='complete'){assert.deepEqual(kinds,expectedKinds);return signed;}
      if(review.action==='sign'){kinds.push(review.kind!);await session.submitReviewed(op.id,review.callHash!);}
      else{assert.equal(review.action,'wait',review.message);await new Promise(r=>setTimeout(r,150));}
    }
    assert.fail('Wallet session did not reach finalized completion');
  }
  function receipt() { const r=createReceipt({sender:'sample sender',recipient:'sample recipient',asset:`nep141:${token.accountId}`,amount:USD.toString(),purpose:'FT cross-vault sandbox',reference:randomBytes(12).toString('hex'),occurredAt:new Date().toISOString(),credentialHash:''}); receipts.set(r.root,r); return r.root; }
  const quote=quoteFtFees(USD.toString()),pool=catalog.pool;
  const notes=[await createNote(pool),await createNote(pool),await createNote(pool)];
  const firstRoot=receipt(),firstMessage=JSON.stringify({commitment:notes[0].commitment,disclosure_root:firstRoot});
  const beforeAlice=await balance(token,alice);
  const missing=await send(alice,a,BigInt(quote.depositTransferTokens),firstMessage); assert.equal(missing.parseResult(),'0'); assert.equal(await balance(token,alice),beforeAlice);
  const readiness=await api('/v1/ft/preflight',{operation:'deposit',payer:alice.accountId,vault:a.accountId});
  assert.equal(readiness.canPrepare,true); assert.equal(readiness.prerequisitesSatisfied,false);
  assert.deepEqual(readiness.prerequisites.map((p:any)=>p.method),['prepay_storage']);
  const wrongAmount=await send(alice,a,USD,firstMessage); assert.equal(wrongAmount.parseResult(),'0'); assert.equal(await balance(token,alice),beforeAlice);
  const discoveryStartHeight=(await operations.finalBlock()).height;
  for(const [i,vault,owner] of [[0,a,alice],[1,b,bob],[2,b,bob]] as const) {
    catalog=await discoverSharedVaults(source,policy); const plan=await buildFtDeposit(catalog,vault.accountId,notes[i],i===0?firstRoot:receipt());
    let tx:TransactionResult;
    if(i===0){const signed=await walletFlow(owner,plan.tokenCall,['prerequisite','payment']);tx=signed.at(-1)!;}
    else{await prepay(owner,vault);tx=await call(owner,plan.tokenCall);}
    assert.equal(tx.parseResult(),quote.depositTransferTokens,tx.summary());
    await state(vault,'get_deposit',{commitment:notes[i].commitment},'Active'); transactions.push(tx);
  }
  assert.equal(await balance(token,forest),0n); assert.equal(await balance(token,a),USD+1500n); assert.equal(await balance(token,b),2n*USD+3000n);
  const depositStatus=await api('/v1/settlements/status',{kind:'deposit',vault:a.accountId,commitment:notes[0].commitment,expectedOwner:alice.accountId,expectedDisclosureRoot:firstRoot});
  assert.equal(depositStatus.complete,true); assert.equal(depositStatus.state,'Active');
  console.log('Preflight API verified live registrations, balances and sender storage; finalized observer confirms Active deposit.');
  console.log('Three FT deposits: all principal stays in vaults; registry token balance is zero. Missing storage and fee underpayment refunded.');
  const duplicate=await send(alice,a,BigInt(quote.depositTransferTokens),firstMessage); assert.equal(duplicate.parseResult(),'0');
  await prepay(alice,b); const duplicateCross=await send(alice,b,BigInt(quote.depositTransferTokens),firstMessage); assert.equal(duplicateCross.parseResult(),quote.depositTransferTokens);
  await state(b,'get_deposit',{commitment:notes[0].commitment},'Refundable');
  const refundable=await observeSettlement(operations,policy,{kind:'deposit',vault:b.accountId,commitment:notes[0].commitment,expectedOwner:alice.accountId});
  assert.equal(refundable.refundAvailable,true);assert.equal(refundable.refundCall!.method,'claim_deposit_refund');
  await root.call(token,'set_blocked',{account_id:alice.accountId},{gas:GAS});
  const failedRefund=await relay.callRaw(b,'claim_deposit_refund',{commitment:notes[0].commitment},{attachedDeposit:1n,gas:GAS}); assert.equal(failedRefund.parseResult(),false);
  await state(b,'get_deposit',{commitment:notes[0].commitment},'Refundable');
  await root.call(token,'set_blocked',{account_id:null},{gas:GAS}); const beforeRefund=await balance(token,alice);
  const refunded=await relay.callRaw(b,'claim_deposit_refund',{commitment:notes[0].commitment},{attachedDeposit:1n,gas:GAS}); assert.equal(refunded.parseResult(),true); assert.equal(await balance(token,alice)-beforeRefund,USD+1500n);
  await register(fake,a.accountId); const forged=await send(root,a,USD+1500n,JSON.stringify({commitment:'42',disclosure_root:receipt()}),fake); assert.equal(forged.parseResult(),'0'); assert.equal(await balance(fake,a),0n);
  assert.equal((await forest.view<any>('get_config')).outstanding_notes,3);
  console.log('Fake token rejected; duplicate deposits cannot mint twice; failed refund retries return full principal plus fee to original sender.');
  await prepay(relay,forest); const creditBefore:any=await forest.view('get_storage_credit',{account_id:relay.accountId});
  const native=JSON.parse(await readFile('test-vectors/shared.json','utf8'));
  const invalid=await send(relay,forest,1500n,JSON.stringify({vault:b.accountId,recipient:relay.accountId,disclosure_root:native.disclosureRoot,...native.proofs.aFromB})); assert.equal(invalid.parseResult(),'0');
  assert.deepEqual(await forest.view('get_storage_credit',{account_id:relay.accountId}),creditBefore);
  catalog=await discoverSharedVaults(source,policy); let tree=await loadSharedTree(source,catalog);
  const output=await createNote(pool),transferRoot=receipt(); const transferred=await proveSpend(pool,notes[0],tree,{kind:'transfer',target:output.commitment,disclosureRoot:transferRoot});
  const transfer=await relay.callRaw(forest,'transfer',{output_commitment:output.commitment,disclosure_root:transferRoot,...transferred.args},{attachedDeposit:STORAGE_FEE,gas:GAS}); assert.equal(transfer.parseResult(),3); transactions.push(transfer); await final(transfer);
  const recipient=createFreshRecipient('ft-sandbox-local-recipient'); const activation=await root.transfer(recipient.accountId,NEAR/10n); await final(activation);
  catalog=await discoverSharedVaults(source,policy); tree=await loadSharedTree(source,catalog);
  const withdrawalRoot=receipt(),proof=await proveSpend(pool,output,tree,{kind:'withdraw',vault:b.accountId,target:recipient.accountId,disclosureRoot:withdrawalRoot});
  const plan=buildFtWithdrawal(catalog,b.accountId,recipient.accountId,withdrawalRoot,proof.args); await prepay(relay,forest);
  const payoutReadiness=await preflightFt(operations,policy,{operation:'withdraw',payer:relay.accountId,vault:b.accountId,recipient:recipient.accountId});
  assert.equal(payoutReadiness.canPrepare,true);assert.ok(payoutReadiness.prerequisites.some(p=>p.method==='storage_deposit' && p.args.account_id===recipient.accountId));
  // Deliberately skip this registration once to exercise a recoverable token payout failure.
  const failed=await call(relay,plan.tokenCall); assert.equal(failed.parseResult(),'1500',failed.summary()); transactions.push(failed);
  await state(forest,'get_withdrawal',{nullifier:proof.publicSignals[0]},'Retryable'); assert.equal(await forest.view('is_spent',{nullifier:proof.publicSignals[0]}),true); assert.equal(await balance(token,recipient.accountId),0n);
  const payoutRef={kind:'withdrawal' as const,nullifier:proof.publicSignals[0],expectedVault:b.accountId,expectedRecipient:recipient.accountId,expectedDisclosureRoot:withdrawalRoot};
  const failedStatus=await api('/v1/settlements/status',payoutRef);assert.equal(failedStatus.state,'Retryable');assert.equal(failedStatus.complete,false);assert.equal(failedStatus.retryCall.method,'retry_withdrawal');
  await register(token,recipient.accountId);
  const retry=(await walletFlow(relay,plan.tokenCall,['retry']))[0];assert.equal(retry.parseResult(),true,retry.summary());transactions.push(retry);
  assert.equal(await balance(token,recipient.accountId),USD);
  assert.equal((await api('/v1/settlements/status',payoutRef)).complete,true);
  console.log('A-origin note transferred privately, then paid from B to fresh recipient after FT registration; retry charged no second USDC fee.');
  catalog=await discoverSharedVaults(source,policy); tree=await loadSharedTree(source,catalog); const raceRoot=receipt();
  const proofs=await Promise.all([a,b].map(v=>proveSpend(pool,notes[1],tree,{kind:'withdraw',vault:v.accountId,target:recipient.accountId,disclosureRoot:raceRoot})));
  await prepay(relay,forest); await prepay(alice,forest);
  const races=await Promise.all([call(relay,buildFtWithdrawal(catalog,a.accountId,recipient.accountId,raceRoot,proofs[0].args).tokenCall),call(alice,buildFtWithdrawal(catalog,b.accountId,recipient.accountId,raceRoot,proofs[1].args).tokenCall)]);
  assert.deepEqual(races.map(tx=>tx.parseResult()).sort(),['0','1500']); transactions.push(races.find(tx=>tx.parseResult()==='1500')!);
  await state(forest,'get_withdrawal',{nullifier:proofs[0].publicSignals[0]},'Complete'); assert.equal(await balance(token,recipient.accountId),2n*USD);
  catalog=await discoverSharedVaults(source,policy); const lastVault=catalog.vaults.find(v=>v.canWithdraw)!; tree=await loadSharedTree(source,catalog);
  const finalRoot=receipt(),lastProof=await proveSpend(pool,notes[2],tree,{kind:'withdraw',vault:lastVault.accountId,target:recipient.accountId,disclosureRoot:finalRoot});
  await root.call(token,'set_blocked',{account_id:recipient.accountId},{gas:GAS}); await prepay(relay,forest);
  const blocked=await call(relay,buildFtWithdrawal(catalog,lastVault.accountId,recipient.accountId,finalRoot,lastProof.args).tokenCall); assert.equal(blocked.parseResult(),'1500'); transactions.push(blocked); await state(forest,'get_withdrawal',{nullifier:lastProof.publicSignals[0]},'Retryable');
  await root.call(token,'set_blocked',{account_id:null},{gas:GAS}); const lastRetry=await relay.callRaw(forest,'retry_withdrawal',{nullifier:lastProof.publicSignals[0]},{attachedDeposit:STORAGE_FEE,gas:GAS}); assert.equal(lastRetry.parseResult(),true); transactions.push(lastRetry); await final(lastRetry);
  assert.equal(await balance(token,recipient.accountId),3n*USD); assert.equal((await forest.view<any>('get_config')).outstanding_notes,0); assert.equal((await forest.view<any>('get_config')).pending_withdrawal_fees,'0');
  console.log('Concurrent cross-vault proofs paid once; blocked-token payout remained reserved and safely resumed.');
  await root.call(token,'set_blocked',{account_id:treasury.accountId},{gas:GAS});
  for(const contract of [a,b,forest]) { const tx=await relay.callRaw(contract,'collect_protocol_fees',{},{attachedDeposit:1n,gas:GAS}); assert.equal(tx.parseResult(),false); }
  assert.equal(await balance(token,treasury),0n); await root.call(token,'set_blocked',{account_id:null},{gas:GAS});
  for(const contract of [a,b,forest]) { const tx=await relay.callRaw(contract,'collect_protocol_fees',{},{attachedDeposit:1n,gas:GAS}); assert.equal(tx.parseResult(),true); }
  assert.equal(await balance(token,treasury),9000n); assert.equal(await balance(token,forest),0n); assert.equal(await balance(token,a),0n); assert.equal(await balance(token,b),0n);
  const bundle:SettlementBundle={version:3,assetTokenId:token.accountId,network:'sandbox',contract:forest.accountId,scope:'selected_transactions',transactions:[]};
  for(const tx of transactions) for(const outcome of tx.result.receipts_outcome as any[]) {
    if(outcome.outcome.executor_id!==forest.accountId)continue;
    for(const log of outcome.outcome.logs) { if(!log.startsWith('EVENT_JSON:'))continue; const event=JSON.parse(log.slice(11)); if(event.version!=='3.0.0')continue;
      for(const record of event.data??[]) { if(typeof record.index!=='number')continue; const r=receipts.get(record.disclosure_root); assert.ok(r); bundle.transactions.push({tx:{hash:tx.transactionReceipt.hash,signer:tx.transactionReceipt.signer_id,recordIndex:record.index},disclosure:disclose(r,['asset','amount'])}); }
    }
  }
  const verified=await verifyBundle(bundle,new NearRpcEvidenceSource('sandbox',forest.accountId,rpc)); assert.equal(verified.feeSummary!.assetTokenId,token.accountId); assert.equal(verified.feeSummary!.protocolFeesCharged,'9000'); assert.equal(verified.feeSummary!.protocolFeesEarned,'9000');
  const indexPath=`demo-output/ft-index-${randomBytes(12).toString('hex')}.sqlite`,indexSource=new NearRpcIndexSource('sandbox',forest.accountId,rpc);
  indexStore=new IndexStore(indexPath,policy);let indexer=new SettlementIndexer(indexSource,indexStore);
  const indexed=await indexer.sync();assert.equal(indexed.indexedRecords,verified.records.length);assert.equal(indexed.remainingRecords,0);
  indexStore.close();indexStore=new IndexStore(indexPath,policy);indexer=new SettlementIndexer(indexSource,indexStore);assert.equal((await indexer.sync()).added,0);
  const discovery=new TransactionDiscovery(indexSource,indexStore);
  for(let cycle=0;cycle<100;cycle++){
    const result=await discovery.scan({startHeight:discoveryStartHeight,maxBlocks:100,maxTransactions:1000});assert.equal(result.state.blocked,null,JSON.stringify(result));
    if(result.state.lastComplete?.height===indexStore.checkpoint()!.block.height)break;
    assert.ok(cycle<99,'Discovery did not reach the indexed final block');
  }
  assert.ok(indexStore.status().candidates.pending>=transactions.length,'Scanner must discover the settlement transactions without supplied references');
  const linked=await indexer.linkPending({limit:100});assert.equal(linked.invalid,0,JSON.stringify(linked));assert.equal(linked.readErrors,0,JSON.stringify(linked));assert.equal(linked.pending,0,JSON.stringify(linked));assert.equal(indexStore.status().linkedRecords,verified.records.length,JSON.stringify(indexStore.status()));
  indexReader=new IndexStore(indexPath,policy,true);indexedApi=createReadOnlyApi({source:indexSource,policy,index:indexReader});indexedApi.listen(0,'127.0.0.1');await once(indexedApi,'listening');const indexedAddress=indexedApi.address();assert.ok(indexedAddress&&typeof indexedAddress!=='string');
  let cursor:string|null=null;const activityIndices:number[]=[];
  do {
    const response:Response=await fetch(`http://127.0.0.1:${indexedAddress.port}/v1/activity?limit=3${cursor?`&cursor=${cursor}`:''}`);
    assert.equal(response.status,200);
    const page:ReturnType<IndexStore['activity']>=await response.json();
    activityIndices.push(...page.items.map(item=>{assert.ok(item.provenance);assert.ok(item.provenance.transaction.hash);assert.equal(item.provenance.outerOutcome,'succeeded');return item.record.index;}));
    cursor=page.nextCursor;
  } while(cursor);
  assert.deepEqual(activityIndices,[...verified.records.map(r=>r.index)].sort((a,b)=>b-a));
  console.log('All-shard discovery found transaction origins without a supplied reference list; durable index linked all 14 records and served stable activity pages.');
  const remaining:any=await forest.view('get_storage_credit',{account_id:alice.accountId});
  if(BigInt(remaining.available)>0n) { const tx=await alice.callRaw(forest,'withdraw_storage_credit',{},{attachedDeposit:1n,gas:GAS}); assert.equal(tx.parseResult(),true); assert.equal((await forest.view<any>('get_storage_credit',{account_id:alice.accountId})).available,'0'); }
  assert.deepEqual((await journal.list()).map(o=>o.outcome),['complete','complete']);
  await mkdir('demo-output',{recursive:true}); await writeFile('demo-output/ft-validation.json',JSON.stringify({fixture:'NEP-141 sandbox token, NOT Circle-issued USDC',policy,bundle,verification:verified,recipientReceivedTokens:(await balance(token,recipient.accountId)).toString(),treasuryReceivedTokens:'9000',principalNeverPooled:true,concurrentSpendPaidOnce:true,retryChargedTokenFeeOnce:true,operationsApiVerified:true,preflightReadinessVerified:true,finalizedRecoveryObserverVerified:true,walletSessionSandboxVerified:true,encryptedJournalVerified:true,exactTransactionVerificationVerified:true,durableIndexRestartVerified:true,transactionReceiptCorrelationVerified:true,indexActivityPaginationVerified:true},null,2));
  console.log(`FT shared demo verified: ${verified.records.length} finalized records, full 3 TESTUSD received, 0.009 TESTUSD total fees; report demo-output/ft-validation.json`);
} finally {
  if(indexedApi){indexedApi.closeAllConnections();await new Promise<void>(resolve=>indexedApi!.close(()=>resolve()));}indexReader?.close();indexStore?.close();
  if(apiServer) { apiServer.closeAllConnections(); await new Promise<void>(resolve=>apiServer!.close(()=>resolve())); }
  await worker.tearDown(); await shutdownProver();
}
