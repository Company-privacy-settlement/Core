import { seal, unseal, sha256 } from './crypto.js';
import { object } from './payment.js';

export const RECEIPT_FIELDS = Object.freeze(['sender', 'recipient', 'asset', 'amount', 'purpose', 'reference', 'occurredAt', 'credentialHash'] as const);
export type ReceiptField = typeof RECEIPT_FIELDS[number];
export type ReceiptValues = Record<ReceiptField, string>;
export type Receipt = { version: 1; root: string; openings: { field: ReceiptField; value: string; salt: string; siblings: string[] }[] };
const FORMAT = 'core-private-receipt', MAX_BACKUP = 200_000;
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Unexpected receipt fields');
}
function digest(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new Error('Expected a 64-character lowercase receipt root or hash');
  return raw;
}
function value(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Receipt values must be strings of at most 4096 characters');
  return raw;
}
function parse(raw: unknown): Receipt {
  const receipt = object(raw); exact(receipt, ['version', 'root', 'openings']);
  const root = digest(receipt.root);
  if (receipt.version !== 1 || !Array.isArray(receipt.openings) || receipt.openings.length < 1 || receipt.openings.length > 8) throw new Error('Choose a version-1 receipt with 1–8 field openings');
  const seen = new Set<string>();
  const openings = receipt.openings.map(rawOpening => {
    const opening = object(rawOpening); exact(opening, ['field', 'value', 'salt', 'siblings']);
    if (!RECEIPT_FIELDS.includes(opening.field as ReceiptField) || seen.has(opening.field as string) || !Array.isArray(opening.siblings) || opening.siblings.length !== 3) throw new Error('Invalid or duplicate receipt opening');
    const field = opening.field as ReceiptField; seen.add(field);
    return { field, value: value(opening.value), salt: digest(opening.salt), siblings: opening.siblings.map(digest) };
  });
  return { version: 1, root, openings: openings.sort((a, b) => RECEIPT_FIELDS.indexOf(a.field) - RECEIPT_FIELDS.indexOf(b.field)) };
}
const leaf = (field: ReceiptField, declared: string, salt: string) => sha256(JSON.stringify(['core:receipt:v1', field, declared, salt]));
const branch = (left: string, right: string) => sha256(`core:receipt:node:v1|${left}|${right}`);

/** Local integrity only. The expected root must come from an independent source. */
export async function verifyReceiptDisclosure(raw: unknown, expectedRoot: string): Promise<Receipt> {
  const expected = digest(expectedRoot), receipt = parse(raw);
  if (receipt.root !== expected) throw new Error('Receipt differs from the expected root');
  await Promise.all(receipt.openings.map(async opening => {
    let index = RECEIPT_FIELDS.indexOf(opening.field), hash = await leaf(opening.field, opening.value, opening.salt);
    for (const sibling of opening.siblings) { hash = index & 1 ? await branch(sibling, hash) : await branch(hash, sibling); index >>= 1; }
    if (hash !== expected) throw new Error('Receipt field integrity check failed');
  }));
  return receipt;
}
export async function createReceipt(input: ReceiptValues): Promise<Receipt> {
  const raw = object(input); exact(raw, [...RECEIPT_FIELDS]);
  const values = RECEIPT_FIELDS.map(field => value(raw[field]));
  const salts = RECEIPT_FIELDS.map(() => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  const levels = [await Promise.all(RECEIPT_FIELDS.map((field, i) => leaf(field, values[i], salts[i])))];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    levels.push(await Promise.all(Array.from({ length: current.length / 2 }, (_, i) => branch(current[2 * i], current[2 * i + 1]))));
  }
  return { version: 1, root: levels.at(-1)![0], openings: RECEIPT_FIELDS.map((field, i) => {
    let index = i;
    const siblings = levels.slice(0, -1).map(level => { const sibling = level[index ^ 1]; index >>= 1; return sibling; });
    return { field, value: values[i], salt: salts[i], siblings };
  }) };
}
export async function discloseReceipt(raw: Receipt, fields: ReceiptField[]): Promise<Receipt> {
  const selected = [...fields];
  if (!selected.length || selected.length > 8 || new Set(selected).size !== selected.length || selected.some(field => !RECEIPT_FIELDS.includes(field))) throw new Error('Select 1–8 distinct receipt fields');
  const receipt = await verifyReceiptDisclosure(raw, raw.root);
  if (selected.some(field => !receipt.openings.some(opening => opening.field === field))) throw new Error('Selected field is not available in this receipt');
  return { version: 1, root: receipt.root, openings: receipt.openings.filter(opening => selected.includes(opening.field)) };
}
async function full(raw: unknown): Promise<Receipt> {
  const parsed = parse(raw);
  if (parsed.openings.length !== 8) throw new Error('A private receipt backup must contain all eight fields');
  return verifyReceiptDisclosure(parsed, parsed.root);
}
export async function encryptReceiptBackup(raw: Receipt, password: string): Promise<string> {
  return seal({ version: 1, receipt: await full(raw) }, password, FORMAT);
}
export async function openReceiptBackup(envelope: string, password: string): Promise<Receipt> {
  if (envelope.length > MAX_BACKUP) throw new Error('Receipt backup exceeds 200 KB');
  let decoded: unknown;
  try { decoded = await unseal(envelope, password, FORMAT); }
  catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'OperationError') throw new Error('Could not decrypt receipt. Check the passphrase and backup integrity.');
    throw error;
  }
  const payload = object(decoded); exact(payload, ['version', 'receipt']);
  if (payload.version !== 1) throw new Error('Unsupported private receipt version');
  return full(payload.receipt);
}
