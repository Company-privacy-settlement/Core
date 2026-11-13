import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OrganizationStore } from '../server/organizations/store.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { OrganizationClient } from '../sdk/client/organizations.js';
import { canonical, shaField, sha256 } from '../sdk/client/crypto.js';
import { corporateContent, corporateQuote, corporateSettlementGuards, verifyCorporatePayment, type CorporatePayment } from '../sdk/client/corporate-payments.js';
import { OperationJournal } from '../sdk/client/journal.js';
import { SettlementSession } from '../sdk/client/session.js';
import type { Gateway, WalletPort, JournalStorage } from '../sdk/client/types.js';
import { backupOrganizations, restoreOrganizations, organizationReviewTemplate, activateOrganizations } from '../scripts/lib/organization-backup.js';
import { fileDigest } from '../scripts/lib/index-backup.js';
import { readFileSync, writeFileSync } from 'node:fs';

const audience='https://organization-api.example',origin='https://front.example',maker='maker.testnet',approver='approver.testnet',owner='owner.testnet';
const policy={network:'testnet' as const,registry:'forest.testnet',denomination:'1000000',tokenId:'usdc.testnet',feeRecipient:'treasury.testnet',registryWasmSha256:'aa'.repeat(32),vaultWasmSha256:'bb'.repeat(32),verifierSha256:'cc'.repeat(32)};
const vault=`v${'a'.repeat(32)}.forest.testnet`,recipient='recipient.testnet',disclosure='dd'.repeat(32);
async function content(payer=maker,nf='42') {
  const domain=await shaField(`core:ft:v3|testnet|${policy.registry}|${policy.tokenId}|1000000`),context=await shaField(`core:action:ft:v3|${domain}|withdraw|${vault}|${recipient}|${disclosure}`);
  return corporateContent({format:'core-corporate-payment-v1',title:'Quarterly supplier settlement',policy,payer,payment:{contract:policy.tokenId,method:'ft_transfer_call',gas:'300000000000000',attachedYoctoNear:'1',args:{receiver_id:policy.registry,amount:'1500',msg:JSON.stringify({vault,recipient,disclosure_root:disclosure,proof:Buffer.alloc(256).toString('base64'),public_inputs:[nf,'1','1',context,domain]})}},prerequisites:[{contract:policy.registry,method:'prepay_storage',gas:'300000000000000',attachedYoctoNear:'25000000000000000000000',args:{account_id:payer}}]});
}
function fixture(t:{after(fn:()=>void):void},file=':memory:') {
  let now=Date.now();const store=new OrganizationStore(file,audience,()=>now);t.after(()=>store.close());const org=store.create(owner,'Company');
  for(const [account,role]of [[maker,'operator'],[approver,'admin'],['viewer.testnet','viewer'],['auditor.testnet','auditor']] as const){const i=store.invite(org.id,owner,account,role);store.respondInvite(i.id,account,true,i.version);}
  const create=async(payer=maker,nf='42')=>store.payments.create(org.id,payer,await content(payer,nf));
  const approve=(p:CorporatePayment)=>store.payments.decide(org.id,approver,p.payload.paymentId,'approve',p.version,p.contentHash);
  return{store,org,create,approve,advance:(ms:number)=>{now+=ms;}};
}
test('creator and approver are separate wallet principals, including owner/admin self-approval',async t=>{
  const f=fixture(t);for(const account of [owner,approver,maker]){
    const p=await f.create(account,String([owner,approver,maker].indexOf(account)+42));
    assert.throws(()=>f.store.payments.decide(f.org.id,account,p.payload.paymentId,'approve',p.version,p.contentHash),/SELF_APPROVAL|PERMISSION_DENIED/);
  }
  const p=await f.create(maker,'99'),approved=f.approve(p);assert.equal(approved.approvalValid,true);assert.equal(approved.approvedBy,approver);assert.notEqual(approved.approvedBy,approved.payload.creatorAccount);
});
test('immutable approval includes policy, recipient, proof, reference, fee and prerequisite bytes',async t=>{
  const f=fixture(t),p=f.approve(await f.create());await verifyCorporatePayment(p,f.org.id);
  assert.deepEqual(corporateQuote(p.payload.content),{principalTokens:'1000000',feeTokens:'1500',maximumAttachedYoctoNear:'25000000000000000000001'});
  const alterations=[(v:any)=>v.payload.content.payment.args.amount='1499',(v:any)=>v.payload.content.title='Changed title',(v:any)=>v.payload.content.policy.tokenId='other.testnet',(v:any)=>v.payload.content.prerequisites[0].attachedYoctoNear='1',(v:any)=>v.payload.content.payment.args.msg=v.payload.content.payment.args.msg.replace(recipient,'attacker.testnet')];
  for(const change of alterations){const changed=structuredClone(p);change(changed);await assert.rejects(()=>verifyCorporatePayment(changed));if(canonical(changed.payload.content.payment)!==canonical(p.payload.content.payment))assert.throws(()=>f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'payment',changed.payload.content.payment),/CALL_CHANGED|INVALID_PAYMENT_CALL/);assert.equal(f.store.payments.get(f.org.id,maker,p.payload.paymentId).contentHash,p.contentHash);}
});
test('only current authorized roles can read, prepare, approve or execute and tenants stay isolated',async t=>{
  const f=fixture(t),p=await f.create();
  await assert.rejects(async()=>f.store.payments.create(f.org.id,'viewer.testnet',await content('viewer.testnet')),/PERMISSION_DENIED/);
  assert.throws(()=>f.store.payments.get(f.org.id,'viewer.testnet',p.payload.paymentId),/PERMISSION_DENIED/);
  assert.equal(f.store.payments.get(f.org.id,'auditor.testnet',p.payload.paymentId).state,'pending');
  assert.throws(()=>f.store.payments.decide(f.org.id,'auditor.testnet',p.payload.paymentId,'approve',p.version,p.contentHash),/PERMISSION_DENIED/);
  const approved=f.approve(p);assert.throws(()=>f.store.payments.authorize(f.org.id,approver,p.payload.paymentId,approved.contentHash,'payment',p.payload.content.payment),/EXECUTOR_MISMATCH/);
  const foreign=f.store.create('outsider.testnet','Other company');assert.throws(()=>f.store.payments.get(foreign.id,maker,p.payload.paymentId),/ORGANIZATION_NOT_FOUND/);
  assert.throws(()=>f.store.payments.get(f.org.id,'outsider.testnet',p.payload.paymentId),/ORGANIZATION_NOT_FOUND/);
});
test('approval hashes and optimistic versions reject substitution and racing decisions atomically',async t=>{
  const f=fixture(t),p=await f.create(),before=f.store.auditPage(f.org.id,owner).items.length;
  assert.throws(()=>f.store.payments.decide(f.org.id,approver,p.payload.paymentId,'approve',p.version,'0'.repeat(64)),/CONTENT_CHANGED/);
  assert.equal(f.store.auditPage(f.org.id,owner).items.length,before);f.approve(p);
  assert.throws(()=>f.store.payments.decide(f.org.id,owner,p.payload.paymentId,'approve',p.version,p.contentHash),/VERSION_CONFLICT/);
});
test('removing or changing either principal invalidates approval even after rejoining',async t=>{
  for(const person of [maker,approver]){
    const f=fixture(t),p=f.approve(await f.create());f.store.remove(f.org.id,owner,person,1);
    const i=f.store.invite(f.org.id,owner,person,person===maker?'operator':'admin');f.store.respondInvite(i.id,person,true,i.version);
    assert.equal(f.store.payments.get(f.org.id,maker,p.payload.paymentId).approvalValid,false);
    assert.throws(()=>f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'payment',p.payload.content.payment),/AUTHORITY_CHANGED/);
  }
});
test('expired approvals and stale creators cannot be approved or dispatched',async t=>{
  const f=fixture(t),p=f.approve(await f.create());f.advance(86400_001);
  assert.equal(f.store.payments.get(f.org.id,maker,p.payload.paymentId).approvalValid,false);
  assert.throws(()=>f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'payment',p.payload.content.payment),/AUTHORITY_CHANGED/);
});
test('cancellation requires a replacement proposal and never mutates approved bytes',async t=>{
  const f=fixture(t),p=f.approve(await f.create()),cancelled=f.store.payments.decide(f.org.id,maker,p.payload.paymentId,'cancel',p.version,p.contentHash);
  assert.equal(cancelled.contentHash,p.contentHash);assert.equal(canonical(cancelled.payload),canonical(p.payload));
  assert.throws(()=>f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'payment',p.payload.content.payment),/AUTHORITY_CHANGED/);
  const replacement=await f.create();assert.notEqual(replacement.contentHash,p.contentHash);assert.notEqual(replacement.payload.paymentId,p.payload.paymentId);assert.equal(replacement.state,'pending');
});
test('each reviewed call is reserved once and an ambiguous dispatch never enables a resend or cancellation',async t=>{
  const f=fixture(t),p=f.approve(await f.create()),id=p.payload.paymentId,c=p.payload.content;
  const permit=f.store.payments.authorize(f.org.id,maker,id,p.contentHash,'prerequisite',c.prerequisites[0]);assert.equal(permit.callHash,await sha256(canonical(c.prerequisites[0])));
  assert.throws(()=>f.store.payments.authorize(f.org.id,maker,id,p.contentHash,'prerequisite',c.prerequisites[0]),/CALL_RESERVED/);
  const current=f.store.payments.get(f.org.id,maker,id);assert.throws(()=>f.store.payments.decide(f.org.id,maker,id,'cancel',current.version,current.contentHash),/EXECUTION_RESERVED/);
  f.store.payments.authorize(f.org.id,maker,id,p.contentHash,'payment',c.payment);assert.equal(f.store.payments.get(f.org.id,maker,id).state,'dispatched');
  assert.throws(()=>f.store.payments.authorize(f.org.id,maker,id,p.contentHash,'payment',c.payment),/AUTHORITY_CHANGED/);
  await assert.rejects(()=>f.create(),/NOTE_RESERVED/);
});
test('changed prerequisites are rejected even when semantically valid for the same payout',async t=>{
  const f=fixture(t),p=f.approve(await f.create()),changed={...p.payload.content.prerequisites[0],attachedYoctoNear:'20000000000000000000000'};
  assert.throws(()=>f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'prerequisite',changed),/CALL_CHANGED/);
  assert.equal(f.store.payments.get(f.org.id,maker,p.payload.paymentId).dispatches.length,0);
});
test('duplicate notes and asynchronous session/deadline invalidation cannot create another intent',async t=>{
  const f=fixture(t);await f.create();await assert.rejects(()=>f.create(),/NOTE_RESERVED/);
  const before=f.store.payments.list(f.org.id,maker).length;
  await assert.rejects(async()=>f.store.payments.create(f.org.id,maker,await content(maker,'45'),()=>{throw new Error('Session revoked while preparing');}),/Session revoked/);
  assert.equal(f.store.payments.list(f.org.id,maker).length,before);
});
test('organization restore permanently invalidates payment approvals and preserves dispatch reservations',async t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'corporate-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture(t,resolve(dir,'source.sqlite')),p=f.approve(await f.create());
  f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'prerequisite',p.payload.content.prerequisites[0]);
  const backup=await backupOrganizations(resolve(dir,'source.sqlite'),resolve(dir,'backup.sqlite'),audience),restored=await restoreOrganizations(backup.file,backup.sha256,resolve(dir,'quarantine.sqlite'),audience),review=resolve(dir,'review.json');
  await organizationReviewTemplate(restored.file,review,audience);const v=JSON.parse(readFileSync(review,'utf8'));v.reviewedAt=new Date().toISOString();v.organizations=[{id:f.org.id,ownerAccount:owner,currentVersion:1,members:f.store.members(f.org.id,owner).map(m=>({accountId:m.accountId,role:m.role,currentVersion:m.version}))}];writeFileSync(review,JSON.stringify(v));
  const active=await activateOrganizations(restored.file,review,await fileDigest(review),resolve(dir,'active.sqlite'),audience),store=new OrganizationStore(active.file,audience);t.after(()=>store.close());
  const old=store.payments.get(f.org.id,maker,p.payload.paymentId);assert.equal(old.state,'invalidated');assert.equal(old.approvalValid,false);assert.equal(old.dispatches.length,1);
  assert.throws(()=>store.payments.authorize(f.org.id,maker,p.payload.paymentId,p.contentHash,'payment',p.payload.content.payment),/AUTHORITY_CHANGED/);
});
async function journey(t:{after(fn:()=>void|Promise<void>):void},lost=false){
  const f=fixture(t),p=f.approve(await f.create()),c=p.payload.content;let signatures=0,complete=false;
  const client={request:async(path:string,method='GET',body?:any)=>path.endsWith('/authorize')?f.store.payments.authorize(f.org.id,maker,p.payload.paymentId,body.contentHash,body.kind,body.call):f.store.payments.get(f.org.id,maker,p.payload.paymentId)} as OrganizationClient;
  let saved:string|null=null;const storage:JournalStorage={read:async()=>saved,write:async v=>{saved=v;},exclusive:async action=>action()};
  const journal=new OperationJournal(storage,'public corporate journal fixture');await journal.create();
  const gateway:Gateway={policy:async()=>policy,preflight:async()=>({canPrepare:true,prerequisitesSatisfied:true,prerequisites:[],blockers:[],tokenAmountRequired:'1500',payerTokenBalance:'1000000',checkedAtBlock:{hash:'B'.repeat(44),height:20}}),observe:async()=>({state:complete?'Complete':'NotFound',complete,refunded:false,retryAvailable:false,refundAvailable:false,retryCall:null,refundCall:null,record:complete?{state:'Complete'}:null,checkedAtBlock:{hash:'B'.repeat(44),height:20}}),verify:async transaction=>({status:'final',effect:'accepted',transaction})};
  const wallet:WalletPort={supportsBeforeDispatch:true,identity:async()=>({network:'testnet',accountId:maker}),sign:async(_call,context)=>{await context.beforeDispatch?.();context.authorize?.();signatures++;if(lost)throw new Error('Response lost');return{hash:'B'.repeat(44),signer:maker};}};
  const session=new SettlementSession(journal,gateway,wallet,policy,corporateSettlementGuards(client,p));const op=await session.importPlan({tokenCall:c.payment}),review=await session.review(op.id);
  return{...f,p,c,client,journal,wallet,session,op,review,signatures:()=>signatures,complete:()=>{complete=true;}};
}
test('SDK binds independent approval to durable review, final dispatch and finalized observation',async t=>{
  const f=await journey(t);assert.equal(f.signatures(),0);await f.session.submitReviewed(f.op.id,f.review.callHash!);assert.equal(f.signatures(),1);
  assert.equal(f.store.payments.get(f.org.id,maker,f.p.payload.paymentId).dispatches.length,1);f.complete();assert.equal((await f.session.review(f.op.id)).action,'complete');
});
test('SDK detects changed approved content before import and before any wallet signature',async t=>{
  const f=await journey(t);f.store.changeRole(f.org.id,owner,approver,'viewer',1);
  await assert.rejects(()=>f.session.submitReviewed(f.op.id,f.review.callHash!),/approval/);assert.equal(f.signatures(),0);assert.equal((await f.journal.list())[0].attempts.length,0);
});
test('last-moment corporate gate observes revocation during wallet identity awaits',async t=>{
  const f=await journey(t);f.wallet.sign=async(_call,context)=>{f.store.remove(f.org.id,owner,approver,1);await context.beforeDispatch?.();throw new Error('Provider must not be called');};
  await assert.rejects(()=>f.session.submitReviewed(f.op.id,f.review.callHash!),/AUTHORITY_CHANGED/);assert.equal(f.signatures(),0);assert.equal((await f.journal.list())[0].attempts[0].state,'uncertain');
});
test('wallets without the last-moment hook fail closed before recording a signing intent',async t=>{
  const f=await journey(t);delete f.wallet.supportsBeforeDispatch;await assert.rejects(()=>f.session.submitReviewed(f.op.id,f.review.callHash!),/adapter/);assert.equal((await f.journal.list())[0].attempts.length,0);
});
test('a lost provider response preserves the reservation and journal and never automatically resends',async t=>{
  const f=await journey(t,true);await assert.rejects(()=>f.session.submitReviewed(f.op.id,f.review.callHash!),/Response lost/);assert.equal(f.signatures(),1);assert.equal((await f.session.review(f.op.id)).action,'reconcile');
  await assert.rejects(()=>f.session.submitReviewed(f.op.id,f.review.callHash!));assert.equal(f.signatures(),1);f.complete();assert.equal((await f.session.review(f.op.id)).action,'complete');
});
test('HTTP routes enforce independent approval and reject editable approved payloads',async t=>{
  const f=fixture(t),sessions=new Map<string,string>();for(const person of [maker,approver]){const c=f.store.challenge(person,origin);sessions.set(person,f.store.issueSession(c.id,origin,'public fixture key').token);}
  const server=createOrganizationApi({store:f.store,identity:{currentFullAccessKey:async()=>true},allowedOrigins:[origin]});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/v1/organizations/${f.org.id}/payments`;
  const req=(url:string,actor:string,method='GET',body?:unknown)=>fetch(url,{method,headers:{origin,authorization:`Bearer ${sessions.get(actor)}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const response=await req(base,maker,'POST',await content());assert.equal(response.status,201);const p=await response.json() as CorporatePayment;
  assert.equal((await req(base+'/'+p.payload.paymentId+'/approve',maker,'POST',{version:p.version,contentHash:p.contentHash})).status,403);
  const approved=await req(base+'/'+p.payload.paymentId+'/approve',approver,'POST',{version:p.version,contentHash:p.contentHash});assert.equal(approved.status,200);
  assert.equal((await req(base+'/'+p.payload.paymentId,maker,'PATCH',{...p.payload.content,title:'Changed'})).status,404);
  assert.equal((await req(base+'/'+p.payload.paymentId+'/authorize',maker,'POST',{contentHash:'0'.repeat(64),kind:'payment',call:p.payload.content.payment})).status,409);
});
