import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { prepareInvoiceProof, matchInvoiceProof, invoiceSettlementGuards, type InvoicePaymentGateway } from '../sdk/client/invoice-payment.js';
import { createInvoice, invoiceHash, invoiceSigningDigest, invoicePaymentRoots, matchInvoicePlan, type SignedInvoice, type InvoiceStatus, type Invoice } from '../sdk/client/invoices.js';
import { noteDomain, noteHash } from '../sdk/client/notes.js';
import { createProofBundle, spendWitness, type ProvingAssets, type ProvingRequest, type ProverResult, type ProofBundle } from '../sdk/client/prover.js';
import { OperationJournal } from '../sdk/client/journal.js';
import { SettlementSession } from '../sdk/client/session.js';
import type { Gateway, JournalStorage, Observation, WalletPort } from '../sdk/client/types.js';
import { NoteTree, shutdownProver } from '../sdk/core.js';
import { operationsFixture } from './fixtures/operations.js';

const password = 'public invoice payment fixture only';
const assets: ProvingAssets = {manifest:new Blob(['fixture']),wasm:new Blob(['fixture']),zkey:new Blob(['fixture']),verificationKey:new Blob(['fixture']),manifestSha256:'aa'.repeat(32)};
function memory() {
  let value:string|null=null, tail=Promise.resolve();
  const state = { writes:0, onWrite:undefined as undefined|(()=>void) };
  const storage:JournalStorage = {read:async()=>value,write:async next=>{value=next;state.writes++;state.onWrite?.();},exclusive:async action=>{
    const before=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});await before;try{return await action();}finally{release();}
  }};
  return {storage,state};
}
async function fixture(legacy=false) {
  const f=operationsFixture(), keys=generateKeyPairSync('ed25519');
  let invoice:Invoice=createInvoice({merchantAccount:'merchant.test.near',recipient:f.recipient,title:'Connected payment',reference:'UNIT-TEST',policy:f.policy,units:2,createdAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
  if(legacy){const {paymentNonces:_,...old}=invoice as Extract<Invoice,{version:2}>;invoice={...old,version:1};}
  const signed:SignedInvoice={invoice,signature:{accountId:invoice.merchantAccount,publicKey:'ed25519:'+bs58.encode(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32)),signature:sign(null,Buffer.from(await invoiceSigningDigest(await invoiceHash(invoice),invoice.policy.network,invoice.nonce)),keys.privateKey).toString('base64')}};
  const roots=await invoicePaymentRoots(invoice), domain=await noteDomain(f.policy);
  const notes=['123','789'].map(secret=>({version:1 as const,domain,secret,nullifier:(BigInt(secret)+1n).toString(),commitment:noteHash([secret,(BigInt(secret)+1n).toString(),domain])}));
  const tree=await NoteTree.from(notes.map(n=>n.commitment)), completed=new Set<string>();
  const state={merchant:true,broken:false,used:new Map<string,string>(),statusCalls:0,proofCalls:0,signs:0,onProof:undefined as undefined|(()=>void|Promise<void>),onWallet:undefined as undefined|((context:Parameters<WalletPort['sign']>[1])=>Promise<void>),retry:false};
  const snapshot={version:1 as const,policy:f.policy,checkedAtBlock:{hash:'B'.repeat(44),height:20},root:tree.root,commitments:tree.leaves,vault:f.vault};
  const gateway:Gateway & InvoicePaymentGateway={
    policy:async()=>f.policy,
    invoiceStatus:async()=>{
      state.statusCalls++;if(!state.merchant)throw new Error('Merchant key revoked');if(state.broken)throw new Error('Index unavailable');
      const n=state.used.size,paid=BigInt(n)*1000000n;
      return {invoiceHash:await invoiceHash(signed.invoice),settlementRoot:legacy?roots[0]:null,...(!legacy?{settlementRoots:roots,reusedPaymentReferences:0}:{}),state:n===2?'paid':n?'partial':'awaiting_payment',expectedTokens:'2000000',paidTokens:paid.toString(),remainingTokens:(2000000n-paid).toString(),overpaidTokens:'0',lateTokens:'0',confirmedPayments:n,coverageLimited:false,chainFreshnessChecked:false,checkedAt:{hash:'B'.repeat(44),height:20,updatedAt:new Date().toISOString()},confirmations:[...state.used].map(([settlementRoot,nullifier],index)=>({settlementRoot,nullifier,recordIndex:index,blockHeight:20,late:false,transaction:null}))} as InvoiceStatus;
    },
    provingContext:async()=>snapshot,
    preflight:async()=>({canPrepare:true,prerequisitesSatisfied:true,prerequisites:[],blockers:[],tokenAmountRequired:'1500',payerTokenBalance:'1000000',checkedAtBlock:snapshot.checkedAtBlock}),
    observe:async reference=>{
      const complete=reference.kind==='withdrawal'&&completed.has(reference.nullifier), retry=state.retry;
      return {state:complete?'Complete':retry?'Retryable':'NotFound',complete,refunded:false,retryAvailable:retry,refundAvailable:false,
        retryCall:retry&&reference.kind==='withdrawal'?{contract:f.policy.registry,method:'retry_withdrawal',args:{nullifier:reference.nullifier},gas:'300000000000000',attachedYoctoNear:'20000000000000000000000'}:null,refundCall:null,
        record:complete||retry?{state:complete?'Complete':'Retryable'}:null,checkedAtBlock:snapshot.checkedAtBlock} satisfies Observation;
    },
    verify:async transaction=>({status:'final',effect:'accepted',transaction}),
  };
  const prover={prove:async(request:ProvingRequest,_assets:ProvingAssets)=>{
    state.proofCalls++;await state.onProof?.();
    const witness=await spendWitness(request),bundle=await createProofBundle(request,{manifestSha256:assets.manifestSha256,setup:'UNSAFE_LOCAL_DEVELOPMENT_ONLY'},{proof:Buffer.alloc(256).toString('base64'),public_inputs:witness.publicInputs});
    return {bundle,metrics:{elapsedMs:1,witnessMs:0,provingMs:0,verificationMs:0}} satisfies ProverResult;
  }};
  const wallet:WalletPort={identity:async()=>({network:f.policy.network,accountId:f.payer}),sign:async(_call,context)=>{await state.onWallet?.(context);context.authorize?.();state.signs++;return {hash:'1'.repeat(44),signer:f.payer};}};
  const m=memory(),journal=new OperationJournal(m.storage,password);await journal.create();
  const session=new SettlementSession(journal,gateway,wallet,f.policy,invoiceSettlementGuards(gateway,signed));
  const prove=(index=0,note=notes[0],getOperations=()=>journal.list())=>prepareInvoiceProof(prover,gateway,signed,index,note,assets,f.vault,{getOperations});
  return {...f,signed,roots,notes,state,gateway,prover,wallet,journal,session,m,prove,completed,snapshot};
}
test.after(shutdownProver);

test('invoice note proof derives the exact selected signed unit and preserves additive fees',async()=>{
  const f=await fixture(),result=await f.prove(1);
  assert.equal(result.bundle.action.recipient,f.signed.invoice.recipient);assert.equal(result.bundle.action.disclosureRoot,f.roots[1]);
  assert.equal(result.bundle.plan.tokenCall.args.amount,'1500');assert.equal(f.state.statusCalls,2);assert.equal(f.state.signs,0);assert.deepEqual(await f.journal.list(),[]);
  await assert.rejects(()=>matchInvoiceProof(result.bundle,f.signed,0,f.payer),/selected|invoice/);
  await assert.rejects(()=>matchInvoicePlan(result.bundle.plan,f.signed.invoice,f.payer,0));
});
test('proof preparation never starts for a forged invoice, foreign note, used unit or invalid index',async()=>{
  const f=await fixture();
  const forged=structuredClone(f.signed);forged.invoice.recipient='attacker.test.near';
  await assert.rejects(()=>prepareInvoiceProof(f.prover,f.gateway,forged,0,f.notes[0],assets,f.vault));
  await assert.rejects(()=>f.prove(2));await assert.rejects(()=>f.prove(0,{...f.notes[0],secret:'999'}));
  f.state.used.set(f.roots[0],'42');await assert.rejects(()=>f.prove(0),/indexed/);assert.equal(f.state.proofCalls,0);
});
test('merchant revocation and unavailable indexing fail closed before proving',async()=>{
  const f=await fixture();f.state.merchant=false;await assert.rejects(()=>f.prove(),/revoked/);
  f.state.merchant=true;f.state.broken=true;await assert.rejects(()=>f.prove(),/unavailable/);assert.equal(f.state.proofCalls,0);
});
test('a unit paid while proving cannot become an importable checkout result',async()=>{
  const f=await fixture();f.state.onProof=()=>{f.state.used.set(f.roots[0],'42');};
  await assert.rejects(()=>f.prove(),/indexed/);assert.deepEqual(await f.journal.list(),[]);assert.equal(f.state.signs,0);
});
test('proof preparation rejects a different payout vault and cancellation during status reads',async()=>{
  const f=await fixture();f.gateway.provingContext=async()=>({...f.snapshot,vault:`v${'b'.repeat(32)}.${f.policy.registry}`});
  await assert.rejects(()=>f.prove(),/substituted/);assert.equal(f.state.proofCalls,0);
  const abort=new AbortController(),status=f.gateway.invoiceStatus;f.gateway.invoiceStatus=async(...args)=>{const result=await status(...args);abort.abort();return result;};
  await assert.rejects(()=>prepareInvoiceProof(f.prover,f.gateway,f.signed,0,f.notes[0],assets,f.vault,{signal:abort.signal}),{name:'AbortError'});
});
test('note → proof → review → signature → finalized state uses one durable operation',async()=>{
  const f=await fixture(),{bundle}=await f.prove();const operation=await f.session.importPlan(bundle.plan);
  const review=await f.session.review(operation.id);assert.equal(review.action,'sign');assert.equal(review.kind,'payment');assert.equal(f.state.signs,0);
  await f.session.submitReviewed(operation.id,review.callHash!);assert.equal(f.state.signs,1);
  assert.equal((await f.journal.list())[0].attempts[0].state,'submitted');
  f.completed.add(bundle.spend.public_inputs[0]);assert.equal((await f.session.review(operation.id)).action,'complete');
  assert.equal((await f.journal.list())[0].outcome,'complete');assert.equal(f.state.signs,1);
});
test('concurrent imports reserve one local v2 unit and preserve exact-plan idempotency',async()=>{
  const f=await fixture(),a=await f.prove(),b=await f.prove(0,f.notes[1]);
  const results=await Promise.allSettled([f.session.importPlan(a.bundle.plan),f.session.importPlan(b.bundle.plan)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const list=await f.journal.list();assert.equal(list.length,1);
  const stored=await f.session.importPlan({tokenCall:list[0].payment});assert.equal(stored.id,list[0].id);
});
test('a persisted unit or note cannot silently create a second payment proof',async()=>{
  const f=await fixture(),first=await f.prove();await f.session.importPlan(first.bundle.plan);
  await assert.rejects(()=>f.prove(0,f.notes[1]),/local payment/);
  await assert.rejects(()=>f.prove(1,f.notes[0]),/local withdrawal/);
  const other=await f.prove(1,f.notes[1]);assert.equal(other.bundle.action.disclosureRoot,f.roots[1]);
});
test('used references and revoked merchant keys are rechecked before any signing intent',async()=>{
  for(const gate of ['used','revoked']){
    const f=await fixture(),p=await f.prove(),operation=await f.session.importPlan(p.bundle.plan),review=await f.session.review(operation.id);
    if(gate==='used')f.state.used.set(f.roots[0],'999');else f.state.merchant=false;
    await assert.rejects(()=>f.session.submitReviewed(operation.id,review.callHash!));assert.equal(f.state.signs,0);assert.equal((await f.journal.list())[0].attempts.length,0);
  }
});
test('authorization expiring during durable intent persistence never reaches the wallet',async()=>{
  const f=await fixture(),p=await f.prove(),operation=await f.session.importPlan(p.bundle.plan),review=await f.session.review(operation.id);
  let clock=Date.now();const mock=test.mock.method(Date,'now',()=>clock);const writes=f.m.state.writes;
  f.m.state.onWrite=()=>{if(f.m.state.writes===writes+1)clock+=16000;};
  try{await assert.rejects(()=>f.session.submitReviewed(operation.id,review.callHash!),/stale/);assert.equal(f.state.signs,0);assert.equal((await f.journal.list())[0].attempts.length,0);}finally{mock.mock.restore();}
});
test('last-moment adapter authorization blocks expiry after wallet identity awaits',async()=>{
  const f=await fixture(),p=await f.prove(),operation=await f.session.importPlan(p.bundle.plan),review=await f.session.review(operation.id);
  let clock=Date.now();const mock=test.mock.method(Date,'now',()=>clock);f.state.onWallet=async()=>{clock=Date.parse(f.signed.invoice.expiresAt)+1;};
  try{await assert.rejects(()=>f.session.submitReviewed(operation.id,review.callHash!),/expired/);assert.equal(f.state.signs,0);assert.equal((await f.journal.list())[0].attempts[0].state,'uncertain');assert.equal((await f.session.review(operation.id)).action,'reconcile');}finally{mock.mock.restore();}
});
test('a lost wallet result remains uncertain and can never automatically send again',async()=>{
  const f=await fixture(),p=await f.prove(),operation=await f.session.importPlan(p.bundle.plan),review=await f.session.review(operation.id);
  f.wallet.sign=async(_call,context)=>{context.authorize?.();f.state.signs++;throw new Error('response lost');};
  await assert.rejects(()=>f.session.submitReviewed(operation.id,review.callHash!),/lost/);
  const next=await f.session.review(operation.id);assert.equal(next.action,'reconcile');await assert.rejects(()=>f.session.submitReviewed(operation.id,review.callHash!));assert.equal(f.state.signs,1);
});
test('expiry and merchant rotation do not block fixed-destination recovery of accepted funds',async()=>{
  const f=await fixture(),p=await f.prove(),operation=await f.session.importPlan(p.bundle.plan);f.state.retry=true;
  const review=await f.session.review(operation.id);assert.equal(review.kind,'retry');f.state.merchant=false;
  const mock=test.mock.method(Date,'now',()=>Date.parse(f.signed.invoice.expiresAt)+1);
  try{await f.session.submitReviewed(operation.id,review.callHash!);assert.equal(f.state.signs,1);assert.equal((await f.journal.list())[0].attempts[0].call.method,'retry_withdrawal');}finally{mock.mock.restore();}
});
test('legacy v1 references allow sequential notes after a finalized partial payment',async()=>{
  const f=await fixture(true),first=await f.prove(),operation=await f.session.importPlan(first.bundle.plan);f.completed.add(first.bundle.spend.public_inputs[0]);
  assert.equal((await f.session.review(operation.id)).action,'complete');f.state.used.set(f.roots[0],first.bundle.spend.public_inputs[0]);
  const next=await f.prove(0,f.notes[1]);await f.session.importPlan(next.bundle.plan);assert.equal((await f.journal.list()).length,2);
});
