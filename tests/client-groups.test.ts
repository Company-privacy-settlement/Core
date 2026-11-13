import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { parseApprovedGroups, parseGroupCapacity, HttpGateway, CoreApiError } from '../sdk/client/index.js';
import { ApprovedGroupsSchema } from '../sdk/groups.js';
import { createReadOnlyApi } from '../server/api.js';
import { groupDirectory, groupFixture } from './fixtures/groups.js';
import { operationsFixture } from './fixtures/operations.js';
const hash = 'B'.repeat(44);
function snapshot() {
  const { policy } = operationsFixture();
  return { policy, checkedAtBlock: { hash, height: 20 }, capacity: 256, usedOutputs: 2, remainingOutputs: 254, outstandingNotes: 2,
    depositCapacityAvailable: true, depositVaultObserved: true, checkedVaults: 1, vaultScanComplete: true, chainFreshnessChecked: false };
}

test('browser approval parsing matches Node directories and rejects hidden endpoints, mixed families and secrets', () => {
  for (const native of [false, true]) {
    const { directory } = groupDirectory(groupFixture('original', native), groupFixture('next', native));
    assert.deepEqual(parseApprovedGroups(directory), ApprovedGroupsSchema.parse(directory));
    const malformed = [
      { ...directory, rpcUrl: 'https://untrusted.example' }, { version: 1, groups: [] }, { version: 1, groups: [...directory.groups, directory.groups[0]] },
      { version: 1, groups: [{ ...directory.groups[0], api: 'https://untrusted.example' }] },
      { version: 1, groups: [{ ...directory.groups[0], depositsEnabled: 'false' }] },
      { version: 1, groups: [directory.groups[0], { ...directory.groups[1], policy: { ...directory.groups[1].policy, network: 'testnet' } }] },
      { version: 1, groups: [directory.groups[0], { ...directory.groups[1], policy: { ...directory.groups[1].policy, tokenId: 'other.test.near' } }] },
    ];
    for (const value of malformed) assert.throws(() => parseApprovedGroups(value));
  }
});

test('capacity validation binds every trust pin and rejects contradictory counts and availability', () => {
  const valid = snapshot(); assert.deepEqual(parseGroupCapacity(valid, valid.policy), valid);
  for (const change of [
    { capacity: 512 }, { remainingOutputs: 255 }, { usedOutputs: 257 }, { usedOutputs: -1 }, { outstandingNotes: 3 },
    { depositCapacityAvailable: false }, { checkedVaults: 0 }, { checkedVaults: 2 }, { chainFreshnessChecked: true }, { privateNote: 'not accepted' },
    { policy: { ...valid.policy, feeRecipient: 'other.test.near' } }, { policy: { ...valid.policy, verifierSha256: 'dd'.repeat(32) } },
    { checkedAtBlock: { hash: 'invalid', height: 20 } },
  ]) assert.throws(() => parseGroupCapacity({ ...valid, ...change }, valid.policy));
  assert.equal(parseGroupCapacity({ ...valid, usedOutputs: 256, remainingOutputs: 0, depositCapacityAvailable: false, depositVaultObserved: false }, valid.policy).remainingOutputs, 0);
  assert.equal(parseGroupCapacity({ ...valid, depositVaultObserved: false, checkedVaults: 0, vaultScanComplete: false }, valid.policy).depositVaultObserved, false);
});

async function api(t: { after(fn: () => Promise<void>): void }, ratePoints = 120) {
  const f = operationsFixture(); f.source.finalBlock = async () => ({ hash, height: 20 });
  const server = createReadOnlyApi({ source: f.source, policy: f.policy, limits: { ratePoints } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${address.port}`;
  return { ...f, origin, gateway: new HttpGateway(origin) };
}
test('browser capacity checks verify policy and real API reads, distinguish full trees and expose partial membership scope', async t => {
  const f = await api(t);
  let capacity = await f.gateway.groupCapacity(f.policy);
  assert.equal(capacity.remainingOutputs, 254); assert.equal(capacity.depositVaultObserved, true);
  assert.deepEqual(new Set(f.reads.map(r => r.block)), new Set([hash]));
  f.config.leaf_count = 256; capacity = await f.gateway.groupCapacity(f.policy);
  assert.equal(capacity.depositCapacityAvailable, false); assert.equal(capacity.depositVaultObserved, false);
  f.config.leaf_count = 2; f.record.state = 'Pending'; f.config.vault_count = 2;
  capacity = await f.gateway.groupCapacity(f.policy);
  assert.equal(capacity.depositCapacityAvailable, true); assert.equal(capacity.checkedVaults, 0); assert.equal(capacity.vaultScanComplete, false);
  assert.equal((await fetch(f.origin + '/v1/group/capacity?rpcUrl=http://internal')).status, 400);
  await assert.rejects(f.gateway.groupCapacity({ ...f.policy, treasury: 'invalid' } as typeof f.policy));
  f.source.accessKeys = async () => [{}];
  await assert.rejects(f.gateway.groupCapacity(f.policy), (error: unknown) => error instanceof CoreApiError && error.status === 502);
});

test('capacity reads expose bounded retry metadata without retrying a rate-limited request', async t => {
  const f = await api(t, 5);
  await assert.rejects(f.gateway.groupCapacity(f.policy), (error: unknown) => error instanceof CoreApiError && error.status === 429 && error.code === 'RATE_LIMITED' && Number(error.retryAfterSeconds) > 0);
  assert.equal(f.reads.length, 0);
});

test('cancelling a browser group check stops between policy and capacity requests', async t => {
  const f = operationsFixture(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), paths: string[] = [];
  const server = createServer((req, _res) => { paths.push(req.url!); entered(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const controller = new AbortController(), request = new HttpGateway(`http://127.0.0.1:${address.port}`).groupCapacity(f.policy, { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(request);
  assert.deepEqual(paths, ['/v1/config']);
});
