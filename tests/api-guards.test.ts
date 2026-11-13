import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { ApiLimits, HttpError, PeerRateLimiter } from '../server/guards.js';
import { createReadOnlyApi } from '../server/api.js';
import { serverSettings } from '../server/settings.js';
import { NearRpcOperationsSource } from '../sdk/operations.js';
import { operationsFixture } from './fixtures/operations.js';

async function listen(t: { after(fn: () => Promise<void>): void }, server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${address.port}`;
}

test('peer rate state is bounded, rejects overflow, and reclaims expired windows', () => {
  let clock = 0;
  const limiter = new PeerRateLimiter(ApiLimits.parse({ ratePoints: 5, maxClients: 1, rateWindowMs: 1000 }), () => clock);
  assert.equal(limiter.take('peer-a', 3).remaining, 2);
  assert.throws(() => limiter.take('peer-a', 3), (e: unknown) => e instanceof HttpError && e.code === 'RATE_LIMITED' && e.retryAfter === 1);
  assert.throws(() => limiter.take('peer-b', 1), (e: unknown) => e instanceof HttpError && e.code === 'RATE_LIMIT_CAPACITY');
  clock = 1000; assert.equal(limiter.take('peer-b', 5).remaining, 0);
});

test('API charges expensive reads, ignores spoofed forwarding headers and keeps liveness available', async t => {
  const f = operationsFixture(), url = await listen(t, createReadOnlyApi({ source: f.source, policy: f.policy, limits: { ratePoints: 5 } }));
  let response = await fetch(url + '/v1/vaults'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('ratelimit-remaining'), '0');
  response = await fetch(url + '/v1/config', { headers: { 'x-forwarded-for': '203.0.113.22', forwarded: 'for=198.51.100.2' } });
  assert.equal(response.status, 429); assert.equal((await response.json()).error, 'RATE_LIMITED');
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.equal((await fetch(url + '/healthz')).status, 200); assert.equal(f.state.snapshots, 1);
});

test('API read budget stops fan-out before exceeding the configured number of source calls', async t => {
  const f = operationsFixture(), url = await listen(t, createReadOnlyApi({ source: f.source, policy: f.policy, limits: { maxRpcReads: 2 } }));
  const response = await fetch(url + '/v1/vaults');
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'RPC_BUDGET_EXCEEDED');
  assert.ok(f.reads.length + f.state.snapshots <= 2);
  assert.equal((await fetch(url + '/healthz')).status, 200);
});

test('timeouts retain concurrency slots until non-cancellable reads settle', async t => {
  const f = operationsFixture(), original = f.source.finalBlock;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.source.finalBlock = async () => { await gate; return original(); };
  const url = await listen(t, createReadOnlyApi({ source: f.source, policy: f.policy, maxConcurrent: 1, limits: { timeoutMs: 100 } }));
  try {
    const first = await fetch(url + '/v1/vaults'); assert.equal(first.status, 504);
    assert.equal((await first.json()).error, 'REQUEST_TIMEOUT');
    assert.equal((await fetch(url + '/v1/vaults')).status, 429);
    assert.equal((await fetch(url + '/healthz')).status, 200);
  } finally { release(); }
  // An HTTP round trip also allows the released adapter and its slot to settle.
  await fetch(url + '/healthz');
  assert.equal((await fetch(url + '/v1/vaults')).status, 200);
});

test('API deadline cancels the actual HTTP RPC transport', async t => {
  let disconnected!: () => void, entered!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const rpcUrl = await listen(t, createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume JSON but deliberately stall the RPC response */ }
    res.once('close', disconnected); entered();
  }));
  const f = operationsFixture(), sourceFactory = (signal?: AbortSignal) => new NearRpcOperationsSource(f.policy.network, f.policy.registry, rpcUrl, signal);
  const url = await listen(t, createReadOnlyApi({ policy: f.policy, source: sourceFactory(), sourceFactory, limits: { timeoutMs: 200 } }));
  const response = fetch(url + '/v1/vaults'); await started;
  assert.equal((await response).status, 504);
  await Promise.race([closed, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('RPC transport was not cancelled')), 2000); timer.unref(); })]);
});

test('slow JSON uploads time out without starting chain reads or blocking liveness', async t => {
  const f = operationsFixture(), url = await listen(t, createReadOnlyApi({ source: f.source, policy: f.policy, limits: { timeoutMs: 100 } }));
  const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request(url + '/v1/ft/preflight', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject); req.write('{');
  });
  assert.equal(response.status, 504); assert.equal(JSON.parse(response.body).error, 'REQUEST_TIMEOUT');
  assert.equal(f.state.snapshots, 0); assert.equal((await fetch(url + '/healthz')).status, 200);
});

test('a disconnected client cancels its request source and permits subsequent work', async t => {
  const f = operationsFixture(); let entered!: () => void, cancelled!: () => void, requests = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const sourceFactory = (signal: AbortSignal) => ({ ...f.source, finalBlock: async () => {
    if (++requests > 1) return f.source.finalBlock();
    entered();
    await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true }));
    return f.source.finalBlock();
  } });
  const url = await listen(t, createReadOnlyApi({ policy: f.policy, source: f.source, sourceFactory, maxConcurrent: 1 }));
  const controller = new AbortController(), response = fetch(url + '/v1/vaults', { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(response);
  await Promise.race([stopped, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Disconnect did not cancel the source')), 2000); timer.unref(); })]);
  await fetch(url + '/healthz'); assert.equal((await fetch(url + '/v1/vaults')).status, 200);
});

test('settings fail closed on invalid environment values instead of silently coercing them', () => {
  const settings = serverSettings({ CORE_API_REQUIRE_INDEX: 'false', CORE_API_TIMEOUT_MS: '1000', CORE_API_MAX_RPC_READS: '20' });
  assert.equal(settings.readiness.requireIndex, false); assert.equal(settings.limits.timeoutMs, 1000); assert.equal(settings.limits.maxRpcReads, 20);
  assert.equal(serverSettings({ CORE_API_REQUIRE_INDEX: 'true' }).readiness.requireIndex, true);
  for (const env of [{ CORE_API_REQUIRE_INDEX: 'yes' }, { CORE_API_TIMEOUT_MS: '' }, { CORE_API_MAX_CONCURRENT: '0' }, { CORE_API_RATE_POINTS: 'Infinity' }, { CORE_API_MAX_CLIENTS: '1.5' }]) assert.throws(() => serverSettings(env));
});
