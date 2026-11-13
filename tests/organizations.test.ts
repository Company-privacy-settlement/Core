import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import bs58 from 'bs58';
import { DatabaseSync } from 'node:sqlite';
import { OrganizationStore } from '../server/organizations/store.js';
import { OrganizationAuth, NearOrganizationIdentity, type OrganizationIdentitySource } from '../server/organizations/auth.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { ORGANIZATION_ROLE_PERMISSIONS, OrganizationApiError, OrganizationClient, organizationOrigin, parseOrganizationChallenge, type OrganizationChallenge, type OrganizationRole } from '../sdk/client/organizations.js';

const audience = 'https://organization-api.example', origin = 'https://front.example';
function fixture(t: { after(fn: () => void): void }) {
  let time = Date.now(); const store = new OrganizationStore(':memory:', audience, () => time);
  t.after(() => store.close()); return { store, advance: (ms: number) => { time += ms; } };
}
function add(store: OrganizationStore, id: string, actor: string, target: string, role: Exclude<OrganizationRole, 'owner'>) {
  const invitation = store.invite(id, actor, target, role); store.respondInvite(invitation.id, target, true, invitation.version);
}
function signer() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), publicKey = 'ed25519:' + bs58.encode(raw);
  return { publicKey, sign(c: OrganizationChallenge) {
    // Independent Borsh serialization; do not sign using the implementation under test.
    const str = (s: string) => { const b = Buffer.from(s), length = Buffer.alloc(4); length.writeUInt32LE(b.length); return Buffer.concat([length, b]); };
    const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
    const digest = createHash('sha256').update(Buffer.concat([tag, str(c.message), Buffer.from(c.nonce, 'hex'), str(c.recipient), Buffer.from([0])])).digest();
    return { challengeId: c.id, accountId: c.accountId, publicKey, signature: sign(null, digest, pair.privateKey).toString('base64') };
  } };
}
test('organization isolation applies to detail, member, invitation, audit and mutations', t => {
  const { store } = fixture(t), a = store.create('alice.testnet', 'Alpha'), b = store.create('bob.testnet', 'Beta');
  assert.deepEqual(store.list('alice.testnet').map(o => o.id), [a.id]);
  for (const read of [() => store.detail(b.id, 'alice.testnet'), () => store.members(b.id, 'alice.testnet'), () => store.invitations(b.id, 'alice.testnet'), () => store.auditPage(b.id, 'alice.testnet'), () => store.rename(b.id, 'alice.testnet', 'Stolen', b.version), () => store.invite(b.id, 'alice.testnet', 'alice.testnet', 'admin')]) assert.throws(read, /ORGANIZATION_NOT_FOUND/);
  assert.equal(store.auditPage(a.id, 'alice.testnet').items[0].sequence, 1);
  assert.equal(store.auditPage(b.id, 'bob.testnet').items[0].sequence, 1, 'audit sequences reveal no other organization activity');
});
test('roles enforce viewer, operator, auditor, admin and owner permission boundaries', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company');
  for (const role of ['viewer', 'operator', 'auditor', 'admin'] as const) add(store, org.id, 'owner.testnet', role + '.testnet', role);
  assert.throws(() => store.members(org.id, 'viewer.testnet'), /PERMISSION_DENIED/);
  assert.equal(store.members(org.id, 'operator.testnet').length, 5);
  assert.throws(() => store.auditPage(org.id, 'operator.testnet'), /PERMISSION_DENIED/);
  assert.ok(store.auditPage(org.id, 'auditor.testnet').items.length);
  assert.throws(() => store.invite(org.id, 'auditor.testnet', 'new.testnet', 'viewer'), /PERMISSION_DENIED/);
  assert.throws(() => store.invite(org.id, 'admin.testnet', 'new.testnet', 'admin'), /ROLE_GRANT_DENIED/);
  assert.throws(() => store.changeRole(org.id, 'admin.testnet', 'owner.testnet', 'viewer', 1), /ROLE_GRANT_DENIED/);
  assert.throws(() => store.changeRole(org.id, 'admin.testnet', 'admin.testnet', 'viewer', 1), /ROLE_GRANT_DENIED/);
  assert.throws(() => store.changeRole(org.id, 'admin.testnet', 'viewer.testnet', 'admin', 1), /ROLE_GRANT_DENIED/);
  assert.throws(() => (ORGANIZATION_ROLE_PERMISSIONS.viewer as string[]).push('members.manage'), TypeError);
});
test('invitations are target-bound, accepted explicitly and cannot be replayed or overgrant', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company'), invite = store.invite(org.id, 'owner.testnet', 'viewer.testnet', 'viewer');
  assert.equal(store.list('viewer.testnet').length, 0);
  assert.equal(store.inbox('stranger.testnet').length, 0);
  assert.throws(() => store.respondInvite(invite.id, 'stranger.testnet', true, 1), /INVITATION_NOT_FOUND/);
  assert.equal(store.respondInvite(invite.id, 'viewer.testnet', true, 1)!.role, 'viewer');
  assert.throws(() => store.respondInvite(invite.id, 'viewer.testnet', true, 1), /VERSION_CONFLICT/);
  assert.equal(store.inbox('viewer.testnet').length, 0);
});
test('expiry, decline and inviter revocation invalidate pending invitation authority', t => {
  const { store, advance } = fixture(t), org = store.create('owner.testnet', 'Company');
  add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  const pending = store.invite(org.id, 'admin.testnet', 'next.testnet', 'operator');
  store.remove(org.id, 'owner.testnet', 'admin.testnet', 1);
  assert.throws(() => store.respondInvite(pending.id, 'next.testnet', true, 1), /VERSION_CONFLICT/);
  add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  assert.throws(() => store.respondInvite(pending.id, 'next.testnet', true, 1), /VERSION_CONFLICT/, 're-adding an inviter must not resurrect old authority');
  const expired = store.invite(org.id, 'owner.testnet', 'late.testnet', 'viewer'); advance(7 * 86400_000);
  assert.throws(() => store.respondInvite(expired.id, 'late.testnet', true, 1), /INVITATION_NOT_PENDING/);
  assert.equal(store.inbox('late.testnet').length, 0);
  const renewed = store.invite(org.id, 'owner.testnet', 'late.testnet', 'auditor');
  store.respondInvite(renewed.id, 'late.testnet', false, 1); assert.equal(store.list('late.testnet').length, 0);
});
test('membership and role revocation take effect immediately and stale writes roll back audit', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company'); add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  const before = store.auditPage(org.id, 'owner.testnet').items.length;
  assert.throws(() => store.changeRole(org.id, 'owner.testnet', 'admin.testnet', 'viewer', 99), /VERSION_CONFLICT/);
  assert.equal(store.auditPage(org.id, 'owner.testnet').items.length, before);
  store.changeRole(org.id, 'owner.testnet', 'admin.testnet', 'viewer', 1);
  assert.throws(() => store.invite(org.id, 'admin.testnet', 'third.testnet', 'viewer'), /PERMISSION_DENIED/);
  store.remove(org.id, 'owner.testnet', 'admin.testnet', 2);
  assert.throws(() => store.detail(org.id, 'admin.testnet'), /ORGANIZATION_NOT_FOUND/);
  add(store, org.id, 'owner.testnet', 'admin.testnet', 'operator');
  assert.equal(store.detail(org.id, 'admin.testnet').membershipVersion, 4);
});
test('only owner can atomically transfer to an active successor; last-owner removal is impossible', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company'); add(store, org.id, 'owner.testnet', 'next.testnet', 'operator');
  assert.throws(() => store.remove(org.id, 'owner.testnet', 'owner.testnet', 1), /TRANSFER_OWNERSHIP_FIRST/);
  assert.throws(() => store.transfer(org.id, 'next.testnet', 'owner.testnet', 1), /PERMISSION_DENIED/);
  assert.throws(() => store.transfer(org.id, 'owner.testnet', 'missing.testnet', 1), /ACTIVE_SUCCESSOR_REQUIRED/);
  const result = store.transfer(org.id, 'owner.testnet', 'next.testnet', 1);
  assert.equal(result.ownerAccount, 'next.testnet'); assert.equal(result.role, 'admin');
  assert.equal(store.members(org.id, 'next.testnet').filter(m => m.role === 'owner').length, 1);
  assert.throws(() => store.transfer(org.id, 'owner.testnet', 'next.testnet', 2), /PERMISSION_DENIED/);
});
test('admin cannot revoke an owner-created admin invitation', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company'); add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  const invite = store.invite(org.id, 'owner.testnet', 'next.testnet', 'admin');
  assert.throws(() => store.revokeInvite(org.id, 'admin.testnet', invite.id, 1), /ROLE_GRANT_DENIED/);
  store.revokeInvite(org.id, 'owner.testnet', invite.id, 1);
  assert.throws(() => store.respondInvite(invite.id, 'next.testnet', true, 1), /VERSION_CONFLICT/);
});
test('audit pagination is organization-scoped and stable after concurrent later writes', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company');
  for (let i = 0; i < 60; i++) store.rename(org.id, 'owner.testnet', 'Company ' + i, i + 1);
  const first = store.auditPage(org.id, 'owner.testnet'); assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
  store.rename(org.id, 'owner.testnet', 'Company newest', 61);
  const second = store.auditPage(org.id, 'owner.testnet', first.nextCursor!);
  assert.equal(new Set([...first.items, ...second.items].map(r => r.sequence)).size, 61); assert.equal(second.nextCursor, null);
});
test('organization state and audit persist; database identity and plaintext bearer storage are rejected', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-org-db-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = resolve(dir, 'organizations.sqlite'); let store = new OrganizationStore(file, audience);
  const org = store.create('owner.testnet', 'Company'), c = store.challenge('owner.testnet', origin), session = store.issueSession(c.id, origin, 'fixture-key');
  store.close(); store = new OrganizationStore(file, audience); t.after(() => store.close());
  assert.equal(store.detail(org.id, 'owner.testnet').name, 'Company'); assert.equal(store.auditPage(org.id, 'owner.testnet').items.length, 1);
  assert.equal(store.session(session.token, origin).accountId, 'owner.testnet');
  const db = new DatabaseSync(file, { readOnly: true }); const rows = db.prepare('SELECT hash FROM organization_sessions').all(); db.close();
  assert.equal(rows[0].hash, createHash('sha256').update(session.token).digest('hex')); assert.ok(!readFileSync(file).includes(session.token));
  assert.throws(() => new OrganizationStore(file, 'https://other.example'), /audience mismatch/);
});
test('NEP-413 login verifies independent signatures, consumes one nonce and binds origin/account', async t => {
  const { store } = fixture(t), key = signer();
  const auth = new OrganizationAuth(store, { currentFullAccessKey: async () => true }), signal = new AbortController().signal;
  const c = store.challenge('alice.testnet', origin), proof = key.sign(c);
  await assert.rejects(auth.login('https://wrong.example', proof, signal), /CHALLENGE_INVALID/);
  await assert.rejects(auth.login(origin, { ...proof, accountId: 'bob.testnet' }, signal), /SIGNATURE_INVALID/);
  await assert.rejects(auth.login(origin, key.sign({ ...c, message: 'Sign an unrelated invoice' }), signal), /SIGNATURE_INVALID/);
  const session = await auth.login(origin, proof, signal); assert.equal(session.accountId, 'alice.testnet');
  await assert.rejects(auth.login(origin, proof, signal), /CHALLENGE_INVALID/);
  assert.throws(() => store.session(session.token, 'https://wrong.example'), /SESSION_INVALID/);
});
test('concurrent challenge redemption creates at most one session', async t => {
  const { store } = fixture(t), key = signer(), auth = new OrganizationAuth(store, { currentFullAccessKey: async () => true });
  const proof = key.sign(store.challenge('alice.testnet', origin)), signal = new AbortController().signal;
  const results = await Promise.allSettled([auth.login(origin, proof, signal), auth.login(origin, proof, signal)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('expired challenge/session and finalized key revocation invalidate access', async t => {
  const { store, advance } = fixture(t), key = signer(); let current = true;
  const auth = new OrganizationAuth(store, { currentFullAccessKey: async () => current }), signal = new AbortController().signal;
  const expired = key.sign(store.challenge('alice.testnet', origin)); advance(300_000);
  await assert.rejects(auth.login(origin, expired, signal), /CHALLENGE_INVALID/);
  const session = await auth.login(origin, key.sign(store.challenge('alice.testnet', origin)), signal);
  assert.equal((await auth.identity(session.token, origin, signal)).accountId, 'alice.testnet');
  current = false; await assert.rejects(auth.identity(session.token, origin, signal), /FULL_ACCESS_KEY_REVOKED/);
  current = true; await assert.rejects(auth.identity(session.token, origin, signal), /SESSION_INVALID/);
  const next = await auth.login(origin, key.sign(store.challenge('alice.testnet', origin)), signal); advance(3600_000);
  await assert.rejects(auth.identity(next.token, origin, signal), /SESSION_INVALID/);
});
test('logout or cancellation while identity RPC is pending prevents late authorization', async t => {
  const { store } = fixture(t), c = store.challenge('alice.testnet', origin), session = store.issueSession(c.id, origin, 'fixture');
  let release!: (value: boolean) => void, entered: () => void = () => {};
  const auth = new OrganizationAuth(store, { currentFullAccessKey: () => new Promise(r => { release = r; entered(); }) });
  const pending = auth.identity(session.token, origin, new AbortController().signal); store.logout(session.token); release(true);
  await assert.rejects(pending, /SESSION_INVALID/);
  const started = new Promise<void>(r => { entered = r; });
  const key = signer(), controller = new AbortController(), login = auth.login(origin, key.sign(store.challenge('alice.testnet', origin)), controller.signal);
  await started; controller.abort(); release(true); await assert.rejects(login);
});
test('identity transport rejects wrong networks, stale snapshots and function-call keys', async t => {
  let network = 'mainnet', permission: unknown = 'FullAccess', stale = false, oversized = false; const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const req = JSON.parse(init.body as string); calls.push(req.method);
    if (oversized) return new Response('x'.repeat(128_001));
    const result = req.method === 'status' ? { chain_id: network, sync_info: { syncing: false, latest_block_time: new Date(Date.now() - (stale ? 300_000 : 0)).toISOString() } } : req.method === 'block' ? { header: { height: 10, hash: 'a'.repeat(44), timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) } } : { permission, block_hash: 'a'.repeat(44), block_height: 10 };
    return new Response(JSON.stringify({ result }));
  });
  const reader = new NearOrganizationIdentity('https://rpc.example'), signal = new AbortController().signal;
  await assert.rejects(reader.currentFullAccessKey('alice.testnet', signer().publicKey, signal), /IDENTITY_CHAIN_UNAVAILABLE/); assert.deepEqual(calls, ['status']);
  network = 'testnet'; permission = { FunctionCall: {} }; assert.equal(await reader.currentFullAccessKey('alice.testnet', signer().publicKey, signal), false);
  permission = 'FullAccess'; assert.equal(await reader.currentFullAccessKey('alice.testnet', signer().publicKey, signal), true);
  stale = true; await assert.rejects(reader.currentFullAccessKey('alice.testnet', signer().publicKey, signal), /IDENTITY_CHAIN_UNAVAILABLE/);
  stale = false; oversized = true; await assert.rejects(reader.currentFullAccessKey('alice.testnet', signer().publicKey, signal), /IDENTITY_CHAIN_UNAVAILABLE/);
});
test('browser challenge parser rejects substitution, expiry and wrong audience before wallet signing', t => {
  const { store } = fixture(t), c = store.challenge('alice.testnet', origin);
  assert.equal(parseOrganizationChallenge(c, 'alice.testnet', audience, origin).id, c.id);
  assert.equal(parseOrganizationChallenge(c, 'alice.testnet', audience, origin, Date.now() - 30_000).id, c.id, 'small client clock skew must not prevent sign-in');
  for (const changed of [{ ...c, accountId: 'bob.testnet' }, { ...c, audience: 'https://evil.example' }, { ...c, message: 'Approve payment' }, { ...c, expiresAt: new Date(0).toISOString() }]) assert.throws(() => parseOrganizationChallenge(changed, 'alice.testnet', audience, origin), /binding mismatch/);
  assert.throws(() => organizationOrigin('http://unsafe.example'));
});
test('identity refuses access-key responses from a different finalized snapshot', async t => {
  let returnedHash = 'b'.repeat(44), returnedHeight = 9;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const { method } = JSON.parse(init.body as string);
    const result = method === 'status' ? { chain_id: 'testnet', sync_info: { syncing: false, latest_block_time: new Date().toISOString() } }
      : method === 'block' ? { header: { height: 10, hash: 'a'.repeat(44), timestamp_nanosec: String(BigInt(Date.now()) * 1000000n) } }
      : { permission: 'FullAccess', block_hash: returnedHash, block_height: returnedHeight };
    return new Response(JSON.stringify({ result }));
  });
  const reader = new NearOrganizationIdentity('https://rpc.example'), signal = new AbortController().signal, key = signer().publicKey;
  await assert.rejects(reader.currentFullAccessKey('alice.testnet', key, signal), /IDENTITY_CHAIN_UNAVAILABLE/);
  returnedHash = 'a'.repeat(44);
  await assert.rejects(reader.currentFullAccessKey('alice.testnet', key, signal), /IDENTITY_CHAIN_UNAVAILABLE/);
  returnedHeight = 10;
  assert.equal(await reader.currentFullAccessKey('alice.testnet', key, signal), true);
});
test('organization identity refuses globally disabled TLS certificate verification', t => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  assert.throws(() => new NearOrganizationIdentity('https://rpc.example'), /TLS_VERIFICATION_MUST_STAY_ENABLED/);
});
test('revoking an inviter removes invitation visibility and permits a replacement', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Private original name');
  add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  store.invite(org.id, 'admin.testnet', 'outside.testnet', 'viewer');
  assert.equal(store.inbox('outside.testnet').length, 1);
  store.remove(org.id, 'owner.testnet', 'admin.testnet', 1);
  store.rename(org.id, 'owner.testnet', 'Private later name', org.version);
  assert.equal(store.inbox('outside.testnet').length, 0, 'invalid invitation must not expose the latest organization name');
  const replacement = store.invite(org.id, 'owner.testnet', 'outside.testnet', 'auditor');
  assert.equal(replacement.role, 'auditor');
  assert.ok(store.auditPage(org.id, 'owner.testnet').items.some(r => r.action === 'invitation.revoked' && r.detail.reason === 'INVITER_MEMBERSHIP_CHANGED'));
});
test('ownership transfer revokes pending invitations bound to either changed membership', t => {
  const { store } = fixture(t), org = store.create('owner.testnet', 'Company');
  add(store, org.id, 'owner.testnet', 'successor.testnet', 'admin');
  store.invite(org.id, 'owner.testnet', 'first.testnet', 'viewer');
  store.invite(org.id, 'successor.testnet', 'second.testnet', 'auditor');
  store.transfer(org.id, 'owner.testnet', 'successor.testnet', org.version);
  assert.equal(store.inbox('first.testnet').length, 0); assert.equal(store.inbox('second.testnet').length, 0);
});
test('older persisted invalid invitations reveal no current tenant name and can be replaced', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-org-stale-invite-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = resolve(dir, 'organizations.sqlite'); let store = new OrganizationStore(filename, audience);
  const org = store.create('owner.testnet', 'Old name'); add(store, org.id, 'owner.testnet', 'admin.testnet', 'admin');
  const invite = store.invite(org.id, 'admin.testnet', 'outside.testnet', 'viewer'); store.close();
  // Simulate an invalid pending record retained by an earlier server version.
  const db = new DatabaseSync(filename); db.prepare('UPDATE organization_members SET version=version+1 WHERE org=? AND account=?').run(org.id, 'admin.testnet'); db.close();
  store = new OrganizationStore(filename, audience); t.after(() => store.close());
  store.rename(org.id, 'owner.testnet', 'New private name', 1);
  assert.equal(store.inbox('outside.testnet').length, 0);
  assert.throws(() => store.respondInvite(invite.id, 'outside.testnet', true, 1), /AUTHORITY_REVOKED/);
  assert.equal(store.invite(org.id, 'owner.testnet', 'outside.testnet', 'auditor').role, 'auditor');
});
test('organization client preserves HTTP denial when an upstream sends non-JSON', async t => {
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => new Response('<h1>Proxy error</h1>', { status }));
  const client = new OrganizationClient(audience);
  await assert.rejects(client.request('/v1/organizations'), e => e instanceof OrganizationApiError && e.status === 403);
  status = 200;
  await assert.rejects(client.request('/v1/organizations'), e => e instanceof OrganizationApiError && e.status === 502 && e.code === 'INVALID_RESPONSE');
});
test('organization client bounds a stalled request while preserving caller cancellation', async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => nativeTimeout(20));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const signal = init.signal; assert.ok(signal);
    signal.throwIfAborted();
    return await new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const client = new OrganizationClient(audience), guard = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(client.request('/v1/organizations'), e => (e as Error).name === 'TimeoutError');
    const caller = new AbortController(); const pending = client.request('/v1/organizations', 'GET', undefined, caller.signal); caller.abort();
    await assert.rejects(pending, e => (e as Error).name === 'AbortError');
  } finally { clearTimeout(guard); }
});
test('HTTP API enforces real signatures, origin, tenant and strict input against live membership', async t => {
  const { store } = fixture(t), key = signer(); let current = true;
  const identity: OrganizationIdentitySource = { currentFullAccessKey: async (_a, publicKey) => current && publicKey === key.publicKey };
  const server = createOrganizationApi({ store, identity, allowedOrigins: [origin], ratePoints: 10000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const a = server.address(); assert.ok(a && typeof a !== 'string'); const api = `http://127.0.0.1:${a.port}`;
  async function request(path: string, method = 'GET', body?: unknown, token?: string, from = origin) {
    return fetch(api + path, { method, headers: { origin: from, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  assert.equal((await request('/v1/organizations')).status, 401);
  assert.equal((await request('/v1/auth/challenge', 'POST', { accountId: 'alice.testnet' }, undefined, 'https://evil.example')).status, 403);
  const c = await (await request('/v1/auth/challenge', 'POST', { accountId: 'alice.testnet' })).json() as OrganizationChallenge;
  const session = await (await request('/v1/auth/login', 'POST', key.sign(c))).json() as { token: string };
  assert.ok(session.token);
  const oversized = await request('/v1/organizations', 'POST', { name: 'x'.repeat(9000) }, session.token);
  assert.equal(oversized.status, 413); assert.equal(oversized.headers.get('connection'), 'close'); await oversized.arrayBuffer();
  assert.equal((await request('/v1/organizations', 'POST', { name: 'Business', owner: 'bob.testnet' }, session.token)).status, 400);
  const org = await (await request('/v1/organizations', 'POST', { name: 'Business' }, session.token)).json() as { id: string };
  assert.ok(org.id); const foreign = store.create('bob.testnet', 'Other business');
  assert.equal((await request('/v1/organizations/' + foreign.id, 'GET', undefined, session.token)).status, 404);
  assert.equal((await request('/v1/organizations/' + org.id, 'GET', undefined, session.token, 'https://evil.example')).status, 403);
  const publicClient = new OrganizationClient(api, session.token);
  await assert.rejects(publicClient.request('/v1/organizations'), /ORIGIN_DENIED/, 'Node client must explicitly provide the approved Origin; browsers supply it');
  current = false;
  assert.equal((await request('/v1/auth/logout', 'POST', {}, session.token)).status, 200, 'session revocation does not require a live identity RPC');
  const c2 = await (await request('/v1/auth/challenge', 'POST', { accountId: 'alice.testnet' })).json() as OrganizationChallenge;
  current = true; const next = await (await request('/v1/auth/login', 'POST', key.sign(c2))).json() as { token: string };
  current = false; assert.equal((await request('/v1/organizations', 'GET', undefined, next.token)).status, 401);
});
test('HTTP deadlines retain bounded work slots and abort late writes', async t => {
  const { store } = fixture(t), c = store.challenge('alice.testnet', origin), session = store.issueSession(c.id, origin, 'fixture');
  let release!: (value: boolean) => void, allow = false, entered: () => void = () => {};
  const server = createOrganizationApi({ store, identity: { currentFullAccessKey: () => { entered(); return allow ? Promise.resolve(true) : new Promise(r => { release = r; }); } }, allowedOrigins: [origin], timeoutMs: 100, maxConcurrent: 1 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { method: 'POST', headers: { origin, authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Must not be created' }) };
  const url = `http://127.0.0.1:${address.port}/v1/organizations`;
  assert.equal((await fetch(url, options)).status, 504);
  assert.equal((await fetch(url, options)).status, 503, 'an uncancellable identity source must retain its admission slot');
  release(true); await new Promise(r => setTimeout(r, 10)); assert.equal(store.list('alice.testnet').length, 0);
  allow = true;
  const started = new Promise<void>(r => { entered = r; });
  const response = new Promise<number>(resolve => {
    const req = httpRequest(url, { method: 'POST', headers: { ...options.headers, 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!); });
    req.write('{"name":');
    void started.then(() => { store.logout(session.token); req.end('"Rejected after logout"}'); });
  });
  assert.equal(await response, 401, 'logout while a request body is pending must block its later write');
  assert.equal(store.list('alice.testnet').length, 0);
});
