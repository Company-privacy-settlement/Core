import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const env = { ...process.env };
delete env.CORE_ORGANIZATION_ORIGIN;
const denied = spawnSync(process.execPath, ['dist/service/scripts/organization-server.js'], { env, encoding: 'utf8' });
assert.notEqual(denied.status, 0, 'compiled service must refuse missing audience');
const directory = mkdtempSync(resolve(tmpdir(), 'core-organization-runtime-'));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const address = reservation.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
await new Promise<void>(r => reservation.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
const keyFile=resolve(directory,'runtime.invoice-keys.json');
const generated=spawnSync(process.execPath,['scripts/organization-invoice-keys.mjs',keyFile],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
env.CORE_ORGANIZATION_INVOICE_KEYS_FILE=keyFile;
let child: ReturnType<typeof spawn> | undefined;
try {
  for (let round = 0; round < 2; round++) {
    child = spawn(process.execPath, ['dist/service/scripts/organization-server.js'], { env: { ...env, PORT: String(port), CORE_ORGANIZATION_HOST: '127.0.0.1', CORE_ORGANIZATION_ORIGIN: origin, CORE_ORGANIZATION_DB: resolve(directory, 'organization.sqlite'), CORE_ORGANIZATION_ALLOWED_ORIGINS: 'http://localhost:3000', CORE_ORGANIZATION_RPC_URL: 'https://rpc.testnet.near.org' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr?.on('data', b => { errors += String(b); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(errors);
      try { const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(500) }); if (response.status === 200) { ready = true; break; } } catch {}
      await delay(30);
    }
    assert.equal(ready, true, errors);
    const denied = await fetch(origin + '/v1/organizations', { headers: { origin: 'http://localhost:3000' } }); assert.equal(denied.status, 401);
    const challenge = await fetch(origin + '/v1/auth/challenge', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'fixture.testnet' }) });
    assert.equal(challenge.status, 200); const body = await challenge.json() as { audience: string }; assert.equal(body.audience, origin);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const result = await Promise.race([exited, delay(7000).then(() => { throw new Error('Organization shutdown timeout'); })]); assert.equal(result[0], 0); child = undefined;
  }
  const live = resolve(directory, 'organization.sqlite'), backup = resolve(directory, 'backup.sqlite'), quarantine = resolve(directory, 'quarantine.sqlite'), active = resolve(directory, 'active.sqlite'), review = resolve(directory, 'review.json');
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { OrganizationStore } from './dist/service/server/organizations/store.js';
    import { loadInvoiceKeys } from './dist/service/server/organizations/invoice-keys.js';
    import { invoiceHash, invoiceSigningDigest } from './dist/service/sdk/client/invoices.js';
    import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
    import bs58 from 'bs58';
    import { shaField } from './dist/service/sdk/client/crypto.js';
    const s=new OrganizationStore(process.env.CORE_ORGANIZATION_DB,process.env.CORE_ORGANIZATION_ORIGIN,Date.now,loadInvoiceKeys(process.env.CORE_ORGANIZATION_INVOICE_KEYS_FILE));
    const o=s.create('owner.testnet','Runtime recovery fixture');
    const i=s.invite(o.id,'owner.testnet','old-admin.testnet','admin');s.respondInvite(i.id,'old-admin.testnet',true,i.version);
    s.invite(o.id,'old-admin.testnet','pending.testnet','viewer');
    const c=s.challenge('old-admin.testnet','http://localhost:3000');s.issueSession(c.id,'http://localhost:3000','public fixture key');
    const policy={network:'testnet',registry:'forest.testnet',denomination:'1000000',tokenId:'usdc.testnet',feeRecipient:'treasury.testnet',registryWasmSha256:'aa'.repeat(32),vaultWasmSha256:'bb'.repeat(32),verifierSha256:'cc'.repeat(32)};
    const vault='v'+'a'.repeat(32)+'.forest.testnet',recipient='recipient.testnet',root='dd'.repeat(32);
    const domain=await shaField('core:ft:v3|testnet|forest.testnet|usdc.testnet|1000000'),context=await shaField('core:action:ft:v3|'+domain+'|withdraw|'+vault+'|'+recipient+'|'+root);
    const payment=await s.payments.create(o.id,'owner.testnet',{format:'core-corporate-payment-v1',title:'Compiled corporate fixture',policy,payer:'owner.testnet',payment:{contract:policy.tokenId,method:'ft_transfer_call',gas:'300000000000000',attachedYoctoNear:'1',args:{receiver_id:policy.registry,amount:'1500',msg:JSON.stringify({vault,recipient,disclosure_root:root,proof:Buffer.alloc(256).toString('base64'),public_inputs:['42','1','1',context,domain]})}},prerequisites:[]});
    let selfDenied=false;try{s.payments.decide(o.id,'owner.testnet',payment.payload.paymentId,'approve',payment.version,payment.contentHash);}catch{selfDenied=true;}if(!selfDenied)throw new Error('Self approval accepted');
    const approved=s.payments.decide(o.id,'old-admin.testnet',payment.payload.paymentId,'approve',payment.version,payment.contentHash);
    s.payments.authorize(o.id,'owner.testnet',payment.payload.paymentId,approved.contentHash,'payment',approved.payload.content.payment);
    const pair=generateKeyPairSync('ed25519'),publicKey='ed25519:'+bs58.encode(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32));
    const terms={version:1,id:randomUUID(),merchantAccount:'owner.testnet',recipient,title:'Runtime encrypted invoice',reference:'CONFIDENTIAL-RUNTIME-REFERENCE',policy,units:1,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),nonce:'ab'.repeat(32)};
    const signature=sign(null,await invoiceSigningDigest(await invoiceHash(terms),'testnet',terms.nonce),pair.privateKey).toString('base64');
    const invoice=await s.invoices.create(o.id,'owner.testnet',{requestId:terms.id,invoice:{invoice:terms,signature:{accountId:'owner.testnet',publicKey,signature}}},{currentFullAccessKey:async()=>true},new AbortController().signal);
    s.close();console.log(JSON.stringify({id:o.id,paymentId:payment.payload.paymentId,invoiceId:invoice.invoice.id}));
  `], { env: { ...env, CORE_ORGANIZATION_DB: live, CORE_ORGANIZATION_ORIGIN: origin }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr); const org = JSON.parse(seed.stdout);
  const maintenance = (mode: string, db: string, args: string[]) => spawnSync(process.execPath, ['scripts/organization-maintenance.mjs', mode, ...args], { env: { ...env, CORE_ORGANIZATION_DB: db, CORE_ORGANIZATION_ORIGIN: origin }, encoding: 'utf8' });
  const saved = maintenance('backup',live,[backup]); assert.equal(saved.status,0,saved.stderr); const metadata=JSON.parse(saved.stdout);
  const deniedRestore=maintenance('restore',quarantine,[backup,'0'.repeat(64)]); assert.notEqual(deniedRestore.status,0); assert.equal(existsSync(quarantine),false);
  assert.equal(readFileSync(backup).includes(Buffer.from('CONFIDENTIAL-RUNTIME-REFERENCE')),false);
  const restored=maintenance('restore',quarantine,[backup,metadata.sha256]); assert.equal(restored.status,0,restored.stderr);
  const cannotServe = spawnSync(process.execPath, ['dist/service/scripts/organization-server.js'], {env:{...env,PORT:String(port),CORE_ORGANIZATION_DB:quarantine,CORE_ORGANIZATION_ORIGIN:origin,CORE_ORGANIZATION_ALLOWED_ORIGINS:'http://localhost:3000'},encoding:'utf8'});
  assert.notEqual(cannotServe.status,0); assert.match(cannotServe.stderr,/access review/);
  const template=maintenance('review-template',quarantine,[review]); assert.equal(template.status,0,template.stderr);
  const approved=JSON.parse(readFileSync(review,'utf8')); assert.equal(approved.organizations[0].ownerAccount,''); assert.deepEqual(approved.organizations[0].members,[]);
  approved.reviewedAt=new Date().toISOString(); approved.organizations=[{id:org.id,ownerAccount:'owner.testnet',currentVersion:1,members:[{accountId:'owner.testnet',role:'owner',currentVersion:1}]}];
  writeFileSync(review,JSON.stringify(approved));const reviewHash=createHash('sha256').update(readFileSync(review)).digest('hex');
  const activated=maintenance('activate',active,[quarantine,review,reviewHash]); assert.equal(activated.status,0,activated.stderr);
  const readInvoice=spawnSync(process.execPath,['--input-type=module','-e',`
    import { OrganizationStore } from './dist/service/server/organizations/store.js';
    import { loadInvoiceKeys } from './dist/service/server/organizations/invoice-keys.js';
    const s=new OrganizationStore(process.env.CORE_ORGANIZATION_DB,process.env.CORE_ORGANIZATION_ORIGIN,Date.now,loadInvoiceKeys(process.env.CORE_ORGANIZATION_INVOICE_KEYS_FILE));
    const list=s.invoices.list('${org.id}','owner.testnet');
    if(list.items.length!==1||list.items[0].id!=='${org.invoiceId}'||list.items[0].invoice.invoice.reference!=='CONFIDENTIAL-RUNTIME-REFERENCE')throw new Error('Encrypted invoice recovery failed');
    let denied=false;try{s.invoices.list('${org.id}','old-admin.testnet');}catch{denied=true;}if(!denied)throw new Error('Recovered revoked member read invoice');s.close();
  `],{env:{...env,CORE_ORGANIZATION_DB:active,CORE_ORGANIZATION_ORIGIN:origin},encoding:'utf8'});assert.equal(readInvoice.status,0,readInvoice.stderr);
  const replay=maintenance('activate',resolve(directory,'replay.sqlite'),[quarantine,review,reviewHash]); assert.notEqual(replay.status,0); assert.equal(existsSync(resolve(directory,'replay.sqlite')),false);
  const db=new DatabaseSync(active,{readOnly:true});try{
    assert.equal(db.prepare('SELECT COUNT(*) n FROM organization_sessions').get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM organization_challenges').get()!.n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM organization_members WHERE status='active'").get()!.n,1);
    assert.equal(db.prepare("SELECT status FROM organization_members WHERE account='old-admin.testnet'").get()!.status,'revoked');
    assert.equal(db.prepare("SELECT status FROM organization_invitations WHERE account='pending.testnet'").get()!.status,'revoked');
    assert.equal(db.prepare('SELECT state FROM organization_payments WHERE id=?').get(org.paymentId)!.state,'invalidated');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM organization_payment_dispatches').get()!.n,1);
  } finally{db.close();}
  // Actual compiled startup from the newly activated database, without an RPC request.
  child = spawn(process.execPath,['dist/service/scripts/organization-server.js'],{env:{...env,PORT:String(port),CORE_ORGANIZATION_HOST:'127.0.0.1',CORE_ORGANIZATION_DB:active,CORE_ORGANIZATION_ORIGIN:origin,CORE_ORGANIZATION_ALLOWED_ORIGINS:'http://localhost:3000'},stdio:['ignore','pipe','pipe']});
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Activated service failed');try{if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(500)})).status===200){ready=true;break;}}catch{}await delay(30);}assert.equal(ready,true);
  const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,delay(7000).then(()=>{throw new Error('Recovered service shutdown timeout');})]);child=undefined;
  console.log('Compiled organization service passed: startup/restart, online backup, digest-pinned quarantined restore, denied startup, explicit current-access activation, session/challenge disposal, old-role/invitation denial and one-use recovery, protected invoice key provisioning and encrypted invoice restoration. No public chain call or live deployment.');
} finally { child?.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
