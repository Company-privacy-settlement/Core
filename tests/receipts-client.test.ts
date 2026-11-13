import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReceipt as legacyReceipt, disclose, verifyDisclosure } from '../sdk/disclosure.js';
import { RECEIPT_FIELDS, createReceipt, discloseReceipt, verifyReceiptDisclosure, encryptReceiptBackup, openReceiptBackup, type ReceiptValues, type Receipt } from '../sdk/client/receipts.js';
import { seal, unseal } from '../sdk/client/crypto.js';
const password = 'private receipt backup passphrase';
const values: ReceiptValues = { sender: 'Private business α', recipient: 'Employee 李', asset: 'nep141:usdc.testnet', amount: '1000000', purpose: 'Confidential salary', reference: 'PAY-2026-001', occurredAt: '2026-11-13T00:00:00.000Z', credentialHash: '' };

test('browser receipts and selective openings match the existing Node receipt format in both directions', async () => {
  const receipt = await createReceipt(values); assert.equal(verifyDisclosure(receipt, receipt.root), true);
  const selected = await discloseReceipt(receipt, ['asset', 'amount']);
  assert.deepEqual(selected.openings.map(opening => opening.field), ['asset', 'amount']);
  assert.equal(verifyDisclosure(selected, receipt.root), true);
  assert.ok(!JSON.stringify(selected).includes(values.sender)); assert.ok(!JSON.stringify(selected).includes(values.purpose));
  const old = legacyReceipt(values);
  assert.deepEqual(await verifyReceiptDisclosure(disclose(old, ['reference', 'amount']), old.root), disclose(old, ['amount', 'reference']));
});
test('receipt verification rejects substituted roots, values, field positions, paths and duplicate openings', async () => {
  const receipt = await createReceipt(values), opening = receipt.openings[0];
  await assert.rejects(verifyReceiptDisclosure(receipt, 'ab'.repeat(32)), /expected root/);
  for (const patch of [{ value: 'other sender' }, { field: 'recipient' }, { salt: '00'.repeat(32) }, { siblings: ['ab'.repeat(32), ...opening.siblings.slice(1)] }, { siblings: opening.siblings.slice(1) }, { extra: 'not-allowed' }]) {
    await assert.rejects(verifyReceiptDisclosure({ ...receipt, openings: [{ ...opening, ...patch }] }, receipt.root));
  }
  for (const patch of [{ openings: [] }, { openings: [opening, opening] }, { version: 2 }, { extra: 'hidden' }, { root: receipt.root.toUpperCase() }]) await assert.rejects(verifyReceiptDisclosure({ ...receipt, ...patch }, receipt.root));
});
test('selective export requires distinct available fields and does not permit empty proofs', async () => {
  const receipt = await createReceipt(values), partial = await discloseReceipt(receipt, ['asset', 'amount']);
  assert.deepEqual(await discloseReceipt(partial, ['amount']), await discloseReceipt(receipt, ['amount']));
  for (const fields of [[], ['asset', 'asset'], ['unknown'], ['sender']]) await assert.rejects(discloseReceipt(partial, fields as any));
  await assert.rejects(encryptReceiptBackup(partial, password), /all eight/);
});
test('receipt backups authenticate every opening and remain distinct from notes, library and journal formats', async () => {
  const receipt = await createReceipt(values), encrypted = await encryptReceiptBackup(receipt, password);
  assert.equal(JSON.parse(encrypted).format, 'core-private-receipt');
  for (const text of [values.sender, values.purpose, receipt.root, receipt.openings[0].salt]) assert.ok(!encrypted.includes(text));
  assert.deepEqual(await openReceiptBackup(encrypted, password), receipt);
  await assert.rejects(openReceiptBackup(encrypted, 'a different receipt passphrase'), /Could not decrypt/);
  for (const format of ['core-operation-journal', 'core-invoice-library', 'core-private-note'] as const) await assert.rejects(unseal(encrypted, password, format));
  const changed = JSON.parse(encrypted); changed.ciphertext = (changed.ciphertext[0] === 'A' ? 'B' : 'A') + changed.ciphertext.slice(1);
  await assert.rejects(openReceiptBackup(JSON.stringify(changed), password));
  await assert.rejects(openReceiptBackup(await seal({ version: 1, receipt: { ...receipt, openings: receipt.openings.slice(1) } }, password, 'core-private-receipt'), password), /all eight/);
});
test('receipt values are snapshotted before hashing and fresh receipts use independent salts', async () => {
  const mutable = { ...values }, pending = createReceipt(mutable); mutable.sender = 'changed after invocation';
  const first = await pending, second = await createReceipt(values);
  assert.equal(first.openings[0].value, values.sender); assert.notEqual(first.root, second.root);
  assert.equal(new Set(first.openings.map(opening => opening.salt)).size, 8);
  const mutableReceipt = structuredClone(first), verification = verifyReceiptDisclosure(mutableReceipt, first.root);
  mutableReceipt.openings[0].value = 'changed after invocation'; assert.deepEqual(await verification, first);
  assert.throws(() => (RECEIPT_FIELDS as unknown as string[]).push('other'));
});
test('receipt limits accept maximum Unicode declarations and reject extra fields and oversized values', async () => {
  const maximum = Object.fromEntries(RECEIPT_FIELDS.map(field => [field, '漢'.repeat(4096)])) as ReceiptValues;
  const receipt = await createReceipt(maximum), encrypted = await encryptReceiptBackup(receipt, password);
  assert.ok(encrypted.length < 200_000); assert.deepEqual(await openReceiptBackup(encrypted, password), receipt);
  await assert.rejects(createReceipt({ ...values, purpose: 'a'.repeat(4097) }));
  await assert.rejects(createReceipt({ ...values, privateKey: 'never' } as any));
  await assert.rejects(openReceiptBackup('a'.repeat(200001), password), /200 KB/);
});
test('CLI selectively discloses browser encrypted receipts without exposing other values or accepting invalid selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'core-receipt-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const receipt = await createReceipt(values), filename = join(dir, 'receipt.encrypted.json');
  await writeFile(filename, await encryptReceiptBackup(receipt, password));
  const run = (fields: string, pass = password) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'disclose', filename, fields], { env: { ...process.env, CORE_RECEIPT_PASSWORD: pass } });
  const output = JSON.parse((await run('asset,amount')).stdout) as Receipt;
  assert.equal(verifyDisclosure(output, receipt.root), true); assert.deepEqual(output.openings.map(o => o.field), ['asset', 'amount']);
  assert.ok(!JSON.stringify(output).includes(values.purpose));
  await assert.rejects(run('sender', 'wrong sufficiently long password'));
  await assert.rejects(run('asset,unknown')); await assert.rejects(run('asset,asset'));
  const legacyFile = join(dir, 'legacy.json'); await writeFile(legacyFile, JSON.stringify(legacyReceipt(values)));
  const legacy = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'disclose', legacyFile, 'reference']);
  assert.deepEqual(JSON.parse(legacy.stdout).openings.map((o: any) => o.field), ['reference']);
});
