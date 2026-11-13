import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPrivateNote, validatePrivateNote, noteDomain, noteHash, encryptNoteBackup, openNoteBackup } from '../sdk/client/notes.js';
import { seal, unseal } from '../sdk/client/crypto.js';
import { parseDepositPlan } from '../sdk/client/deposits.js';
import { HttpGateway } from '../sdk/client/http.js';
import { domain, hash, createNote, validateNote, FIELD } from '../sdk/core.js';
import { prepareFtDeposit } from '../sdk/operations.js';
import { createReadOnlyApi } from '../server/api.js';
import { operationsFixture } from './fixtures/operations.js';
const password = 'browser note backup test password', root = 'ab'.repeat(32);
function fixture() {
  const f = operationsFixture();
  f.source.records = async (from, limit, block) => { f.reads.push({ method: 'list_vaults', block }); return [f.record].slice(from, from + limit); };
  return f;
}
test('browser Poseidon matches the existing circuit library for boundary and deterministic field vectors', async () => {
  for (const n of [2, 3]) for (let i = 0; i < 24; i++) {
    const inputs = Array.from({ length: n }, (_, j) => (i === 0 ? 0n : i === 1 ? FIELD - 1n - BigInt(j) : BigInt(i) ** BigInt(3 + j)).toString());
    assert.equal(noteHash(inputs), await hash(inputs));
  }
  for (const inputs of [[], ['1'], ['1','2','3','4'], ['01','2'], [FIELD.toString(),'2'], ['-1','2']]) assert.throws(() => noteHash(inputs));
});
test('browser notes interoperate with existing note validation and bind network, registry, token and denomination', async () => {
  const f = fixture(), note = await createPrivateNote(f.policy);
  assert.equal(await noteDomain(f.policy), domain(f.pool)); await validateNote(f.pool, note);
  const legacy = await createNote(f.pool); assert.deepEqual(await validatePrivateNote(f.policy, legacy), legacy);
  const second = await createPrivateNote(f.policy); assert.notEqual(note.secret, second.secret); assert.notEqual(note.nullifier, second.nullifier); assert.notEqual(note.commitment, second.commitment);
  for (const change of [{ network: 'testnet' as const }, { registry: 'other.test.near' }, { tokenId: 'fake.test.near' }, { denomination: '2000000' }]) await assert.rejects(validatePrivateNote({ ...f.policy, ...change }, note), /different/);
  for (const change of [{ commitment: '1' }, { secret: '01' }, { nullifier: FIELD.toString() }, { extra: 'unexpected' }]) await assert.rejects(validatePrivateNote(f.policy, { ...note, ...change }));
});
test('encrypted note backups authenticate the full policy and reject other formats, tampering and wrong passwords', async () => {
  const f = fixture(), note = await createPrivateNote(f.policy), envelope = await encryptNoteBackup(f.policy, note, password);
  assert.equal(JSON.parse(envelope).format, 'core-private-note');
  for (const value of [note.secret, note.nullifier, note.commitment, f.policy.registry]) assert.ok(!envelope.includes(value));
  assert.deepEqual(await openNoteBackup(envelope, password, f.policy), { policy: f.policy, note });
  await assert.rejects(openNoteBackup(envelope, password, { ...f.policy, feeRecipient: f.payer }), /trusted policy/);
  await assert.rejects(openNoteBackup(envelope, 'a different password'));
  await assert.rejects(unseal(envelope, password)); await assert.rejects(unseal(envelope, password, 'core-invoice-library'));
  const e = JSON.parse(envelope); e.ciphertext = (e.ciphertext.startsWith('A') ? 'B' : 'A') + e.ciphertext.slice(1);
  await assert.rejects(openNoteBackup(JSON.stringify(e), password));
  await assert.rejects(openNoteBackup(await seal({ version: 1, policy: f.policy, note: { ...note, commitment: '1' } }, password, 'core-private-note'), password));
});
test('public deposit planning uses one final block and exposes only the commitment-bound token call', async () => {
  const f = fixture(), note = await createPrivateNote(f.policy), request = { commitment: note.commitment, disclosureRoot: root };
  const result = await prepareFtDeposit(f.source, f.policy, request);
  assert.equal(result.plan.tokenCall.args.receiver_id, f.vault); assert.equal(result.plan.tokenCall.args.amount, '1001500');
  assert.deepEqual(JSON.parse(result.plan.tokenCall.args.msg as string), { commitment: note.commitment, disclosure_root: root });
  assert.equal(result.remainingOutputs, 254); assert.equal(result.vaultScanComplete, true); assert.equal(f.state.snapshots, 1);
  assert.deepEqual(new Set(f.reads.map(r => r.block)), new Set(['block-20']));
  assert.ok(!JSON.stringify(result).includes(note.secret)); assert.ok(!JSON.stringify(result).includes(note.nullifier));
});
test('full groups cannot reroute notes and explicit vault preparation reaches members beyond the bounded scan', async () => {
  const f = fixture(), request = { commitment: '42', disclosureRoot: root };
  f.config.leaf_count = 256; await assert.rejects(prepareFtDeposit(f.source, f.policy, request), /full/);
  f.config.leaf_count = 2; f.record.index = 201; f.config.vault_count = 202;
  f.source.records = async (from, limit) => from === 201 && limit === 1 ? [f.record] : [];
  assert.equal((await prepareFtDeposit(f.source, f.policy, { ...request, vault: f.vault })).plan.tokenCall.args.receiver_id, f.vault);
  await assert.rejects(prepareFtDeposit(f.source, f.policy, { ...request, vault: 'unknown.test.near' }), /registered/);
  f.local.held_notes = 256; // A full physical vault remains ineligible even when the group's tree has room.
  await assert.rejects(prepareFtDeposit(f.source, f.policy, { ...request, vault: f.vault }), /eligible/);
});
test('browser deposit validation rejects substituted commitment, receipt, vault, token, fees, gas and policy', async () => {
  const f = fixture(); f.source.finalBlock = async () => ({ hash: 'B'.repeat(44), height: 20 });
  const request = { commitment: '42', disclosureRoot: root, vault: f.vault }, result = await prepareFtDeposit(f.source, f.policy, request);
  assert.deepEqual(await parseDepositPlan(result, f.policy, request), result);
  for (const patch of [{ contract: f.payer }, { gas: '1' }, { attachedYoctoNear: '2' }, ...[
    { receiver_id: `v${'b'.repeat(32)}.${f.policy.registry}` }, { amount: '1000000' },
    { msg: JSON.stringify({ commitment: '43', disclosure_root: root }) },
    { msg: JSON.stringify({ commitment: '42', disclosure_root: 'cd'.repeat(32) }) },
    { msg: JSON.stringify({ commitment: '42', disclosure_root: root, secret: 'never' }) },
  ].map(args => ({ args: { ...result.plan.tokenCall.args, ...args } }))]) {
    await assert.rejects(parseDepositPlan({ ...result, plan: { ...result.plan, tokenCall: { ...result.plan.tokenCall, ...patch } } }, f.policy, request));
  }
  await assert.rejects(parseDepositPlan({ ...result, policy: { ...f.policy, feeRecipient: f.payer } }, f.policy, request));
  await assert.rejects(parseDepositPlan({ ...result, remainingOutputs: 0 }, f.policy, request));
});
test('deposit HTTP route rejects private data, honours budgets and validates against independently supplied policy', async t => {
  const f = fixture(); f.source.finalBlock = async () => ({ hash: 'B'.repeat(44), height: 20 });
  const server = createReadOnlyApi({ source: f.source, policy: f.policy }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${address.port}`, request = { commitment: '42', disclosureRoot: root }, client = new HttpGateway(url);
  assert.equal((await client.prepareDeposit(f.policy, request)).plan.tokenCall.args.receiver_id, f.vault);
  for (const extra of [{ secret: 'do-not-leak' }, { nullifier: '123' }, { note: {} }, { rpcUrl: 'http://internal.local' }]) {
    const r = await fetch(url + '/v1/deposits/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, ...extra }) });
    assert.equal(r.status, 400); assert.ok(!(await r.text()).includes('do-not-leak'));
  }
  await assert.rejects(client.prepareDeposit({ ...f.policy, feeRecipient: f.payer }, request), /policy/);
  await assert.rejects(client.prepareDeposit(f.policy, request, { signal: AbortSignal.abort() }), /abort/i);
  const r = await fetch(url + '/v1/deposits/prepare?private=not-allowed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }); assert.equal(r.status, 400);
  const limited = createReadOnlyApi({ source: f.source, policy: f.policy, limits: { maxRpcReads: 2 } });
  limited.listen(0, '127.0.0.1'); await once(limited, 'listening');
  t.after(async () => { limited.closeAllConnections(); await new Promise<void>(resolve => limited.close(() => resolve())); });
  const limitedAddress = limited.address(); assert.ok(limitedAddress && typeof limitedAddress !== 'string');
  const rejected = await fetch(`http://127.0.0.1:${limitedAddress.port}/v1/deposits/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, 'RPC_BUDGET_EXCEEDED');
});
