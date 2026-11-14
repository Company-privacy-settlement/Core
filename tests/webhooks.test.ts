import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { OrganizationStore } from '../server/organizations/store.js';
import { OrganizationWebhookWorker } from '../server/organizations/webhook-worker.js';
import { publicWebhookAddress, SafeWebhookTransport, webhookUrl, type WebhookSendResult } from '../server/organizations/webhook-transport.js';
import { PaymentWebhookInbox } from '../sdk/webhooks.js';
import { verifyPaymentWebhook, webhookSigningMessage, type WebhookHeaders } from '../sdk/client/webhooks.js';
import { OrganizationClient } from '../sdk/client/organizations.js';
import { OrganizationWebhookClient } from '../sdk/client/webhooks.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { invoiceFixture } from './fixtures/invoices.js';
import { invoiceRoot } from '../sdk/client/invoices.js';
import { domain } from '../sdk/core.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { backupOrganizations, restoreOrganizations, organizationReviewTemplate, activateOrganizations } from '../scripts/lib/organization-backup.js';
import { fileDigest } from '../scripts/lib/index-backup.js';

const audience='https://organization-api.example',origin='https://front.example',destination='https://merchant.example',url=destination+'/hooks/payments',signal=()=>new AbortController().signal;
async function fixture(t:{after(fn:()=>void):void}) {
  const f=await invoiceFixture(1),dir=mkdtempSync(resolve(tmpdir(),'core-webhooks-')),filename=resolve(dir,'live.sqlite');let now=Date.now();
  const policy={...f.policy,network:'testnet' as const},invoice={...f.invoice,policy},signed=await f.signedInvoice(invoice),ring={activeKeyId:'initial',indexKey:randomBytes(32),keys:new Map([['initial',randomBytes(32)]])},secret=randomBytes(32).toString('base64url');
  let store=new OrganizationStore(filename,audience,()=>now,ring,[destination]);const org=store.create(f.payer,'Company');
  const record=(await store.invoices.create(org.id,f.payer,{requestId:randomUUID(),invoice:signed},{currentFullAccessKey:async()=>true},signal())).invoice;
  const endpoint=store.webhooks.create(org.id,f.payer,{requestId:randomUUID(),url,secret}).endpoint;
  const index=new IndexStore(':memory:',policy),source={...f.source,network:'testnet' as const,config:async(b:string)=>({...await f.source.config(b) as object,network:'testnet',domain:domain({network:'testnet',contract:policy.registry,denomination:policy.denomination,version:3,tokenId:policy.tokenId!})}),vaultConfig:async(a:string,b:string)=>({...await f.source.vaultConfig(a,b) as object,network:'testnet'})},indexer=new SettlementIndexer(source,index);
  const payment=async(kind:'withdrawal_requested'|'withdrawal_failed'|'withdrawal_succeeded'='withdrawal_succeeded',link=true)=>{const root=await invoiceRoot(invoice),n=f.records.length;f.state.height++;f.records.push(f.record(n,{kind,commitment:null,nullifier:String(n+1),recipient:f.recipient,disclosure_root:root,timestamp_ns:String(BigInt(Date.parse(invoice.createdAt))*1000000n),protocol_fee_charged:kind==='withdrawal_requested'?'1500':'0',protocol_fee_earned:kind==='withdrawal_succeeded'?'1500':'0',storage_fee_charged:kind==='withdrawal_requested'?'20000000000000000000000':'0'}));await indexer.sync();if(link){f.transactions.set(f.ref.hash,f.transaction());index.enqueue([f.ref]);await indexer.linkPending();}};
  const sent:{headers:Record<string,string>;body:string}[]=[],transport={send:async(_url:string,headers:Record<string,string>,body:string,_s:AbortSignal,check:()=>void)=>{check();sent.push({headers,body});return {status:200,error:null,retryable:false};}},worker=()=>new OrganizationWebhookWorker(store,index,transport);
  const add=(account:string,role:'operator'|'viewer'|'auditor'|'admin')=>{const i=store.invite(org.id,f.payer,account,role);store.respondInvite(i.id,account,true,i.version);};
  t.after(()=>{store.close();index.close();rmSync(dir,{recursive:true,force:true});});
  return {...f,policy,invoice,signed,dir,filename,org,record,endpoint,index,secret,ring,sent,worker,payment,add,get store(){return store;},get now(){return now;},advance:(n:number)=>{now+=n;},reopen:()=>{store.close();store=new OrganizationStore(filename,audience,()=>now,ring,[destination]);},deliveries:()=>store.webhooks.deliveries(org.id,f.payer).items};
}
async function queued(t:{after(fn:()=>void):void}) {const f=await fixture(t);await f.payment();await f.worker().tick(signal());return f;}
function signature(body:string,headers:WebhookHeaders,secret:string){return {...headers,'core-webhook-signature':'v1='+createHmac('sha256',Buffer.from(secret,'base64url')).update(webhookSigningMessage(headers['core-event-id'],headers['core-webhook-timestamp'],headers['core-webhook-key-id'],body)).digest('hex')};}
test('finalized linked payment creates one signed immutable event; repeated scans/restarts do not resend',async t=>{
  const f=await queued(t);assert.equal(f.sent.length,1);assert.equal(f.deliveries()[0].state,'delivered');const sent=f.sent[0],e=await verifyPaymentWebhook(sent.body,sent.headers as WebhookHeaders,[f.secret],{now:f.now,organizationId:f.org.id});assert.equal(e.data.transaction.hash,f.ref.hash);assert.equal(e.data.amountTokens,'1000000');assert.equal(e.type,'invoice.payment_confirmed');assert.equal(sent.body.includes(f.invoice.title),false);
  await f.worker().tick(signal());f.reopen();await f.worker().tick(signal());assert.equal(f.sent.length,1);assert.equal(f.deliveries().length,1);
});
test('requested/failed payouts and unlinked success cannot emit payment confirmations',async t=>{
  const f=await fixture(t);await f.payment('withdrawal_requested');await f.worker().tick(signal());await f.payment('withdrawal_failed');await f.worker().tick(signal());assert.equal(f.sent.length,0);
  await f.payment('withdrawal_succeeded',false);await f.worker().tick(signal());assert.equal(f.sent.length,0);
});
test('concurrent workers atomically reserve a delivery once before sending',async t=>{
  const f=await fixture(t);await f.payment();await Promise.all([f.worker().tick(signal()),f.worker().tick(signal())]);assert.equal(f.sent.length,1);assert.equal(f.deliveries()[0].attempts,1);
});
test('receiver verifies raw body, event ID, timestamp, tenant, key and signature against independent Node HMAC',async t=>{
  const f=await queued(t),{body,headers}=f.sent[0],h=headers as WebhookHeaders;assert.deepEqual(signature(body,h,f.secret),h);
  for(const [b,hh,secrets,now,org] of [[body+' ',h,[f.secret],f.now,f.org.id],[body,{...h,'core-event-id':randomUUID()},[f.secret],f.now,f.org.id],[body,h,[randomBytes(32).toString('base64url')],f.now,f.org.id],[body,h,[f.secret],f.now+301000,f.org.id],[body,h,[f.secret],f.now,randomUUID()]] as const)await assert.rejects(verifyPaymentWebhook(b,hh as WebhookHeaders,[...secrets],{now,organizationId:org}));
});
test('receiver inbox deduplicates retries atomically and rolls back failed business writes',async t=>{
  const f=await queued(t),inbox=new PaymentWebhookInbox(resolve(f.dir,'inbox.sqlite'),f.org.id);t.after(()=>inbox.close());inbox.db.exec('CREATE TABLE payments(event_id TEXT PRIMARY KEY)');const {body,headers}=f.sent[0],apply=(db:typeof inbox.db,e:{id:string})=>{db.prepare('INSERT INTO payments VALUES(?)').run(e.id);};
  await assert.rejects(inbox.accept(body,headers as WebhookHeaders,[f.secret],(db,e)=>{apply(db,e);throw new Error('BUSINESS_FAILED');},f.now),/BUSINESS_FAILED/);assert.equal(inbox.db.prepare('SELECT COUNT(*) n FROM payments').get()!.n,0);
  assert.equal((await inbox.accept(body,headers as WebhookHeaders,[f.secret],apply,f.now)).duplicate,false);assert.equal((await inbox.accept(body,headers as WebhookHeaders,[f.secret],apply,f.now)).duplicate,true);assert.equal(inbox.db.prepare('SELECT COUNT(*) n FROM payments').get()!.n,1);
  const fresh=new PaymentWebhookInbox(':memory:',f.org.id);try{await assert.rejects(fresh.accept(body,headers as WebhookHeaders,[f.secret],async()=>{},f.now));}finally{fresh.close();}
});
test('a signed event ID with conflicting content cannot change an accepted receiver receipt',async t=>{
  const f=await queued(t),inbox=new PaymentWebhookInbox(':memory:',f.org.id);t.after(()=>inbox.close());const {body,headers}=f.sent[0];await inbox.accept(body,headers as WebhookHeaders,[f.secret],()=>{},f.now);const changed=JSON.stringify({...JSON.parse(body),createdAt:new Date(f.now+1).toISOString()});await assert.rejects(inbox.accept(changed,signature(changed,headers as WebhookHeaders,f.secret),[f.secret],()=>{},f.now),/CONTENT_CONFLICT/);
});
test('network errors retry with stable IDs/bodies and fresh signed timestamps; eventual 2xx ends retries',async t=>{
  const f=await fixture(t);await f.payment();const sent:{body:string;headers:Record<string,string>}[]=[];let fail=true;
  const worker=new OrganizationWebhookWorker(f.store,f.index,{send:async(_u,h,b,_s,check)=>{check();sent.push({body:b,headers:h});return fail?{status:503,error:'HTTP_503',retryable:true}:{status:204,error:null,retryable:false};}});
  await worker.tick(signal());assert.equal(f.deliveries()[0].state,'pending');await worker.tick(signal());assert.equal(sent.length,1);f.advance(5000);fail=false;await worker.tick(signal());assert.equal(sent.length,2);assert.equal(sent[0].body,sent[1].body);assert.notEqual(sent[0].headers['core-webhook-timestamp'],sent[1].headers['core-webhook-timestamp']);assert.equal(f.deliveries()[0].state,'delivered');assert.equal(f.store.webhooks.detail(f.org.id,f.payer,f.deliveries()[0].id).attempts.length,2);
});
test('permanent failure and exhausted retries become dead letters; redrive preserves event identity and history',async t=>{
  const f=await fixture(t);await f.payment();await new OrganizationWebhookWorker(f.store,f.index,{send:async()=>({status:400,error:'HTTP_400',retryable:false})}).tick(signal());const dead=f.deliveries()[0];assert.equal(dead.state,'dead');const retry=f.store.webhooks.retry(f.org.id,f.payer,dead.id,dead.version);assert.equal(retry.eventId,dead.eventId);assert.equal(retry.redrives,1);assert.throws(()=>f.store.webhooks.retry(f.org.id,f.payer,dead.id,dead.version),/VERSION_CONFLICT/);
  for(let i=0;i<8;i++){const c=f.store.webhooks.claim();assert.ok(c);f.store.webhooks.finish(c,{status:500,error:'HTTP_500',retryable:true});f.advance(86400000);}
  assert.equal(f.deliveries()[0].state,'dead');assert.equal(f.store.webhooks.detail(f.org.id,f.payer,dead.id).attempts.length,9);
});
test('a crashed in-flight lease is fenced and recovered without resetting its event ID',async t=>{
  const f=await fixture(t);await f.payment();await new OrganizationWebhookWorker(f.store,f.index,{send:async()=>({status:500,error:'HTTP_500',retryable:true})}).tick(signal());f.advance(5000);const first=f.store.webhooks.claim();assert.ok(first);assert.equal(f.store.webhooks.claim(),null);f.advance(30001);const next=f.store.webhooks.claim();assert.ok(next);assert.equal(next.headers['core-event-id'],first.headers['core-event-id']);assert.throws(()=>f.store.webhooks.beforeSend(first),/LEASE_LOST/);assert.equal(f.store.webhooks.finish(first,{status:200,error:null,retryable:false}),false);assert.equal(f.store.webhooks.finish(next,{status:200,error:null,retryable:false}),true);assert.equal(f.deliveries()[0].state,'delivered');
});
test('pause and secret rotation fence a reserved send; resume requires a current version',async t=>{
  const f=await fixture(t);await f.payment();await new OrganizationWebhookWorker(f.store,f.index,{send:async()=>({status:503,error:'HTTP_503',retryable:true})}).tick(signal());f.advance(5000);const claim=f.store.webhooks.claim();assert.ok(claim);const paused=f.store.webhooks.update(f.org.id,f.payer,f.endpoint.id,'pause',{version:1});assert.throws(()=>f.store.webhooks.beforeSend(claim),/ENDPOINT_CHANGED/);f.store.webhooks.finish(claim,{status:null,error:'ENDPOINT_CHANGED',retryable:true});assert.equal(f.store.webhooks.claim(),null);
  assert.throws(()=>f.store.webhooks.update(f.org.id,f.payer,paused.id,'resume',{version:1}),/VERSION_CONFLICT/);const resumed=f.store.webhooks.update(f.org.id,f.payer,paused.id,'resume',{version:paused.version});const secret=randomBytes(32).toString('base64url');f.store.webhooks.update(f.org.id,f.payer,resumed.id,'rotate',{version:resumed.version,secret});f.advance(30000);const rotated=f.store.webhooks.claim();assert.ok(rotated);await verifyPaymentWebhook(rotated.body,rotated.headers as WebhookHeaders,[secret],{now:f.now,organizationId:f.org.id});await assert.rejects(verifyPaymentWebhook(rotated.body,rotated.headers as WebhookHeaders,[f.secret],{now:f.now}));
});
test('endpoint creation is idempotent and conflicts never rotate a signing secret implicitly',async t=>{
  const f=await fixture(t),requestId=randomUUID(),input={requestId,url:destination+'/another',secret:f.secret};const one=f.store.webhooks.create(f.org.id,f.payer,input),two=f.store.webhooks.create(f.org.id,f.payer,input);assert.equal(two.replayed,true);assert.equal(one.endpoint.id,two.endpoint.id);assert.throws(()=>f.store.webhooks.create(f.org.id,f.payer,{...input,url:destination+'/different'}),/IDEMPOTENCY_CONFLICT/);assert.throws(()=>f.store.webhooks.create(f.org.id,f.payer,{...input,requestId:randomUUID(),secret:randomBytes(32).toString('base64url')}),/CONFIGURATION_CHANGED/);
});
test('tenant and role checks protect endpoints, secrets, histories and redrives',async t=>{
  const f=await queued(t);for(const [a,r] of [['viewer.testnet','viewer'],['operator.testnet','operator'],['auditor.testnet','auditor']] as const)f.add(a,r);assert.throws(()=>f.store.webhooks.endpoints(f.org.id,'foreign.testnet'),/ORGANIZATION_NOT_FOUND/);assert.throws(()=>f.store.webhooks.endpoints(f.org.id,'viewer.testnet'),/PERMISSION_DENIED/);assert.equal(f.store.webhooks.deliveries(f.org.id,'auditor.testnet').items.length,1);assert.throws(()=>f.store.webhooks.update(f.org.id,'operator.testnet',f.endpoint.id,'pause',{version:1}),/PERMISSION_DENIED/);assert.equal(JSON.stringify(f.store.webhooks.endpoints(f.org.id,f.payer)).includes(f.secret),false);
});
test('signing secrets, endpoint paths and event bodies remain encrypted in SQLite and WAL',async t=>{
  const f=await queued(t);for(const suffix of ['','-wal']){const data=readFileSync(f.filename+suffix);assert.equal(data.includes(Buffer.from(f.secret)),false);assert.equal(data.includes(Buffer.from(url)),false);assert.equal(data.includes(Buffer.from(f.sent[0].body)),false);}assert.equal(JSON.stringify(f.store.auditPage(f.org.id,f.payer)).includes(f.secret),false);
});
test('webhook destination allowlist rejects unsafe schemes, credentials, queries, IP literals and ports',()=>{
  for(const value of ['http://merchant.example/x','https://127.0.0.1/x','https://[::1]/x','https://merchant.example:444/x','https://user:pass@merchant.example/x','https://merchant.example/x?token=1','https://merchant.example/x#secret','https://evil.example/x'])assert.throws(()=>webhookUrl(value,new Set([destination])));
  assert.equal(webhookUrl(url,new Set([destination])),url);
});
test('private/reserved IPv4 and IPv6 destinations cannot pass DNS validation',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.2.1','192.168.1.1','169.254.169.254','100.100.100.200','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicWebhookAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicWebhookAddress(ip),true,ip);
});
test('sender rejects mixed DNS answers and never opens HTTPS after cancellation or final authorization failure',async()=>{
  let opened=0;const https=(()=>{opened++;throw new Error('must not open');}) as typeof request;
  const mixed=(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]) as unknown as typeof lookup;
  assert.equal((await new SafeWebhookTransport(new Set([destination]),mixed,https).send(url,{},'{}',signal(),()=>{})).error,'DESTINATION_BLOCKED');
  const dns=(async()=>[{address:'8.8.8.8',family:4}]) as unknown as typeof lookup;
  await new SafeWebhookTransport(new Set([destination]),dns,https).send(url,{},'{}',signal(),()=>{throw new Error('WEBHOOK_LEASE_LOST');});const c=new AbortController();c.abort();await new SafeWebhookTransport(new Set([destination]),dns,https).send(url,{},'{}',c.signal,()=>{});assert.equal(opened,0);
});
test('HTTPS sender pins the validated address, keeps hostname TLS verification and does not follow redirects',async()=>{
  let opened=0,pinned='';const https=((_u:unknown,options:any,callback:any)=>{opened++;assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'merchant.example');assert.equal(options.agent,false);assert.equal(options.autoSelectFamily,false);options.lookup('merchant.example',{},(_e:unknown,ip:string)=>{pinned=ip;});const req=new EventEmitter() as EventEmitter&{end:(b:string)=>void};req.end=()=>{setImmediate(()=>callback({statusCode:302,headers:{location:'https://127.0.0.1'},destroy:()=>{}}));};return req;}) as unknown as typeof request;
  const dns=(async()=>[{address:'8.8.8.8',family:4}]) as unknown as typeof lookup,result=await new SafeWebhookTransport(new Set([destination]),dns,https).send(url,{},'{}',signal(),()=>{});assert.equal(opened,1);assert.equal(pinned,'8.8.8.8');assert.equal(result.status,302);assert.equal(result.retryable,false);
});
test('queue retries continue even if the finalized index is temporarily unavailable',async t=>{
  const f=await fixture(t);await f.payment();await new OrganizationWebhookWorker(f.store,f.index,{send:async()=>({status:503,error:'HTTP_503',retryable:true})}).tick(signal());f.advance(5000);const broken={policy:f.policy,status:()=>{throw new Error('INDEX_OFFLINE');},activity:()=>{throw new Error('INDEX_OFFLINE');}};await assert.rejects(new OrganizationWebhookWorker(f.store,broken,{send:async()=>({status:200,error:null,retryable:false})}).tick(signal()));assert.equal(f.deliveries()[0].state,'delivered');
});
test('backup recovery pauses callbacks and holds queued sends until current admin review and explicit retry',async t=>{
  const f=await fixture(t);await f.payment();await new OrganizationWebhookWorker(f.store,f.index,{send:async()=>({status:500,error:'HTTP_500',retryable:true})}).tick(signal());const saved=await backupOrganizations(f.filename,resolve(f.dir,'backup.sqlite'),audience),restored=await restoreOrganizations(saved.file,saved.sha256,resolve(f.dir,'restore.sqlite'),audience),review=resolve(f.dir,'review.json');await organizationReviewTemplate(restored.file,review,audience);const input=JSON.parse(readFileSync(review,'utf8'));input.reviewedAt=new Date().toISOString();input.organizations=[{id:f.org.id,ownerAccount:f.payer,currentVersion:1,members:[{accountId:f.payer,role:'owner',currentVersion:1}]}];writeFileSync(review,JSON.stringify(input),{mode:0o600});const active=await activateOrganizations(restored.file,review,await fileDigest(review),resolve(f.dir,'active.sqlite'),audience),s=new OrganizationStore(active.file,audience,()=>f.now,f.ring,[destination]);try{assert.equal(s.webhooks.endpoints(f.org.id,f.payer)[0].state,'paused');const held=s.webhooks.deliveries(f.org.id,f.payer).items[0];assert.equal(held.state,'held');assert.equal(s.webhooks.claim(),null);const e=s.webhooks.endpoints(f.org.id,f.payer)[0];s.webhooks.update(f.org.id,f.payer,e.id,'resume',{version:e.version});assert.equal(s.webhooks.claim(),null);s.webhooks.retry(f.org.id,f.payer,held.id,held.version);const c=s.webhooks.claim();assert.ok(c);assert.equal(c.headers['core-event-id'],held.eventId);}finally{s.close();}
});
test('organization HTTP webhook API authenticates, validates queries, hides secrets and exposes delivery histories',async t=>{
  const f=await queued(t),server=createOrganizationApi({store:f.store,identity:{currentFullAccessKey:async()=>true},allowedOrigins:[origin],ratePoints:1000});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/organizations/${f.org.id}/webhooks`,c=f.store.challenge(f.payer,origin),session=f.store.issueSession(c.id,origin,'fixture'),headers={origin,authorization:`Bearer ${session.token}`,'content-type':'application/json'};
  assert.equal((await fetch(base,{headers:{origin}})).status,401);const list=await fetch(base,{headers});assert.equal(list.headers.get('cache-control'),'no-store');assert.equal((await list.text()).includes(f.secret),false);assert.equal((await fetch(base+'/deliveries?before=2',{headers})).status,200);assert.equal((await fetch(base+'/deliveries?before=1&before=2',{headers})).status,400);assert.equal((await fetch(base+'/deliveries/'+f.deliveries()[0].id,{headers})).status,200);assert.equal((await fetch(base+'/'+f.endpoint.id+'/pause',{method:'POST',headers,body:'{"version":1}'})).status,200);
});
test('browser client keeps webhook credentials out of URL/query parameters and accepts bounded delivery pagination',async t=>{
  const old=globalThis.fetch,calls:{url:string;init?:RequestInit}[]=[];globalThis.fetch=(async(u,i)=>{calls.push({url:String(u),init:i});return Response.json({items:[],nextCursor:null});}) as typeof fetch;t.after(()=>{globalThis.fetch=old;});const client=new OrganizationWebhookClient(new OrganizationClient(audience,'session'),randomUUID());await client.deliveries(50);assert.ok(calls[0].url.endsWith('/webhooks/deliveries?before=50'));assert.equal(calls[0].init!.cache,'no-store');assert.throws(()=>client.deliveries(-1));
});
test('new callbacks catch up on history using the original immutable event, without replaying successful old deliveries',async t=>{
  const f=await queued(t);f.store.webhooks.create(f.org.id,f.payer,{requestId:randomUUID(),url:destination+'/second',secret:randomBytes(32).toString('base64url')});await f.worker().tick(signal());assert.equal(f.sent.length,2);assert.equal(f.sent[0].body,f.sent[1].body);assert.equal(f.deliveries().length,2);assert.equal(new Set(f.deliveries().map(d=>d.eventId)).size,1);
});
test('stale or incomplete finalized index coverage does not create payment webhooks',async t=>{
  const f=await fixture(t);await f.payment();const limited={policy:f.policy,status:()=>f.index.status(),activity:(input:Parameters<typeof f.index.activity>[0])=>{const value=f.index.activity(input) as any;value.index.checkpoint.sourceRecordCount++;return value;}};
  await new OrganizationWebhookWorker(f.store,limited,{send:async()=>{throw new Error('must not send');}}).tick(signal());assert.equal(f.deliveries().length,0);f.advance(600000);await f.worker().tick(signal());assert.equal(f.sent.length,0);assert.equal(f.deliveries().length,0);
});

test('tampered encrypted event indexes cannot produce another logical payment notification',async t=>{
  const f=await queued(t),db=new DatabaseSync(f.filename);db.prepare("UPDATE organization_webhook_events SET identity_hash=?").run('00'.repeat(32));db.close();await assert.rejects(f.worker().tick(signal()),/WEBHOOK_DECRYPTION_FAILED/);assert.equal(f.sent.length,1);assert.equal(f.deliveries().length,1);
});
