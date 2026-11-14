import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [filename, keyId = 'initial', ...extra] = process.argv.slice(2);
if (!filename || extra.length || !/^[A-Za-z0-9_-]{1,48}$/.test(keyId)) {
  console.error('Usage: node scripts/organization-invoice-keys.mjs NEW_FILE [KEY_ID]'); process.exit(1);
}
const path = resolve(filename);
try {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ format: 'core-organization-invoice-keys-v1', activeKeyId: keyId,
      indexKey: randomBytes(32).toString('base64url'), keys: { [keyId]: randomBytes(32).toString('base64url') } }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  console.log(JSON.stringify({ file: path, activeKeyId: keyId }));
} catch { console.error('Could not create invoice keys; use a new writable file path'); process.exit(1); }
