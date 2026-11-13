import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../scripts/lib/release.js';
import { loadServiceConfig } from '../scripts/lib/service-config.js';
import { backupIndex, restoreIndex, rotateBackup } from '../scripts/lib/index-backup.js';
import { runBootstrap, superviseService } from '../scripts/lib/service-processes.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { indexFixture } from './fixtures/indexer.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-hosting-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = indexFixture(true), policyFile = resolve(dir, 'policy.json'), bytes = JSON.stringify(f.policy);
  writeFileSync(policyFile, bytes);
  const env = { CORE_POLICY_FILE: policyFile, CORE_POLICY_SHA256: digest(bytes), CORE_DATA_DIR: resolve(dir, 'data'), CORE_SERVICE_NETWORK: 'sandbox', CORE_API_HOST: '127.0.0.1', CORE_ALLOWED_ORIGINS: 'http://localhost:3000', CORE_RPC_URL: 'http://127.0.0.1:3030' };
  return { ...f, dir, env, policyFile, bytes };
}
test('hosted configuration pins an immutable policy copy and requires a durable read-only indexed API', t => {
  const f = fixture(t), config = loadServiceConfig(f.env);
  assert.equal(config.childEnv.CORE_API_REQUIRE_INDEX, 'true'); assert.equal(config.db, resolve(f.env.CORE_DATA_DIR, 'activity.sqlite'));
  writeFileSync(f.policyFile, '{}'); assert.equal(readFileSync(config.policyFile, 'utf8'), f.bytes);
  assert.throws(() => loadServiceConfig(f.env), /DIGEST_MISMATCH/);
  const inline = loadServiceConfig({ ...f.env, CORE_POLICY_FILE: undefined, CORE_POLICY_JSON: f.bytes });
  assert.equal(inline.childEnv.CORE_POLICY_JSON, undefined); assert.equal(readFileSync(inline.policyFile, 'utf8'), f.bytes);
});
test('hosted configuration rejects missing trust, secrets, disabled index and public sandbox binding', t => {
  const f = fixture(t);
  for (const change of [
    { CORE_POLICY_SHA256: undefined }, { CORE_POLICY_SHA256: '0'.repeat(64) }, { CORE_DEPLOY_KEY_FILE: 'never-read-this-file' },
    { CORE_NOTE_PASSWORD: 'never-retain-this-value' }, { CORE_API_REQUIRE_INDEX: 'false' }, { CORE_API_HOST: '0.0.0.0' },
    { CORE_SERVICE_NETWORK: 'testnet' }, { CORE_ALLOWED_ORIGINS: '*' }, { CORE_ALLOWED_ORIGINS: 'https://front.example/path' },
    { CORE_ALLOWED_ORIGINS: 'http://public.example' }, { CORE_RPC_URL: 'https://user:password@rpc.example' },
    { CORE_INDEX_DB: resolve(f.dir, 'unrelated.sqlite') },
    { CORE_BACKUP_INTERVAL_MS: '' }, { CORE_DISCOVERY_START_HEIGHT: '' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ]) assert.throws(() => loadServiceConfig({ ...f.env, ...change }));
});
test('online backups include a consistent WAL snapshot and restore only a pinned policy into a new destination', async t => {
  const f = fixture(t), db = resolve(f.dir, 'index.sqlite'), target = resolve(f.dir, 'backup.sqlite');
  const store = new IndexStore(db, f.policy), worker = new SettlementIndexer(f.source, store);
  t.after(() => store.close());
  f.records.push(f.record(0)); await worker.sync();
  const pending = backupIndex(db, target, f.policy);
  f.records.push(f.record(1)); f.state.height++; await worker.sync();
  const backup = await pending, restored = resolve(f.dir, 'restored.sqlite');
  await restoreIndex(target, backup.sha256, restored, f.policy);
  const copy = new IndexStore(restored, f.policy, true);
  try { const status = copy.status() as { indexedRecords: number }; assert.ok([1, 2].includes(status.indexedRecords)); } finally { copy.close(); }
  await assert.rejects(() => restoreIndex(target, backup.sha256, restored, f.policy), /empty/);
  await assert.rejects(() => backupIndex(db, target, f.policy), /already exists/);
});
test('restore rejects checksum/policy substitution and never publishes an invalid backup', async t => {
  const f = fixture(t), db = resolve(f.dir, 'index.sqlite'), target = resolve(f.dir, 'backup.sqlite'), store = new IndexStore(db, f.policy);
  t.after(() => store.close()); await new SettlementIndexer(f.source, store).sync();
  const backup = await backupIndex(db, target, f.policy), restored = resolve(f.dir, 'restored.sqlite');
  await assert.rejects(() => restoreIndex(target, '0'.repeat(64), restored, f.policy), /trusted digest/);
  await assert.rejects(() => restoreIndex(target, backup.sha256, restored, { ...f.policy, feeRecipient: 'substituted.test.near' }));
  assert.equal(existsSync(restored), false);
  writeFileSync(target, 'changed backup'); await assert.rejects(() => restoreIndex(target, backup.sha256, restored, f.policy), /trusted digest/);
});
test('rotation removes only verified service-owned older backups and preserves the latest copy', async t => {
  const f = fixture(t), db = resolve(f.dir, 'index.sqlite'), store = new IndexStore(db, f.policy), backupDir = resolve(f.dir, 'backups');
  t.after(() => store.close()); await new SettlementIndexer(f.source, store).sync();
  await rotateBackup(db, backupDir, f.policy, 2); await rotateBackup(db, backupDir, f.policy, 2);
  writeFileSync(resolve(backupDir, 'keep-me.sqlite'), 'unrelated file');
  const last = await rotateBackup(db, backupDir, f.policy, 2);
  assert.equal(existsSync(last.file), true); assert.equal(existsSync(resolve(backupDir, 'keep-me.sqlite')), true);
  assert.equal(readdirSync(backupDir).filter(n => n.endsWith('.sqlite.json')).length, 2);
});
test('service bootstrap treats failures and timeouts as startup failures', async () => {
  const env = { PATH: process.env.PATH };
  await runBootstrap({ file: process.execPath, args: ['-e', 'process.exit(0)'] }, env, new AbortController().signal, 5000);
  await assert.rejects(() => runBootstrap({ file: process.execPath, args: ['-e', 'process.exit(1)'] }, env, new AbortController().signal, 5000), /BOOTSTRAP_FAILED/);
  await assert.rejects(() => runBootstrap({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, env, new AbortController().signal, 100), /TIMEOUT/);
});
test('an unexpected API exit stops the indexer instead of leaving an unsupervised writer', async t => {
  const f = fixture(t), ready = resolve(f.dir, 'writer-ready'), stopped = resolve(f.dir, 'writer-stopped');
  const worker = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});setInterval(()=>{},1000)`;
  const api = `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)}))process.exit(0)},10)`;
  await assert.rejects(() => superviseService({ api: { file: process.execPath, args: ['-e', api] }, indexer: { file: process.execPath, args: ['-e', worker] } }, { PATH: process.env.PATH }, new AbortController().signal, 1000), /API_EXITED/);
  assert.equal(readFileSync(stopped, 'utf8'), 'stopped');
});
test('graceful shutdown stops the API before the writer', async t => {
  const f = fixture(t), apiReady = resolve(f.dir, 'api-ready'), workerReady = resolve(f.dir, 'worker-ready'), apiStopped = resolve(f.dir, 'api-stopped'), workerStopped = resolve(f.dir, 'worker-stopped');
  const api = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(apiReady)},'ready');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(apiStopped)},'stopped');process.exit(0)});setInterval(()=>{},1000)`;
  const worker = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(workerReady)},'ready');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(workerStopped)},String(fs.existsSync(${JSON.stringify(apiStopped)})));process.exit(0)});setInterval(()=>{},1000)`;
  const controller = new AbortController(), running = superviseService({ api: { file: process.execPath, args: ['-e', api] }, indexer: { file: process.execPath, args: ['-e', worker] } }, { PATH: process.env.PATH }, controller.signal, 1000);
  for (let i = 0; i < 100 && (!existsSync(apiReady) || !existsSync(workerReady)); i++) await delay(20);
  assert.equal(existsSync(apiReady), true); assert.equal(existsSync(workerReady), true);
  controller.abort(); await running; assert.equal(readFileSync(workerStopped, 'utf8'), 'true');
});
