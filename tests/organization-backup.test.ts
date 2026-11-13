import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OrganizationStore } from '../server/organizations/store.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { activateOrganizations, backupOrganizations, organizationReviewTemplate, restoreOrganizations } from '../scripts/lib/organization-backup.js';
import { fileDigest } from '../scripts/lib/index-backup.js';

const audience = 'https://organization-api.example', origin = 'https://front.example';
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-organization-backup-')), source = resolve(dir, 'live.sqlite');
  const store = new OrganizationStore(source, audience), org = store.create('old-owner.testnet', 'Company');
  for (const [account, role] of [['admin.testnet','admin'],['successor.testnet','viewer'],['removed.testnet','operator']] as const) {
    const invite = store.invite(org.id, 'old-owner.testnet', account, role); store.respondInvite(invite.id, account, true, invite.version);
  }
  const invitation = store.invite(org.id, 'admin.testnet', 'pending.testnet', 'operator');
  const challenge = store.challenge('old-owner.testnet', origin), session = store.issueSession(challenge.id, origin, 'public fixture key');
  const pendingChallenge = store.challenge('removed.testnet', origin);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, source, store, org, invitation, session, pendingChallenge, path: (name: string) => resolve(dir, name) };
}
function read(path: string, sql: string) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } }
async function restored(f: ReturnType<typeof fixture>) {
  const backup = await backupOrganizations(f.source, f.path('backup.sqlite'), audience);
  const restore = await restoreOrganizations(backup.file, backup.sha256, f.path('quarantine.sqlite'), audience);
  return { backup, restore };
}
async function review(f: ReturnType<typeof fixture>, source: string, name = 'review.json') {
  const path = f.path(name); await organizationReviewTemplate(source, path, audience);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.reviewedAt = new Date().toISOString();
  const current = f.store.detail(f.org.id, 'old-owner.testnet');
  value.organizations[0] = { id: current.id, ownerAccount: current.ownerAccount, currentVersion: current.version,
    members: f.store.members(current.id, current.ownerAccount).map(m => ({ accountId: m.accountId, role: m.role, currentVersion: m.version })) };
  const save = async () => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return fileDigest(path); };
  return { path, value, save };
}
test('online organization backup captures a consistent committed WAL snapshot without changing the live service', async t => {
  const f = fixture(t), pending = backupOrganizations(f.source, f.path('snapshot.sqlite'), audience);
  for (let i = 1; i <= 12; i++) f.store.rename(f.org.id, 'old-owner.testnet', `Company ${i}`, i);
  const snapshot = await pending;
  const org = read(snapshot.file, 'SELECT name,version FROM organizations')[0];
  const audit = read(snapshot.file, "SELECT detail FROM organization_audit WHERE action='organization.renamed' ORDER BY sequence DESC");
  assert.equal(org.name, Number(org.version) === 1 ? 'Company' : `Company ${Number(org.version) - 1}`);
  assert.equal(audit.length, Number(org.version) - 1);
  if (audit.length) assert.equal(JSON.parse(String(audit[0].detail)).name, org.name);
  assert.equal(snapshot.sha256, await fileDigest(snapshot.file)); assert.equal(snapshot.status.journalMode, 'delete');
  assert.equal(lstatSync(snapshot.file).mode & 0o777, 0o600);
  assert.equal(f.store.session(f.session.token, origin).accountId, 'old-owner.testnet');
  assert.equal(f.store.getChallenge(f.pendingChallenge.id, origin).accountId, 'removed.testnet');
});
test('exported backups contain no sessions or challenges and cannot be served even by directly opening the file', async t => {
  const f = fixture(t), { backup, restore } = await restored(f);
  for (const file of [backup.file, restore.file]) {
    assert.equal(read(file, 'SELECT version FROM organization_meta')[0].version, 2, 'Earlier v1 service binaries also reject the recovery envelope');
    assert.deepEqual(read(file, 'SELECT * FROM organization_sessions'), []); assert.deepEqual(read(file, 'SELECT * FROM organization_challenges'), []);
    assert.throws(() => new OrganizationStore(file, audience), /access review/);
    for (const suffix of ['-wal','-shm','-journal']) assert.equal(existsSync(file + suffix), false);
  }
  assert.notEqual(backup.status.recovery.recovery_id, restore.status.recovery.recovery_id);
  assert.equal(restore.requiresAccessReview, true);
});
test('restore pins the backup digest and audience and leaves no published file on failure', async t => {
  const f = fixture(t), backup = await backupOrganizations(f.source, f.path('backup.sqlite'), audience);
  await assert.rejects(async () => restoreOrganizations(backup.file, '0'.repeat(64), f.path('wrong-hash.sqlite'), audience), /digest/);
  await assert.rejects(async () => restoreOrganizations(backup.file, backup.sha256, f.path('wrong-origin.sqlite'), 'https://other.example'), /audience/);
  for (const name of ['wrong-hash.sqlite','wrong-origin.sqlite']) assert.equal(existsSync(f.path(name)), false);
  assert.equal(readdirSync(f.dir).some(n => /\.(restore|tmp|activate)$/.test(n)), false);
});
test('restore never overwrites a database, sidecar or symlink destination', async t => {
  const f = fixture(t), backup = await backupOrganizations(f.source, f.path('backup.sqlite'), audience);
  await assert.rejects(async () => backupOrganizations(f.source, backup.file, audience), /new destination/);
  for (const suffix of ['', '-wal','-shm','-journal']) {
    const target = f.path('occupied' + (suffix || 'main') + '.sqlite'); writeFileSync(target + suffix, 'retain me', { mode: 0o600 });
    await assert.rejects(async () => restoreOrganizations(backup.file, backup.sha256, target, audience), /new destination/);
    assert.equal(readFileSync(target + suffix, 'utf8'), 'retain me');
  }
  const link = f.path('link.sqlite'); symlinkSync(backup.file, link);
  await assert.rejects(async () => restoreOrganizations(backup.file, backup.sha256, link, audience)); assert.equal(lstatSync(link).isSymbolicLink(), true);
});
test('private files, schema integrity and portable backup format are mandatory', async t => {
  const f = fixture(t), raw = f.path('raw.sqlite');
  // A raw closed SQLite copy is not an approved portable backup, even with a known digest.
  const db = new DatabaseSync(raw); db.exec('CREATE TABLE unrelated(secret TEXT)'); db.close(); chmodSync(raw, 0o600);
  await assert.rejects(async () => backupOrganizations(raw, f.path('unrelated.sqlite'), audience), /schema/);
  await assert.rejects(async () => restoreOrganizations(raw, await fileDigest(raw), f.path('raw-restore.sqlite'), audience));
  const backup = await backupOrganizations(f.source, f.path('backup.sqlite'), audience);
  const altered = f.path('altered.sqlite'); copyFileSync(backup.file, altered);
  const bad = new DatabaseSync(altered); bad.exec("CREATE TRIGGER unexpected AFTER INSERT ON organization_sessions BEGIN DELETE FROM organization_members; END"); bad.close();
  await assert.rejects(async () => restoreOrganizations(altered, await fileDigest(altered), f.path('trigger.sqlite'), audience), /schema/);
  chmodSync(backup.file, 0o644); await assert.rejects(async () => organizationReviewTemplate(backup.file, f.path('bad-review.json'), audience), /owner-only/);
});
test('review templates never preapprove historical owners, memberships or invitations', async t => {
  const f = fixture(t), { restore } = await restored(f), file = f.path('blank.json');
  await organizationReviewTemplate(restore.file, file, audience);
  const draft = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(draft.organizations, [{ id: f.org.id, ownerAccount: '', currentVersion: null, members: [] }]);
  assert.equal(draft.databaseSha256, await fileDigest(restore.file)); assert.equal(draft.reviewedAt, '');
  assert.equal(readFileSync(file, 'utf8').includes('old-owner.testnet'), false); assert.equal(lstatSync(file).mode & 0o777, 0o600);
  await assert.rejects(async () => activateOrganizations(restore.file, file, await fileDigest(file), f.path('unreviewed.sqlite'), audience));
  assert.equal(existsSync(f.path('unreviewed.sqlite')), false);
});
test('restoring an old snapshot cannot resurrect a removed owner/member, demoted admin or stale invitation', async t => {
  const f = fixture(t), { restore } = await restored(f);
  f.store.changeRole(f.org.id, 'old-owner.testnet', 'admin.testnet', 'viewer', 1);
  f.store.remove(f.org.id, 'old-owner.testnet', 'removed.testnet', 1);
  f.store.transfer(f.org.id, 'old-owner.testnet', 'successor.testnet', 1);
  f.store.remove(f.org.id, 'successor.testnet', 'old-owner.testnet', 2);
  const path = f.path('current-review.json'); await organizationReviewTemplate(restore.file, path, audience);
  const value = JSON.parse(readFileSync(path, 'utf8')), current = f.store.detail(f.org.id, 'successor.testnet');
  value.reviewedAt = new Date().toISOString(); value.organizations = [{ id: current.id, ownerAccount: current.ownerAccount, currentVersion: current.version,
    members: f.store.members(f.org.id, 'successor.testnet').map(m => ({ accountId: m.accountId, role: m.role, currentVersion: m.version })) }];
  writeFileSync(path, JSON.stringify(value));
  const activated = await activateOrganizations(restore.file, path, await fileDigest(path), f.path('active.sqlite'), audience);
  const store = new OrganizationStore(activated.file, audience); t.after(() => store.close());
  assert.equal(read(activated.file,'SELECT version FROM organization_meta')[0].version,1,'Only explicitly activated data returns to the live schema');
  assert.throws(() => store.session(f.session.token, origin), /SESSION_INVALID/); assert.throws(() => store.getChallenge(f.pendingChallenge.id, origin), /CHALLENGE_INVALID/);
  for (const account of ['old-owner.testnet','removed.testnet']) {
    const c = store.challenge(account, origin), session = store.issueSession(c.id, origin, 'current wallet key');
    assert.equal(store.session(session.token, origin).accountId, account); assert.deepEqual(store.list(account), []);
    assert.throws(() => store.detail(f.org.id, account), /ORGANIZATION_NOT_FOUND/);
  }
  assert.equal(store.detail(f.org.id, 'admin.testnet').role, 'viewer'); assert.throws(() => store.invite(f.org.id, 'admin.testnet', 'other.testnet', 'viewer'), /PERMISSION_DENIED/);
  assert.equal(store.detail(f.org.id, 'successor.testnet').role, 'owner'); assert.equal(store.detail(f.org.id, 'successor.testnet').version, current.version + 1);
  assert.equal(store.inbox('pending.testnet').length, 0); assert.throws(() => store.respondInvite(f.invitation.id, 'pending.testnet', true, f.invitation.version), /VERSION_CONFLICT/);
  const invite = store.invite(f.org.id, 'successor.testnet', 'new.testnet', 'auditor'); assert.equal(store.respondInvite(invite.id, 'new.testnet', true, invite.version)!.role, 'auditor');
  const event = store.auditPage(f.org.id, 'successor.testnet').items.find(e => e.action === 'organization.recovered'); assert.ok(event); assert.equal(event.detail.recoveryId, restore.status.recovery.recovery_id);
});
test('HTTP authorization rejects old tokens and fresh logins cannot recover omitted membership', async t => {
  const f = fixture(t), { restore } = await restored(f), r = await review(f, restore.file);
  r.value.organizations[0].members = r.value.organizations[0].members.filter((m: {accountId:string}) => m.accountId !== 'removed.testnet');
  const active = await activateOrganizations(restore.file, r.path, await r.save(), f.path('active.sqlite'), audience), store = new OrganizationStore(active.file, audience);
  const c = store.challenge('removed.testnet', origin), fresh = store.issueSession(c.id, origin, 'current key');
  const server = createOrganizationApi({ store, identity: { currentFullAccessKey: async () => true }, allowedOrigins: [origin] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (path: string, token: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal((await request('/v1/me', f.session.token)).status, 401);
  assert.equal((await request('/v1/me', fresh.token)).status, 200);
  assert.equal((await request(`/v1/organizations/${f.org.id}`, fresh.token)).status, 404);
  const memberships = await (await request('/v1/organizations', fresh.token)).json(); assert.deepEqual(memberships, { items: [] });
});
test('access review needs its independent digest and the exact recovery database binding', async t => {
  const f = fixture(t), { backup, restore } = await restored(f), r = await review(f, restore.file), hash = await r.save();
  await assert.rejects(async () => activateOrganizations(restore.file, r.path, '0'.repeat(64), f.path('bad-hash.sqlite'), audience), /digest/);
  const second = await restoreOrganizations(backup.file, backup.sha256, f.path('second.sqlite'), audience);
  await assert.rejects(async () => activateOrganizations(second.file, r.path, hash, f.path('bad-db.sqlite'), audience), /different database/);
  r.value.databaseSha256 = second.sha256;
  await assert.rejects(async () => activateOrganizations(second.file, r.path, await r.save(), f.path('bad-recovery.sqlite'), audience), /different recovery/);
  for (const name of ['bad-hash.sqlite','bad-db.sqlite','bad-recovery.sqlite']) assert.equal(existsSync(f.path(name)), false);
});
test('malformed, incomplete, stale or overgranting reviews fail atomically', async t => {
  const f = fixture(t), { restore } = await restored(f), r = await review(f, restore.file), original = structuredClone(r.value);
  const variants = [
    (v:any) => {v.extra='unapproved';}, (v:any) => {v.audience='https://other.example';},
    (v:any) => {v.reviewedAt=new Date(Date.now()-86401_000).toISOString();}, (v:any) => {v.reviewedAt=new Date(Date.now()+120_000).toISOString();},
    (v:any) => {v.organizations=[];}, (v:any) => {v.organizations.push(v.organizations[0]);},
    (v:any) => {v.organizations[0].members=[];}, (v:any) => {v.organizations[0].ownerAccount='attacker.testnet';},
    (v:any) => {v.organizations[0].members.push(v.organizations[0].members[0]);},
    (v:any) => {v.organizations[0].members[1].role='owner';}, (v:any) => {v.organizations[0].members[1].role='root';},
    (v:any) => {v.organizations[0].currentVersion=0;}, (v:any) => {v.organizations[0].currentVersion=Number.MAX_SAFE_INTEGER;},
  ];
  for (const [index, change] of variants.entries()) {
    r.value = structuredClone(original); change(r.value); writeFileSync(r.path, JSON.stringify(r.value));
    const target = f.path(`invalid-${index}.sqlite`);
    await assert.rejects(async () => activateOrganizations(restore.file, r.path, await fileDigest(r.path), target, audience)); assert.equal(existsSync(target), false);
  }
  assert.equal(read(restore.file, 'SELECT state FROM organization_recovery')[0].state, 'quarantined');
  assert.equal(existsSync(restore.file + '.activation.json'), false);
});
test('approved revisions supersede backed-up versions and reject stale edits after recovery', async t => {
  const f = fixture(t); f.store.rename(f.org.id, 'old-owner.testnet', 'New name', 1); f.store.changeRole(f.org.id, 'old-owner.testnet', 'admin.testnet', 'viewer', 1);
  const { restore } = await restored(f), r = await review(f, restore.file);
  r.value.organizations[0].currentVersion = 1;
  await assert.rejects(async () => activateOrganizations(restore.file, r.path, await r.save(), f.path('old-version.sqlite'), audience), /predates/);
  r.value.organizations[0].currentVersion = 2; r.value.organizations[0].members.find((m:any)=>m.accountId==='admin.testnet').currentVersion=1;
  await assert.rejects(async () => activateOrganizations(restore.file, r.path, await r.save(), f.path('old-member-version.sqlite'), audience), /predates/);
  r.value.organizations[0].members.find((m:any)=>m.accountId==='admin.testnet').currentVersion=5;
  const active = await activateOrganizations(restore.file, r.path, await r.save(), f.path('active.sqlite'), audience), store = new OrganizationStore(active.file, audience); t.after(()=>store.close());
  assert.throws(()=>store.rename(f.org.id,'old-owner.testnet','Stale edit',2),/VERSION_CONFLICT/);
  assert.throws(()=>store.changeRole(f.org.id,'old-owner.testnet','admin.testnet','admin',5),/VERSION_CONFLICT/);
});
test('one recovery approval cannot be replayed or activated concurrently into competing destinations', async t => {
  const f = fixture(t), { restore } = await restored(f), r = await review(f, restore.file), hash = await r.save();
  const results = await Promise.allSettled([activateOrganizations(restore.file,r.path,hash,f.path('one.sqlite'),audience),activateOrganizations(restore.file,r.path,hash,f.path('two.sqlite'),audience)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal([f.path('one.sqlite'),f.path('two.sqlite')].filter(existsSync).length,1);
  assert.equal(lstatSync(restore.file+'.activation.json').mode & 0o777,0o600);
  await assert.rejects(()=>activateOrganizations(restore.file,r.path,hash,f.path('replay.sqlite'),audience)); assert.equal(existsSync(f.path('replay.sqlite')),false);
});
test('legacy organization databases gain the gate without losing existing live access', async t => {
  const f = fixture(t), db = new DatabaseSync(f.source); db.exec('DROP TABLE organization_recovery'); db.close();
  const second = new OrganizationStore(f.source,audience); try {assert.equal(second.detail(f.org.id,'old-owner.testnet').role,'owner');} finally {second.close();}
  const result=await backupOrganizations(f.source,f.path('legacy-backup.sqlite'),audience);assert.equal(result.status.recovery.state,'quarantined');
});
test('interrupted legacy recovery-gate initialization rolls back instead of stranding an unusable half-state', t => {
  const f=fixture(t), db=new DatabaseSync(f.source);db.exec('DROP TABLE organization_recovery');db.close();
  const prepare=DatabaseSync.prototype.prepare;
  const mock=t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    if(sql.startsWith('INSERT OR IGNORE INTO organization_recovery'))throw new Error('Injected initialization interruption');
    return prepare.call(this,sql);
  });
  try{assert.throws(()=>new OrganizationStore(f.source,audience),/Injected initialization interruption/);}finally{mock.mock.restore();}
  assert.deepEqual(read(f.source,"SELECT name FROM sqlite_schema WHERE name='organization_recovery'"),[]);
  const recovered=new OrganizationStore(f.source,audience);try{assert.equal(recovered.detail(f.org.id,'old-owner.testnet').role,'owner');}finally{recovered.close();}
});
