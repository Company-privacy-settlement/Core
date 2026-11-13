import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { IndexStore } from '../../sdk/indexer/store.js';
import { digest } from '../../scripts/lib/release.js';
import { indexFixture, blockHash } from '../fixtures/indexer.js';

const temporary = mkdtempSync(resolve(tmpdir(), 'core-service-runtime-')), f = indexFixture(true);
const registryCode = Buffer.from('service-fixture-registry'), vaultCode = Buffer.from('service-fixture-vault');
f.policy.registryWasmSha256 = digest(registryCode); f.policy.vaultWasmSha256 = digest(vaultCode); f.config.vault_wasm_sha256 = f.policy.vaultWasmSha256;
f.records.push(f.record(0));
let hang = false;
const rpc = createServer(async (req, res) => {
  if (hang) return;
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const { id, method, params: p } = JSON.parse(body); let result: unknown;
    if (method === 'status') result = { chain_id: 'test-chain-service-runtime', sync_info: { syncing: false, latest_block_time: new Date().toISOString() } };
    else if (method === 'block') { const height = typeof p.block_id === 'number' ? p.block_id : f.state.height; result = { header: { hash: blockHash(height), height } }; }
    else if (method === 'query') {
      if (p.request_type === 'view_code') result = { code_base64: (p.account_id === f.policy.registry ? registryCode : vaultCode).toString('base64') };
      else if (p.request_type === 'view_access_key_list') result = { keys: [] };
      else {
        const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
        const value = p.method_name === 'get_config' ? p.account_id === f.policy.registry ? await f.source.config(p.block_id) : await f.source.vaultConfig(p.account_id, p.block_id)
          : p.method_name === 'list_vaults' ? await f.source.records(args.from_index, args.limit, p.block_id)
          : await f.source.contractView(p.account_id, p.method_name, args, p.block_id);
        result = { result: [...Buffer.from(JSON.stringify(value))] };
      }
    } else throw new Error('Unexpected fixture RPC method');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  } catch { res.statusCode = 500; res.end('{}'); }
});
rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening'); const address = rpc.address(); assert.ok(address && typeof address !== 'string');
const publicPolicy = JSON.stringify(f.policy), policyFile = resolve(temporary, 'policy.json'); writeFileSync(policyFile, publicPolicy);
async function freePort() { const s = createTcpServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const a = s.address(); assert.ok(a && typeof a !== 'string'); await new Promise<void>(r => s.close(() => r())); return a.port; }
let port = await freePort();
const env: NodeJS.ProcessEnv = { ...process.env, CORE_POLICY_FILE: policyFile, CORE_POLICY_SHA256: digest(publicPolicy), CORE_DATA_DIR: resolve(temporary, 'data'), CORE_SERVICE_NETWORK: 'sandbox', CORE_API_HOST: '127.0.0.1', PORT: String(port), CORE_ALLOWED_ORIGINS: 'http://localhost:3000', CORE_RPC_URL: `http://127.0.0.1:${address.port}`, CORE_INDEX_INTERVAL_MS: '1000', CORE_BACKUP_INTERVAL_MS: '0', CORE_SERVICE_SHUTDOWN_MS: '3000' };
delete env.CORE_POLICY_JSON; delete env.CORE_INDEX_DB; delete env.CORE_DEPLOY_KEY_FILE; delete env.CORE_NOTE_PASSWORD; delete env.CORE_RECEIPT_PASSWORD;
function start(overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['scripts/start-service.mjs'], { env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, exited, logs: () => logs };
}
type Running = ReturnType<typeof start>;
async function stop(running: Running) {
  if (running.child.exitCode !== null) return;
  running.child.kill('SIGTERM');
  const code = await Promise.race([running.exited, delay(7000, 'timeout')]);
  if (code === 'timeout') { try { process.kill(-running.child.pid!, 'SIGKILL'); } catch {} throw new Error('Service failed to stop promptly'); }
  assert.equal(code, 0, running.logs());
}
async function api(path: string) { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) }); return { status: r.status, body: await r.json() }; }
async function ready(running: Running, count: number) {
  for (let i = 0; i < 150; i++) {
    if (running.child.exitCode !== null) throw new Error(running.logs());
    try { const result = await api('/readyz'); if (result.status === 200 && result.body.index.indexedRecords === count) return; } catch {}
    await delay(100);
  }
  throw new Error('Readiness timed out: ' + running.logs());
}
let running: Running | undefined;
try {
  running = start(); await ready(running, 1);
  assert.equal((await api('/v1/config')).body.policy.registry, f.policy.registry);
  f.records.push(f.record(1)); f.state.height++; await ready(running, 2);
  const duplicate = start({ PORT: String(await freePort()) }); assert.equal(await duplicate.exited, 1, 'Exclusive writer lock must reject a second service');
  const backupFile = resolve(temporary, 'snapshot.sqlite');
  const backup = JSON.parse((await promisify(execFile)(process.execPath, ['scripts/index-maintenance.mjs', 'backup', backupFile], { env })).stdout);
  assert.ok(backup.sha256);
  await assert.rejects(() => promisify(execFile)(process.execPath, ['scripts/index-maintenance.mjs', 'restore', backupFile, backup.sha256], { env }));
  hang = true; await delay(1500); const stoppedAt = Date.now(); await stop(running); assert.ok(Date.now() - stoppedAt < 7000); hang = false;
  running = start(); await ready(running, 2); await stop(running); running = undefined;
  const restoredData = resolve(temporary, 'restored');
  await promisify(execFile)(process.execPath, ['scripts/index-maintenance.mjs', 'restore', backupFile, backup.sha256], { env: { ...env, CORE_DATA_DIR: restoredData } });
  const restored = new IndexStore(resolve(restoredData, 'activity.sqlite'), f.policy, true);
  try { assert.equal((restored.status() as { indexedRecords: number }).indexedRecords, 2); } finally { restored.close(); }
  console.log('Compiled service runtime passed: indexed readiness, persistent restart, exclusive writer, online backup, protected restore and RPC-abort shutdown. Mock RPC, no public deployment.');
} finally {
  if (running && running.child.exitCode === null) try { await stop(running); } catch {}
  rpc.closeAllConnections(); await new Promise<void>(r => rpc.close(() => r())); rmSync(temporary, { recursive: true, force: true });
}
