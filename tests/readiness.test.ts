import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadOnlyApi } from '../server/api.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { indexFixture } from './fixtures/indexer.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { indexed?: boolean; attached?: boolean; requireIndex?: boolean } = {}) {
  const f = indexFixture(), store = new IndexStore(':memory:', f.policy), worker = new SettlementIndexer(f.source, store);
  f.records.push(f.record(0));
  if (options.indexed !== false) await worker.sync();
  const server = createReadOnlyApi({ source: f.source, policy: f.policy, index: options.attached === false ? undefined : store, readiness: { requireIndex: options.requireIndex } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  return { ...f, store, worker, url: `http://127.0.0.1:${address.port}` };
}

test('readiness verifies one pinned deployment snapshot and compares the configured index', async t => {
  const f = await fixture(t); f.reads.length = 0;
  const response = await fetch(f.url + '/readyz'), ready = await response.json();
  assert.equal(response.status, 200); assert.equal(ready.ready, true); assert.equal(ready.deploymentVerified, true);
  assert.equal(ready.index.indexedRecords, 1); assert.equal(ready.index.provenanceChecked, false); assert.equal(ready.chainFreshnessChecked, false);
  assert.ok(f.reads.length > 0); assert.deepEqual(new Set(f.reads.map(r => r.block)), new Set([ready.checkedAtBlock.hash]));
  assert.equal((await fetch(f.url + '/readyz?rpcUrl=http://internal')).status, 400);
});

test('missing or uninitialized required indexes never report ready', async t => {
  const missing = await fixture(t, { attached: false, requireIndex: true });
  let response = await fetch(missing.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_DISABLED');
  const uninitialized = await fixture(t, { indexed: false });
  response = await fetch(uninitialized.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_NOT_READY');
  const optional = await fixture(t, { attached: false });
  response = await fetch(optional.url + '/readyz'); assert.equal(response.status, 200); assert.deepEqual((await response.json()).index, { enabled: false });
});

test('readiness catches new records missing from a previously complete index and recovers after sync', async t => {
  const f = await fixture(t); f.state.height++; f.records.push(f.record(1));
  let response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_BEHIND');
  await f.worker.sync(); response = await fetch(f.url + '/readyz'); assert.equal(response.status, 200);
  assert.equal((await response.json()).index.indexedRecords, 2);
});

test('readiness rejects stale time, block lag and a conflicting finalized checkpoint', async t => {
  const f = await fixture(t), original = f.store.status.bind(f.store);
  f.store.status = () => {
    const status = original(); return { ...status, checkpoint: { ...status.checkpoint!, updatedAt: new Date(Date.now() - 61000).toISOString() } };
  };
  let response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_STALE');
  f.store.status = original; f.state.height += 101;
  response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_STALE');
  f.state.height = 19;
  response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_AHEAD');
  f.state.height = 20;
  f.store.status = () => { const status = original(); return { ...status, checkpoint: { ...status.checkpoint!, block: { ...status.checkpoint!.block, hash: 'C'.repeat(44) } } }; };
  response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'INDEX_FINALITY_CONFLICT');
});

test('deployment and index failures are redacted while liveness remains available', async t => {
  const f = await fixture(t);
  f.store.status = () => { throw new Error('sensitive database filename or token'); };
  let response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'INDEX_READ_FAILED', ready: false });
  f.source.accessKeys = async () => [{}];
  response = await fetch(f.url + '/readyz'); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'CHAIN_READ_FAILED', ready: false });
  const health = await fetch(f.url + '/healthz'); assert.equal(health.status, 200); assert.equal((await health.json()).chainReadinessChecked, false);
});
