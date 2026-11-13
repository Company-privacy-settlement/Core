import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, chmodSync, closeSync, copyFileSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { IndexStore } from '../../sdk/indexer/store.js';
import type { SharedPolicy } from '../../sdk/shared.js';
import { canonical } from '../../sdk/client/crypto.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
function regular(path: string) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error('Expected a regular index file'); }
export async function fileDigest(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
function inspect(path: string, policy: SharedPolicy) {
  regular(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try { if ((db.prepare('PRAGMA quick_check').get() as any)?.quick_check !== 'ok') throw new Error('Backup SQLite integrity check failed'); } finally { db.close(); }
  const store = new IndexStore(path, policy, true); try { return store.status(); } finally { store.close(); }
}
function syncFile(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
export async function backupIndex(source: string, destination: string, policy: SharedPolicy) {
  inspect(source, policy);
  const target = resolve(destination); if (existsSync(target)) throw new Error('Backup destination already exists');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomUUID() + '.tmp'; closeSync(openSync(temp, 'wx', 0o600));
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, temp);
    const status = inspect(temp, policy); syncFile(temp);
    const sha256 = await fileDigest(temp); linkSync(temp, target); syncFile(dirname(target));
    return { format: 'core-index-backup-v1' as const, file: target, bytes: statSync(target).size, sha256,
      policySha256: createHash('sha256').update(canonical(policy)).digest('hex'), status, createdAt: new Date().toISOString() };
  } finally { db.close(); rmSync(temp, { force: true }); rmSync(temp + '-wal', { force: true }); rmSync(temp + '-shm', { force: true }); }
}
export async function restoreIndex(source: string, expectedSha256: string, destination: string, policy: SharedPolicy) {
  Hash.parse(expectedSha256); regular(source);
  if (await fileDigest(source) !== expectedSha256) throw new Error('Backup differs from the independently trusted digest');
  const target = resolve(destination);
  if ([target, target + '-wal', target + '-shm'].some(existsSync)) throw new Error('Restore requires an empty data directory; never overwrite a live index');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomUUID() + '.restore';
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o600);
    if (await fileDigest(temp) !== expectedSha256) throw new Error('Backup changed while restoring');
    const status = inspect(temp, policy);
    syncFile(temp); linkSync(temp, target); syncFile(dirname(target));
    return { restored: true, file: target, sha256: expectedSha256, status };
  } finally { rmSync(temp, { force: true }); rmSync(temp + '-wal', { force: true }); rmSync(temp + '-shm', { force: true }); }
}
export async function rotateBackup(db: string, directory: string, policy: SharedPolicy, keep: number) {
  z.number().int().min(1).max(90).parse(keep);
  const filename = `core-index-${Date.now()}-${randomUUID()}.sqlite`, target = resolve(directory, filename);
  const result = await backupIndex(db, target, policy);
  writeFileSync(target + '.json', JSON.stringify({ ...result, file: filename }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const owned = readdirSync(directory).filter(f => /^core-index-\d+-[0-9a-f-]{36}\.sqlite\.json$/.test(f)).sort((a, b) => b.localeCompare(a));
  const ordered = [filename + '.json', ...owned.filter(n => n !== filename + '.json')];
  for (const name of ordered.slice(keep)) {
    const manifestFile = resolve(directory, name), file = manifestFile.slice(0, -5);
    try {
      regular(manifestFile); regular(file);
      const meta = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (meta.format !== 'core-index-backup-v1' || meta.file !== name.slice(0, -5) || meta.policySha256 !== result.policySha256 || await fileDigest(file) !== meta.sha256) continue;
      rmSync(file); rmSync(manifestFile);
    } catch { /* Never prune unrelated, malformed or tampered files. */ }
  }
  return result;
}
