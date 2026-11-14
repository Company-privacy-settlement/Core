import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsFixture } from './fixtures/operations.js';
import { preflightFt, observeSettlement, waitForSettlement, NearRpcOperationsSource } from '../sdk/operations.js';
import { NearRpcFactorySource } from '../sdk/factory.js';
import { STORAGE_FEE } from '../sdk/core.js';
const root = 'ab'.repeat(32);
test('FT preflight reads one final snapshot and plans registration before sender storage',async()=>{
  const f=operationsFixture(),p=await preflightFt(f.source,f.policy,{operation:'deposit',payer:f.payer,vault:f.vault});
  assert.equal(f.state.snapshots,1);assert.deepEqual(new Set(f.reads.map(r=>r.block)),new Set(['block-20']));
  assert.deepEqual(p.prerequisites.map(c=>c.method),['storage_deposit','prepay_storage']);assert.equal(p.requiredAttachedYoctoNear,'26250000000000000000001');
  assert.equal(p.canPrepare,true);assert.equal(p.prerequisitesSatisfied,false);assert.equal(p.tokenAmountRequired,'1001500');assert.equal(p.quote.recipientTokens,'1000000');
  assert.equal(p.token.nativeUsdc,false,'a USDC symbol on a fixture is not a Circle identity');
});
test('registered and funded FT users have no redundant prerequisite calls',async()=>{
  const f=operationsFixture();f.registrations.add(f.vault);f.credits.set(`${f.vault}|${f.payer}`,{available:STORAGE_FEE.toString(),in_flight:'0'});
  const p=await preflightFt(f.source,f.policy,{operation:'deposit',payer:f.payer,vault:f.vault});assert.equal(p.prerequisitesSatisfied,true);assert.deepEqual(p.prerequisites,[]);assert.equal(p.requiredAttachedYoctoNear,'1');
});
test('withdrawal preflight checks recipient and registry and charges only the add-on token fee',async()=>{
  const f=operationsFixture();f.registrations.add(f.vault);
  const p=await preflightFt(f.source,f.policy,{operation:'withdraw',payer:f.payer,vault:f.vault,recipient:f.recipient});
  assert.equal(p.tokenAmountRequired,'1500');assert.equal(p.storageTarget,f.policy.registry);assert.deepEqual(p.prerequisites.slice(0,2).map(c=>c.args.account_id),[f.policy.registry,f.recipient]);
  assert.equal(p.prerequisites.at(-1)!.method,'prepay_storage');assert.equal(p.requiredAttachedYoctoNear,'27500000000000000000001');
});
test('missing accounts and insufficient FT balances block preparation without hiding prerequisites',async()=>{
  const f=operationsFixture();f.missingAccounts.add(f.recipient);f.registrations.delete(f.payer);f.state.balance='1499';
  const p=await preflightFt(f.source,f.policy,{operation:'withdraw',payer:f.payer,vault:f.vault,recipient:f.recipient});
  assert.equal(p.canPrepare,false);assert.deepEqual(p.blockers.map(b=>b.code),['PAYER_NOT_REGISTERED','ACCOUNT_MISSING','INSUFFICIENT_TOKENS']);
  assert.ok(!p.prerequisites.some(c=>c.args.account_id===f.recipient));
});
test('existing storage credits use the exact shortfall and do not charge the bond twice',async()=>{
  const f=operationsFixture();f.credits.set(`${f.vault}|${f.payer}`,{available:'5000000000000000000000',in_flight:STORAGE_FEE.toString()});
  const p=await preflightFt(f.source,f.policy,{operation:'deposit',payer:f.payer,vault:f.vault});assert.equal(p.prerequisites.at(-1)!.attachedYoctoNear,'15000000000000000000000');
});
test('targeted preflight handles vaults beyond the default catalog page',async()=>{
  const f=operationsFixture();f.record.index=201;f.config.vault_count=202;
  const p=await preflightFt(f.source,f.policy,{operation:'deposit',payer:f.payer,vault:f.vault});assert.equal(p.vault,f.vault);assert.equal(f.reads.filter(r=>r.method==='list_vaults').length,1);
});
test('changed code, remaining keys, untrusted vaults and native groups are rejected',async()=>{
  const f=operationsFixture();await assert.rejects(preflightFt({...f.source,accessKeys:async()=>[{}]},f.policy,{operation:'deposit',payer:f.payer,vault:f.vault}),/keys/);
  await assert.rejects(preflightFt(f.source,f.policy,{operation:'deposit',payer:f.payer,vault:'unknown.test.near'}),/registered/);
  const n=operationsFixture(true);await assert.rejects(preflightFt(n.source,n.policy,{operation:'deposit',payer:n.payer,vault:n.vault}),/v3/);
  f.local.available_notes=0;await assert.rejects(preflightFt(f.source,f.policy,{operation:'withdraw',payer:f.payer,vault:f.vault,recipient:f.recipient}),/liquidity/);
});
test('pending payout remains pending until the contract permits a bound retry',async()=>{
  const f=operationsFixture();f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Pending',attempt:1,last_height:10};
  const ref={kind:'withdrawal' as const,nullifier:'42',expectedRecipient:f.recipient,expectedVault:f.vault,expectedDisclosureRoot:root};
  let p=await observeSettlement(f.source,f.policy,ref);assert.equal(p.complete,false);assert.equal(p.retryAvailable,false);assert.equal(p.retryAfterBlock,30);
  f.state.height=30;p=await observeSettlement(f.source,f.policy,ref);assert.equal(p.state,'Pending');assert.equal(p.retryAvailable,true);assert.equal(p.retryCall!.attachedYoctoNear,STORAGE_FEE.toString());assert.deepEqual(p.retryCall!.args,{nullifier:'42'});
});
test('completed state must match the original destination and receipt commitment',async()=>{
  const f=operationsFixture();f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Complete',attempt:1,last_height:10};
  const ref={kind:'withdrawal' as const,nullifier:'42',expectedRecipient:f.recipient};assert.equal((await observeSettlement(f.source,f.policy,ref)).complete,true);
  await assert.rejects(observeSettlement(f.source,f.policy,{...ref,expectedRecipient:'other.test.near'}),/binding/);
  f.source.codeSha256=async()=>f.policy.registryWasmSha256;await assert.rejects(observeSettlement(f.source,f.policy,ref),/code/);
});
test('deposit refunds and in-flight refunds have distinct recovery actions',async()=>{
  const f=operationsFixture();const ref={kind:'deposit' as const,vault:f.vault,commitment:'42',expectedOwner:f.payer};
  for(const [state,refund,returned] of [['Refundable',true,false],['RefundInFlight',false,false],['Refunded',false,true]] as const){
    f.state.deposit={owner:f.payer,disclosure_root:root,state,attempt:1,last_height:10};const p=await observeSettlement(f.source,f.policy,ref);assert.equal(p.refundAvailable,refund);assert.equal(p.refunded,returned);assert.equal(p.complete,false);assert.equal(p.refundCall?.attachedYoctoNear??null,refund?'1':null);
  }
  await assert.rejects(observeSettlement(f.source,f.policy,{...ref,expectedOwner:'attacker.test.near'}),/binding/);
});
test('timeouts and absent records never become failed payouts and polling never broadcasts',async()=>{
  const f=operationsFixture();const ref={kind:'withdrawal' as const,nullifier:'42'};
  const absent=await waitForSettlement(f.source,f.policy,ref,{maxAttempts:1});assert.equal(absent.state,'NotFound');assert.equal(absent.timedOut,true);assert.equal(absent.retryCall,null);
  f.state.onSnapshot=()=>{if(f.state.snapshots>=3)f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Complete',attempt:1,last_height:10};};
  const done=await waitForSettlement(f.source,f.policy,ref,{maxAttempts:2,intervalMs:100});assert.equal(done.complete,true);assert.equal(done.attempts,2);
  assert.ok(f.reads.every(r=>!['ft_transfer_call','retry_withdrawal','withdraw'].includes(r.method)));
  await assert.rejects(waitForSettlement(f.source,f.policy,ref,{signal:AbortSignal.abort()}),/abort/i);
});
test('RPC only treats UNKNOWN_ACCOUNT as absence and preserves other upstream failures',async(t)=>{
  let mode='missing';const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response(JSON.stringify(mode==='view-error'?{result:{error:'contract failed'}}:{error:{name:'HANDLER_ERROR',cause:{name:mode==='missing'?'UNKNOWN_ACCOUNT':'UNKNOWN_BLOCK'}}}),{status:200});
  const source=new NearRpcOperationsSource('sandbox','forest.test.near','http://127.0.0.1:9999');
  assert.equal(await source.account('absent.test.near','block'),null);mode='block';await assert.rejects(source.account('absent.test.near','block'),/UNKNOWN_BLOCK/);
  mode='view-error';await assert.rejects(new NearRpcFactorySource('sandbox','forest.test.near','http://127.0.0.1:9999').config('block'),/contract failed/);
});
test('pending observation timeout is unresolved and cancellation wins over a completed in-flight read',async()=>{
  const f=operationsFixture();const ref={kind:'withdrawal' as const,nullifier:'42'};
  f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Pending',attempt:1,last_height:10};
  const timed=await waitForSettlement(f.source,f.policy,ref,{maxAttempts:1});assert.equal(timed.state,'Pending');assert.equal(timed.timedOut,true);assert.equal(timed.complete,false);assert.equal(timed.retryCall,null);
  const controller=new AbortController();f.state.onSnapshot=()=>{f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Complete',attempt:1,last_height:10};controller.abort();};
  await assert.rejects(waitForSettlement(f.source,f.policy,ref,{signal:controller.signal}),/abort/i);
});
test('native NEAR operation observation uses the same final-state rules without FT fee interpretation',async()=>{
  const f=operationsFixture(true);f.state.deposit={owner:f.payer,disclosure_root:root,state:'Active',attempt:1,last_height:10};
  const p=await observeSettlement(f.source,f.policy,{kind:'deposit',vault:f.vault,commitment:'42',expectedOwner:f.payer});assert.equal(p.complete,true);assert.equal(p.assetTokenId,null);
  f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:root,state:'Complete',attempt:1,last_height:10};
  assert.equal((await observeSettlement(f.source,f.policy,{kind:'withdrawal',nullifier:'43',expectedRecipient:f.recipient})).complete,true);
});

test('transaction reconciliation requests current status without waiting or broadcasting and preserves finality markers',async t=>{const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let mode='unknown';const methods:string[]=[];globalThis.fetch=async(_url,init)=>{const {method,params}=JSON.parse(String(init?.body));methods.push(method);assert.equal(params.wait_until,'NONE');return new Response(JSON.stringify(mode==='unknown'?{error:{cause:{name:'UNKNOWN_TRANSACTION'}}}:{result:{final_execution_status:mode==='final'?'FINAL':'INCLUDED',transaction:{hash:'fixture'}}}));};const source=new NearRpcOperationsSource('testnet','forest.testnet','https://rpc.testnet.near.org');assert.equal(await source.transaction('fixture','payer.testnet'),null);mode='pending';assert.equal((await source.transaction('fixture','payer.testnet') as any).final_execution_status,'INCLUDED');mode='final';assert.equal((await source.transaction('fixture','payer.testnet') as any).final_execution_status,'FINAL');assert.deepEqual(methods,['tx','tx','tx']);});
