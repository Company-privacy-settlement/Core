import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { z } from 'zod';

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(s => Buffer.from(s, 'base64url').toString('base64url') === s);
const KeyId = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/);
const Format = z.object({ format: z.literal('core-organization-invoice-keys-v1'), activeKeyId: KeyId,
  indexKey: Key, keys: z.record(KeyId, Key) }).strict();
export type InvoiceKeys = { activeKeyId: string; indexKey: Buffer; keys: ReadonlyMap<string, Buffer> };
/** Keys live outside the database and its backups. No default encryption key. */
export function loadInvoiceKeys(filename: string): InvoiceKeys {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) || st.size > 8192 || (process.getuid && st.uid !== process.getuid())) throw new Error('Invoice keys require an owner-only regular file');
    const value = Format.parse(JSON.parse(readFileSync(fd, 'utf8')));
    const entries = Object.entries(value.keys);
    if (!entries.length || entries.length > 16 || !Object.hasOwn(value.keys, value.activeKeyId) || new Set([value.indexKey, ...entries.map(e => e[1])]).size !== entries.length + 1) throw new Error('Invalid invoice key ring');
    return { activeKeyId: value.activeKeyId, indexKey: Buffer.from(value.indexKey, 'base64url'), keys: new Map(entries.map(([id, key]) => [id, Buffer.from(key, 'base64url')])) };
  } catch { throw new Error('Invalid or inaccessible invoice key file'); } finally { closeSync(fd); }
}
export function keyedHash(key: Buffer, value: string): string { return createHmac('sha256', key).update(value).digest('hex'); }
