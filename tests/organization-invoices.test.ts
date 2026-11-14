import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { OrganizationStore } from '../server/organizations/store.js';
import { loadInvoiceKeys, type InvoiceKeys } from '../server/organizations/invoice-keys.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { OrganizationClient } from '../sdk/client/organizations.js';
import { OrganizationInvoiceClient } from '../sdk/client/organization-invoices.js';
import { invoiceFixture } from './fixtures/invoices.js';
import { activateOrganizations, backupOrganizations, organizationReviewTemplate, restoreOrganizations } from '../scripts/lib/organization-backup.js';
import { fileDigest } from '../scripts/lib/index-backup.js';

const audience='https://organization-api.example',origin='https://front.example';
const identity={currentFullAccessKey:async()=>true};
const signal=()=>new AbortController().signal;
function keys():InvoiceKeys { return {activeKeyId:'initial',indexKey:randomBytes(32),keys:new Map([['initial',randomBytes(32)]])}; }
async function fixture(t:{after(fn:()=>void):void},enabled=true) {
  const base=await invoiceFixture();
  const invoice={...base.invoice,policy:{...base.invoice.policy,network:'testnet' as const}};
  const f={...base,invoice,signed:await base.signedInvoice(invoice),signedInvoice:(value=invoice)=>base.signedInvoice(value)};
  const dir=mkdtempSync(resolve(tmpdir(),'core-organization-invoices-')),filename=resolve(dir,'live.sqlite'),ring=keys();
  let store=new OrganizationStore(filename,audience,Date.now,enabled?ring:undefined);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const org=store.create(f.payer,'Company'),other=store.create('foreign.testnet','Other');
  const save=(invoice=f.signed,requestId=randomUUID(),id=org.id,actor=f.payer,source=identity,check=()=>{},s=signal())=>store.invoices.create(id,actor,{requestId,invoice},source,s,check);
  const reopen=(k:InvoiceKeys)=>{store.close();store=new OrganizationStore(filename,audience,Date.now,k);return store;};
  const add=(account:string,role:'operator'|'viewer'|'auditor'|'admin')=>{const i=store.invite(org.id,f.payer,account,role);store.respondInvite(i.id,account,true,i.version);};
  return {...f,dir,filename,ring,org,other,get store(){return store;},save,reopen,add};
}
test('organization invoice save/list/get stores the exact signed immutable request',async t=>{
  const f=await fixture(t),saved=await f.save();
  assert.equal(saved.replayed,false);assert.deepEqual(saved.invoice.invoice,f.signed);
  assert.equal(saved.invoice.createdBy,f.payer);assert.equal(saved.invoice.organizationId,f.org.id);
  assert.deepEqual(f.store.invoices.get(f.org.id,f.payer,saved.invoice.id),saved.invoice);
  assert.deepEqual(f.store.invoices.list(f.org.id,f.payer),{items:[saved.invoice],nextCursor:null});
  f.reopen(f.ring);assert.deepEqual(f.store.invoices.get(f.org.id,f.payer,saved.invoice.id),saved.invoice);
});
test('same idempotency key and reordered JSON return one record and one audit event',async t=>{
  const f=await fixture(t),request=randomUUID(),one=await f.save(f.signed,request);
  const reversed=JSON.parse(JSON.stringify({signature:f.signed.signature,invoice:f.signed.invoice}));
  const two=await f.save(reversed,request);assert.equal(two.replayed,true);assert.equal(two.invoice.id,one.invoice.id);
  assert.equal(f.store.auditPage(f.org.id,f.payer).items.filter(a=>a.action==='invoice.created').length,1);
});
test('new request identifiers cannot duplicate an existing signed invoice',async t=>{
  const f=await fixture(t),results=await Promise.all(Array.from({length:8},()=>f.save()));
  assert.equal(results.filter(r=>!r.replayed).length,1);assert.equal(new Set(results.map(r=>r.invoice.id)).size,1);
  assert.equal(f.store.invoices.list(f.org.id,f.payer).items.length,1);
});
test('reusing a request identifier with other signed terms fails without mutation',async t=>{
  const f=await fixture(t),request=randomUUID(),one=await f.save(f.signed,request);
  const changed=await f.signedInvoice({...f.invoice,id:randomUUID(),title:'Different request'});
  await assert.rejects(f.save(changed,request),/IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(f.store.invoices.list(f.org.id,f.payer).items,[one.invoice]);
});
test('changed signed terms under the same merchant invoice ID are rejected',async t=>{
  const f=await fixture(t);await f.save();
  await assert.rejects(f.save(await f.signedInvoice({...f.invoice,reference:'Changed terms'})),/INVOICE_CONFLICT/);
});
test('tenant scoping hides foreign records and denies nonmembers before storage checks',async t=>{
  const f=await fixture(t),saved=await f.save();
  assert.throws(()=>f.store.invoices.get(f.org.id,'foreign.testnet',saved.invoice.id),/ORGANIZATION_NOT_FOUND/);
  assert.throws(()=>f.store.invoices.get(f.other.id,'foreign.testnet',saved.invoice.id),/INVOICE_NOT_FOUND/);
  assert.deepEqual(f.store.invoices.list(f.other.id,'foreign.testnet').items,[]);
  await assert.rejects(f.save(f.signed,randomUUID(),f.other.id),/ORGANIZATION_NOT_FOUND/);
});
test('viewer cannot read; auditor can read but cannot create; revoked operator loses access',async t=>{
  const f=await fixture(t);for(const [a,r] of [['viewer.testnet','viewer'],['auditor.testnet','auditor'],['operator.testnet','operator']] as const)f.add(a,r);
  const saved=await f.save();assert.throws(()=>f.store.invoices.list(f.org.id,'viewer.testnet'),/PERMISSION_DENIED/);
  assert.equal(f.store.invoices.get(f.org.id,'auditor.testnet',saved.invoice.id).id,saved.invoice.id);
  await assert.rejects(f.save(f.signed,randomUUID(),f.org.id,'auditor.testnet'),/PERMISSION_DENIED/);
  assert.equal(f.store.invoices.list(f.org.id,'operator.testnet').items.length,1);
  f.store.remove(f.org.id,f.payer,'operator.testnet',1);assert.throws(()=>f.store.invoices.list(f.org.id,'operator.testnet'),/ORGANIZATION_NOT_FOUND/);
});
test('unconfigured encryption fails closed without disabling other organization features',async t=>{
  const f=await fixture(t,false);await assert.rejects(f.save(),/INVOICE_STORAGE_DISABLED/);
  assert.throws(()=>f.store.invoices.list(f.org.id,f.payer),/INVOICE_STORAGE_DISABLED/);
  assert.equal(f.store.detail(f.org.id,f.payer).id,f.org.id);
});
test('invalid signature and authenticated actor mismatch cannot create an invoice',async t=>{
  const f=await fixture(t);await assert.rejects(f.save({...f.signed,invoice:{...f.invoice,title:'Tampered'}}),/INVALID_INVOICE_SIGNATURE/);
  f.add('operator.testnet','operator');await assert.rejects(f.save(f.signed,randomUUID(),f.org.id,'operator.testnet'),/INVOICE_MERCHANT_MISMATCH/);
  assert.equal(f.store.invoices.list(f.org.id,f.payer).items.length,0);
});
test('first creation requires current merchant FullAccess key; historical exact replay survives rotation',async t=>{
  const f=await fixture(t),revoked={currentFullAccessKey:async()=>false};
  await assert.rejects(f.save(f.signed,randomUUID(),f.org.id,f.payer,revoked),/INVOICE_KEY_REVOKED/);
  const one=await f.save();assert.equal((await f.save(f.signed,randomUUID(),f.org.id,f.payer,revoked)).invoice.id,one.invoice.id);
});
test('request cancellation during merchant key lookup prevents late writes',async t=>{
  const f=await fixture(t),controller=new AbortController();let release!:(v:boolean)=>void;
  const pending=f.save(f.signed,randomUUID(),f.org.id,f.payer,{currentFullAccessKey:()=>new Promise(r=>{release=r;})},()=>{},controller.signal);
  while(!release)await new Promise(r=>setImmediate(r));controller.abort();release(true);
  await assert.rejects(pending);assert.equal(f.store.invoices.list(f.org.id,f.payer).items.length,0);
});
test('session/role recheck runs inside final transaction after asynchronous verification',async t=>{
  const f=await fixture(t);let n=0;
  await assert.rejects(f.save(f.signed,randomUUID(),f.org.id,f.payer,identity,()=>{if(++n===2)throw new Error('SESSION_INVALID');}),/SESSION_INVALID/);
  assert.equal(f.store.invoices.list(f.org.id,f.payer).items.length,0);
});
test('invoice terms, signatures, request IDs and natural IDs are absent from SQLite and WAL plaintext',async t=>{
  const f=await fixture(t),request=randomUUID();await f.save(f.signed,request);
  for(const suffix of ['','-wal']) {
    const bytes=readFileSync(f.filename+suffix);
    for(const sensitive of [f.invoice.title,f.invoice.reference,f.invoice.recipient,f.invoice.id,f.invoice.nonce,f.signed.signature.signature,request])assert.equal(bytes.includes(Buffer.from(sensitive)),false,`${suffix}: ${sensitive}`);
  }
  const db=new DatabaseSync(f.filename,{readOnly:true});try {
    const r=db.prepare('SELECT * FROM organization_invoices').get()!;
    assert.equal((r.nonce as Uint8Array).length,12);assert.equal((r.tag as Uint8Array).length,16);
  }finally{db.close();}
});
test('ciphertext and authenticated metadata tampering fail closed; foreign tenants cannot probe integrity',async t=>{
  const f=await fixture(t),one=await f.save(),db=new DatabaseSync(f.filename);
  db.prepare('UPDATE organization_invoices SET created=created+1 WHERE id=?').run(one.invoice.id);db.close();
  assert.throws(()=>f.store.invoices.get(f.org.id,f.payer,one.invoice.id),/INVOICE_DECRYPTION_FAILED/);
  assert.throws(()=>f.store.invoices.get(f.org.id,'foreign.testnet',one.invoice.id),/ORGANIZATION_NOT_FOUND/);
});
test('copying ciphertext to another organization cannot bypass authenticated tenant binding',async t=>{
  const f=await fixture(t),one=await f.save(),db=new DatabaseSync(f.filename);
  db.prepare('UPDATE organization_invoices SET org=? WHERE id=?').run(f.other.id,one.invoice.id);db.close();
  assert.throws(()=>f.store.invoices.get(f.other.id,'foreign.testnet',one.invoice.id),/INVOICE_DECRYPTION_FAILED/);
});
test('wrong index key, wrong data key and missing historic decryption keys refuse startup',async t=>{
  const f=await fixture(t);await f.save();
  for(const ring of [{...f.ring,indexKey:randomBytes(32)},{...f.ring,keys:new Map([['initial',randomBytes(32)]])},{...f.ring,activeKeyId:'next',keys:new Map([['next',randomBytes(32)]])}]) {
    assert.throws(()=>new OrganizationStore(f.filename,audience,Date.now,ring),/Invoice/);
  }
  assert.equal(f.store.invoices.list(f.org.id,f.payer).items.length,1);
});
test('key rotation encrypts new records with active key and preserves older reads',async t=>{
  const f=await fixture(t),one=await f.save(),rotated={...f.ring,activeKeyId:'next',keys:new Map([...f.ring.keys,['next',randomBytes(32)] as const])};f.reopen(rotated);
  const two=await f.save(await f.signedInvoice({...f.invoice,id:randomUUID()}));
  assert.equal(f.store.invoices.get(f.org.id,f.payer,one.invoice.id).id,one.invoice.id);
  assert.equal(f.store.invoices.get(f.org.id,f.payer,two.invoice.id).id,two.invoice.id);
  const db=new DatabaseSync(f.filename,{readOnly:true});try{assert.deepEqual(db.prepare('SELECT key_id FROM organization_invoices ORDER BY sequence').all().map(r=>r.key_id),['initial','next']);}finally{db.close();}
});
test('organization pagination is stable, bounded and excludes foreign records',async t=>{
  const f=await fixture(t);for(let i=0;i<52;i++)await f.save(await f.signedInvoice({...f.invoice,id:randomUUID()}));
  const page=f.store.invoices.list(f.org.id,f.payer);assert.equal(page.items.length,50);assert.equal(page.nextCursor,3);
  const next=f.store.invoices.list(f.org.id,f.payer,page.nextCursor!);assert.deepEqual(next.items.map(r=>r.sequence),[2,1]);assert.equal(next.nextCursor,null);
  assert.throws(()=>f.store.invoices.list(f.org.id,f.payer,NaN),/INVALID_CURSOR/);
});
test('key-file generator creates protected independent keys, refuses overwrite, and never prints secrets',async t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'core-invoice-keys-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=resolve(dir,'service.invoice-keys.json');
  const stdout=execFileSync(process.execPath,['scripts/organization-invoice-keys.mjs',path],{encoding:'utf8'}),ring=loadInvoiceKeys(path),raw=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(ring.keys.get('initial')!.length,32);assert.equal(ring.indexKey.length,32);assert.equal(stdout.includes(raw.indexKey),false);assert.equal(stdout.includes(raw.keys.initial),false);
  assert.notEqual(spawnSync(process.execPath,['scripts/organization-invoice-keys.mjs',path]).status,0);
  assert.equal(loadInvoiceKeys(path).indexKey.toString('hex'),ring.indexKey.toString('hex'));
  const link=resolve(dir,'symlink');symlinkSync(path,link);assert.throws(()=>loadInvoiceKeys(link));
  chmodSync(path,0o644);assert.throws(()=>loadInvoiceKeys(path),/owner-only|Invalid/);
  chmodSync(path,0o600);writeFileSync(path,JSON.stringify({...raw,unexpected:'field'}));assert.throws(()=>loadInvoiceKeys(path),/Invalid/);
});
test('encrypted invoices survive quarantined backup and reviewed ACL restoration without restoring sessions',async t=>{
  const f=await fixture(t),saved=await f.save(),c=f.store.challenge(f.payer,origin),session=f.store.issueSession(c.id,origin,'fixture');
  f.add('removed.testnet','operator');
  const snapshot=await backupOrganizations(f.filename,resolve(f.dir,'backup.sqlite'),audience);
  assert.equal(readFileSync(snapshot.file).includes(Buffer.from(f.invoice.reference)),false);
  const restored=await restoreOrganizations(snapshot.file,snapshot.sha256,resolve(f.dir,'restored.sqlite'),audience);
  const review=resolve(f.dir,'review.json');await organizationReviewTemplate(restored.file,review,audience);
  const value=JSON.parse(readFileSync(review,'utf8')),org=f.store.detail(f.org.id,f.payer),other=f.store.detail(f.other.id,'foreign.testnet');
  value.reviewedAt=new Date().toISOString();value.organizations=[org,other].map(o=>({id:o.id,ownerAccount:o.ownerAccount,currentVersion:o.version,members:[{accountId:o.ownerAccount,role:'owner',currentVersion:1}]}));
  writeFileSync(review,JSON.stringify(value),{mode:0o600});
  const live=await activateOrganizations(restored.file,review,await fileDigest(review),resolve(f.dir,'activated.sqlite'),audience);
  const store=new OrganizationStore(live.file,audience,Date.now,f.ring);try {
    assert.deepEqual(store.invoices.get(f.org.id,f.payer,saved.invoice.id),saved.invoice);
    assert.throws(()=>store.session(session.token,origin),/SESSION_INVALID/);
    assert.throws(()=>store.invoices.list(f.org.id,'removed.testnet'),/ORGANIZATION_NOT_FOUND/);
    assert.equal((await store.invoices.create(f.org.id,f.payer,{requestId:randomUUID(),invoice:f.signed},identity,signal())).replayed,true);
  }finally{store.close();}
});
test('HTTP invoice API enforces authentication, strict inputs, no-store and idempotent status codes',async t=>{
  const f=await fixture(t),server=createOrganizationApi({store:f.store,identity,allowedOrigins:[origin],ratePoints:1000});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`,path=`/v1/organizations/${f.org.id}/invoices`;
  const c=f.store.challenge(f.payer,origin),session=f.store.issueSession(c.id,origin,f.publicKey),headers={origin,authorization:`Bearer ${session.token}`,'content-type':'application/json'},body=JSON.stringify({requestId:randomUUID(),invoice:f.signed});
  assert.equal((await fetch(base+path,{headers:{origin}})).status,401);
  const created=await fetch(base+path,{method:'POST',headers,body});assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');const one=await created.json();
  assert.equal((await fetch(base+path,{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(base+path+'?before=1&before=2',{headers})).status,400);
  assert.equal((await fetch(base+path+'?before=9007199254740992',{headers})).status,400);
  assert.equal((await fetch(base+path+'/'+one.invoice.id+'?before=1',{headers})).status,400);
  assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),invoice:f.signed,secret:'unknown'})})).status,400);
  assert.equal((await fetch(base+path+'/'+one.invoice.id,{headers})).status,200);
  f.store.logout(session.token);assert.equal((await fetch(base+path,{headers})).status,401);
});
test('browser invoice client builds scoped paths, paginates and propagates cancellation without persistence',async t=>{
  const original=globalThis.fetch,requests:{url:string;init?:RequestInit}[]=[];
  globalThis.fetch=(async(url,init)=>{requests.push({url:String(url),init});return Response.json({items:[],nextCursor:null});}) as typeof fetch;t.after(()=>{globalThis.fetch=original;});
  const org=randomUUID(),client=new OrganizationInvoiceClient(new OrganizationClient('https://org.example','memory-token'),org),controller=new AbortController();
  await client.list(50,controller.signal);assert.equal(requests[0].url,`https://org.example/v1/organizations/${org}/invoices?before=50`);assert.equal(requests[0].init!.cache,'no-store');assert.ok(requests[0].init!.signal);
  assert.throws(()=>client.list(-1));assert.throws(()=>new OrganizationInvoiceClient(new OrganizationClient('https://org.example'),'../other'));
});
