import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { sha256 } from './core.js';

export const RECEIPT_FIELDS = ['sender', 'recipient', 'asset', 'amount', 'purpose', 'reference', 'occurredAt', 'credentialHash'] as const;
export type ReceiptField = typeof RECEIPT_FIELDS[number];
export type Opening = { field: ReceiptField; value: string; salt: string; siblings: string[] };
export type Receipt = { version: 1; root: string; openings: Opening[] };
function leaf(field: string, value: string, salt: string): string { return sha256(JSON.stringify(['core:receipt:v1', field, value, salt])); }
function branch(left: string, right: string): string { return sha256(`core:receipt:node:v1|${left}|${right}`); }
export function createReceipt(values: Record<ReceiptField, string>): Receipt {
  const salts = RECEIPT_FIELDS.map(() => randomBytes(32).toString('hex'));
  const levels = [RECEIPT_FIELDS.map((f, i) => {
    if (typeof values[f] !== 'string' || values[f].length > 4096) throw new Error('Invalid receipt value');
    return leaf(f, values[f], salts[i]);
  })];
  while (levels.at(-1)!.length > 1) {
    const last = levels.at(-1)!, next: string[] = [];
    for (let i = 0; i < last.length; i += 2) next.push(branch(last[i], last[i + 1]));
    levels.push(next);
  }
  return { version: 1, root: levels.at(-1)![0], openings: RECEIPT_FIELDS.map((f, i) => {
    let index = i;
    const siblings = levels.slice(0, -1).map(level => { const sibling = level[index ^ 1]; index >>= 1; return sibling; });
    return { field: f, value: values[f], salt: salts[i], siblings };
  }) };
}
export function disclose(receipt: Receipt, fields: ReceiptField[]): Receipt {
  return { version: 1, root: receipt.root, openings: receipt.openings.filter(o => fields.includes(o.field)) };
}
export function verifyDisclosure(receipt: Receipt, expectedRoot: string): boolean {
  if (receipt.version !== 1 || !/^[0-9a-f]{64}$/.test(expectedRoot) || receipt.root !== expectedRoot || receipt.openings.length === 0) return false;
  const seen = new Set<string>();
  return receipt.openings.every(o => {
    let index = RECEIPT_FIELDS.indexOf(o.field);
    if (index < 0 || seen.has(o.field) || !/^[0-9a-f]{64}$/.test(o.salt) || o.siblings.length !== 3 || o.siblings.some(x => !/^[0-9a-f]{64}$/.test(x))) return false;
    seen.add(o.field);
    let h = leaf(o.field, o.value, o.salt);
    for (const sibling of o.siblings) { h = index & 1 ? branch(sibling, h) : branch(h, sibling); index >>= 1; }
    return h === expectedRoot;
  });
}

// Wallet backups and full receipts stay off-chain. Losing a note loses spending ability.
export function encryptPrivate(value: unknown, password: string): string {
  if (password.length < 12) throw new Error('Use a password of at least 12 characters');
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
}
export function decryptPrivate(envelope: string, password: string): unknown {
  const e = JSON.parse(envelope);
  if (e.version !== 1 || !/^[0-9a-f]{32}$/.test(e.salt) || !/^[0-9a-f]{24}$/.test(e.iv) || !/^[0-9a-f]{32}$/.test(e.tag) || typeof e.ciphertext !== 'string') throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, Buffer.from(e.salt, 'hex'), 32), Buffer.from(e.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()]).toString());
}
