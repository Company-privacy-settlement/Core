import test from 'node:test';
import assert from 'node:assert/strict';
import { InvoiceLibrary, createInvoice, invoiceHash, type Identity, type JournalStorage } from '../sdk/client/index.js';
import { seal, unseal } from '../sdk/client/crypto.js';
import { invoiceFixture } from './fixtures/invoices.js';
const password = 'local invoice library test password', format = 'core-invoice-library';
function memory() {
  let value: string | null = null, busy = false;
  const storage: JournalStorage = {
    read: async () => value, write: async envelope => { value = envelope; },
    exclusive: async fn => { if (busy) throw new Error('Storage busy'); busy = true; try { return await fn(); } finally { busy = false; } },
  };
  return { storage, value: () => value };
}
async function fixture() {
  const f = await invoiceFixture(), m = memory(), owner: Identity = { network: f.policy.network, accountId: f.payer };
  const library = new InvoiceLibrary(m.storage, password, owner); await library.create();
  return { ...f, ...m, owner, library };
}
test('signed historical invoices persist encrypted without network reads or cached payment status', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network reads expected'); });
  const f = await fixture(), entry = await f.library.add(f.signed);
  assert.equal(entry.hash, await invoiceHash(f.invoice));
  assert.deepEqual(Object.keys(entry).sort(), ['hash', 'savedAt', 'signed']);
  assert.equal((await f.library.list())[0].signed.invoice.title, f.invoice.title);
  assert.ok(!f.value()!.includes(f.invoice.title)); assert.ok(!f.value()!.includes(f.invoice.reference));
  assert.equal(JSON.parse(f.value()!).format, format); assert.equal(fetch.mock.callCount(), 0);
  const reopened = new InvoiceLibrary(f.storage, password, f.owner); assert.equal((await reopened.list()).length, 1);
});
test('invoice IDs and signatures are immutable while identical saves are idempotent', async () => {
  const f = await fixture(); await f.library.add(f.signed); const encrypted = f.value();
  await f.library.add(f.signed); assert.equal(f.value(), encrypted); assert.equal((await f.library.list()).length, 1);
  const changed = await f.signedInvoice({ ...f.invoice, title: 'Different signed terms' });
  await assert.rejects(f.library.add(changed), /already has different signed terms/); assert.equal(f.value(), encrypted);
  await assert.rejects(f.library.add({ ...f.signed, invoice: { ...f.invoice, title: 'Tampered unsigned terms' } }));
  assert.equal(f.value(), encrypted);
});
test('library identity is bound to merchant and network, including restored backups', async () => {
  const f = await fixture(); await f.library.add(f.signed); const backup = await f.library.export();
  for (const owner of [{ ...f.owner, accountId: 'other.test.near' }, { ...f.owner, network: 'testnet' as const }]) {
    const fresh = memory(), library = new InvoiceLibrary(fresh.storage, password, owner);
    await assert.rejects(library.restore(backup), /different merchant\/network/); assert.equal(fresh.value(), null);
  }
  const foreign = await invoiceFixture(); foreign.invoice.merchantAccount = 'other.test.near';
  await assert.rejects(f.library.add(await foreign.signedInvoice()), /different merchant or network/);
});
test('backup restore preserves existing storage and encryption contexts cannot be relabeled', async () => {
  const f = await fixture(); await f.library.add(f.signed); const backup = await f.library.export(), before = f.value();
  await assert.rejects(f.library.restore(backup), /empty storage/); assert.equal(f.value(), before);
  const fresh = memory(), restored = new InvoiceLibrary(fresh.storage, password, f.owner); await restored.restore(backup);
  assert.deepEqual(await restored.list(), await f.library.list());
  await assert.rejects(new InvoiceLibrary(fresh.storage, 'wrong library password', f.owner).list(), /Could not decrypt/);
  await assert.rejects(unseal(backup, password));
  const journal = JSON.parse(await seal({ version: 1, operations: [] }, password)); journal.format = format;
  await assert.rejects(new InvoiceLibrary(memory().storage, password, f.owner).restore(JSON.stringify(journal)), /Could not decrypt/);
  const relabeled = JSON.parse(backup); relabeled.format = 'core-operation-journal';
  await assert.rejects(unseal(JSON.stringify(relabeled), password));
  await assert.rejects(new InvoiceLibrary(memory().storage, password, f.owner).restore(JSON.stringify({ ...JSON.parse(backup), title: 'Unencrypted hidden metadata' })), /Unsupported encrypted/);
});
test('backup merge keeps both libraries, deduplicates repeats and rejects conflicts atomically', async () => {
  const f = await fixture(); await f.library.add(f.signed);
  const second = await f.signedInvoice(createInvoice({ ...f.invoice, title: 'Second invoice' }));
  const other = memory(), backupPassword = 'different backup passphrase', source = new InvoiceLibrary(other.storage, backupPassword, f.owner);
  await source.create(); await source.add(f.signed); await source.add(second);
  const backup = await source.export(); await f.library.merge(backup, backupPassword); assert.equal((await f.library.list()).length, 2);
  await f.library.merge(backup, backupPassword); assert.equal((await f.library.list()).length, 2);
  const conflicting = memory(), conflict = new InvoiceLibrary(conflicting.storage, password, f.owner); await conflict.create();
  await conflict.add(await f.signedInvoice({ ...f.invoice, title: 'Signed replacement attempt' }));
  const before = f.value(); await assert.rejects(f.library.merge(await conflict.export()), /conflicts with an immutable/); assert.equal(f.value(), before);
});
test('wrong hashes, duplicate IDs, extra fields and oversized libraries cannot be restored', async () => {
  const f = await fixture(); await f.library.add(f.signed);
  const decoded = await unseal(await f.library.export(), password, format) as { version: number; owner: Identity; invoices: { hash: string; signed: unknown; savedAt: string }[] };
  for (const payload of [
    { ...decoded, paid: true }, { ...decoded, invoices: [decoded.invoices[0], decoded.invoices[0]] },
    { ...decoded, invoices: [{ ...decoded.invoices[0], hash: 'ab'.repeat(32) }] },
    { ...decoded, invoices: [{ ...decoded.invoices[0], savedAt: 'not a time' }] },
    { ...decoded, invoices: Array(101).fill(decoded.invoices[0]) },
  ]) {
    const empty = memory(); await assert.rejects(new InvoiceLibrary(empty.storage, password, f.owner).restore(await seal(payload, password, format))); assert.equal(empty.value(), null);
  }
});
test('locking pending work prevents a stale write and local removal changes only the encrypted library', async () => {
  const f = await fixture(); await f.library.add(f.signed); const before = f.value(), originalRead = f.storage.read;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  f.storage.read = async () => { entered(); await gate; return originalRead(); };
  const pending = f.library.remove(await invoiceHash(f.invoice)); await started; f.library.lock(); release();
  await assert.rejects(pending, /locked/); assert.equal(f.value(), before); await assert.rejects(f.library.list(), /locked/);
  f.storage.read = originalRead;
  const reopened = new InvoiceLibrary(f.storage, password, f.owner); await reopened.remove(await invoiceHash(f.invoice));
  assert.equal((await reopened.list()).length, 0); assert.equal(f.signed.invoice.title, f.invoice.title);
});
test('cross-context exclusion refuses overlapping mutations and a retry retains both records', async () => {
  const f = await fixture(), second = await f.signedInvoice(createInvoice({ ...f.invoice, title: 'Concurrent request' }));
  const another = new InvoiceLibrary(f.storage, password, f.owner);
  const results = await Promise.allSettled([f.library.add(f.signed), another.add(second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await f.library.add(f.signed); await another.add(second); assert.equal((await f.library.list()).length, 2);
});
