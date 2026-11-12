import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoiceFixture } from './fixtures/invoices.js';
import { createInvoice, invoicePaymentRoots, invoiceRoot, invoiceHash, invoiceStatusRequest, verifySignedInvoice, invoiceLink, invoiceFromFragment, matchInvoicePlan, assertInvoiceReferenceAvailable, validateInvoiceStatus, parseInvoice } from '../sdk/client/invoices.js';
import { shaField } from '../sdk/client/crypto.js';
import { indexedInvoiceStatus, InvoiceStatusInput } from '../sdk/invoices.js';
import { IndexStore } from '../sdk/indexer/store.js';
import { SettlementIndexer } from '../sdk/indexer/worker.js';
import { HttpGateway } from '../sdk/client/http.js';
import { createReadOnlyApi } from '../server/api.js';
const now = Date.parse('2026-11-12T12:00:00.000Z');
test('CLI selects explicit 1-based v2 payment units and preserves legacy invoice actions', async () => {
  const f = await invoiceFixture(2), dir = await mkdtemp(join(tmpdir(), 'core-invoice-unit-'));
  try {
    const terms = { ...f.invoice, createdAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const invoice = createInvoice(terms), signed = await f.signedInvoice(invoice), roots = await invoicePaymentRoots(invoice);
    const policyFile = join(dir, 'policy.json'), invoiceFile = join(dir, 'invoice.json');
    await writeFile(policyFile, JSON.stringify(f.policy)); await writeFile(invoiceFile, JSON.stringify(signed));
    const run = (filename: string, ...unit: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'invoice-action', policyFile, invoiceFile, join(dir, filename), ...unit]);
    for (const unit of [1, 2]) {
      await run(`unit-${unit}.json`, String(unit));
      assert.deepEqual(JSON.parse(await readFile(join(dir, `unit-${unit}.json`), 'utf8')), { kind: 'withdraw', target: invoice.recipient, disclosureRoot: roots[unit - 1] });
    }
    await assert.rejects(() => run('missing.json'), /payment index/);
    for (const unit of ['0', '3', '1.5']) await assert.rejects(() => run('invalid.json', unit));
    const legacy = { ...terms, version: 1 as const };
    await writeFile(invoiceFile, JSON.stringify(await f.signedInvoice(legacy)));
    await run('legacy.json');
    assert.equal(JSON.parse(await readFile(join(dir, 'legacy.json'), 'utf8')).disclosureRoot, await invoiceRoot(legacy));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
async function scoped() {
  const f = await invoiceFixture(2);
  const { version, id, nonce, ...terms } = f.invoice;
  const invoice = createInvoice(terms), signed = await f.signedInvoice(invoice);
  const roots = await invoicePaymentRoots(invoice), request = await invoiceStatusRequest(invoice);
  const store = new IndexStore(':memory:', f.policy), worker = new SettlementIndexer(f.source, store);
  function payment(i: number, root: string) {
    return f.record(i, { kind: 'withdrawal_succeeded', commitment: null, nullifier: String(i + 1), recipient: f.recipient,
      disclosure_root: root, protocol_fee_charged: '0', protocol_fee_earned: '1500', storage_fee_charged: '0', timestamp_ns: (BigInt(now) * 1000000n).toString() });
  }
  return { ...f, invoice, signed, roots, request, store, worker, payment };
}
test('v2 signs distinct per-payment references, preserves UTF-8 links and rejects nonce tampering', async () => {
  const f = await scoped();
  try {
    assert.equal(f.invoice.version, 2); assert.equal(new Set(f.roots).size, 2);
    assert.deepEqual(await verifySignedInvoice(f.signed), f.signed);
    assert.deepEqual(invoiceFromFragment(new URL(invoiceLink('https://checkout.example', f.signed)).hash), f.signed);
    await assert.rejects(() => invoiceRoot(f.invoice), /payment index/);
    assert.equal(await invoiceRoot(f.invoice, 1), f.roots[1]);
    await assert.rejects(() => invoiceRoot(f.invoice, 2), /Invalid/);
    if (f.invoice.version !== 2) throw new Error('Expected v2');
    const nonces = f.invoice.paymentNonces;
    assert.throws(() => parseInvoice({ ...f.invoice, paymentNonces: [nonces[0], nonces[0]] }), /distinct/);
    assert.throws(() => parseInvoice({ ...f.invoice, paymentNonces: [] }));
    const changed = structuredClone(f.signed);
    if (changed.invoice.version !== 2) throw new Error('Expected v2');
    changed.invoice.paymentNonces.reverse();
    await assert.rejects(() => verifySignedInvoice(changed), /signature/);
    const another = createInvoice({ ...f.invoice });
    assert.notDeepEqual(await invoicePaymentRoots(another), f.roots);
  } finally { f.store.close(); }
});
test('v2 reconciliation scans one recipient snapshot but counts only the signed reference set', async () => {
  const f = await scoped();
  try {
    f.records.push(f.payment(0, 'ff'.repeat(32)), f.payment(1, f.roots[0]));
    await f.worker.sync();
    let status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'partial'); assert.equal(status.paidTokens, '1000000');
    assert.equal(status.settlementRoot, null); assert.deepEqual(status.settlementRoots, f.roots);
    assert.equal(status.confirmations[0].settlementRoot, f.roots[0]);
    assert.equal(validateInvoiceStatus(status, f.invoice).reusedPaymentReferences, 0);
    await assert.rejects(() => assertInvoiceReferenceAvailable(f.invoice, f.roots[0], status), /already has/);
    await assertInvoiceReferenceAvailable(f.invoice, f.roots[1], status);
    f.state.height++; f.records.push(f.payment(2, f.roots[1])); await f.worker.sync();
    status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'paid'); assert.equal(status.paidTokens, '2000000');
    assert.equal(status.confirmations.length, 2); assert.equal(status.reusedPaymentReferences, 0);
    assert.throws(() => validateInvoiceStatus({ ...status, confirmations: status.confirmations.map(c => ({ ...c, settlementRoot: 'ee'.repeat(32) })) }, f.invoice), /confirmation/);
  } finally { f.store.close(); }
});
test('reference races remain actual payments and expose reuse instead of silently discarding funds', async () => {
  const f = await scoped();
  try {
    f.records.push(f.payment(0, f.roots[0]), f.payment(1, f.roots[0])); await f.worker.sync();
    const status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'paid'); assert.equal(status.paidTokens, '2000000');
    assert.equal(status.reusedPaymentReferences, 1);
    assert.equal(validateInvoiceStatus(status, f.invoice).confirmedPayments, 2);
    assert.throws(() => validateInvoiceStatus({ ...status, reusedPaymentReferences: 0 }, f.invoice), /reuse count/);
  } finally { f.store.close(); }
});
test('late totals must match individual confirmations before paid status is trusted', async () => {
  const f = await scoped();
  try {
    f.records.push(f.payment(0, f.roots[0]), { ...f.payment(1, f.roots[1]), timestamp_ns: (BigInt(Date.parse(f.invoice.expiresAt)) * 1000000n).toString() });
    await f.worker.sync();
    const status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'paid_late');
    assert.equal(validateInvoiceStatus(status, f.invoice).lateTokens, '1000000');
    assert.throws(() => validateInvoiceStatus({ ...status, lateTokens: '0', state: 'paid' }, f.invoice), /late total/);
    assert.throws(() => validateInvoiceStatus({ ...status, lateTokens: '2000000' }, f.invoice), /late total/);
    assert.throws(() => validateInvoiceStatus({ ...status, confirmations: status.confirmations.map(c => ({ ...c, late: false })) }, f.invoice), /late total/);
  } finally { f.store.close(); }
});
test('indexed reference-set lookup finds an invoice behind 1200 unrelated recipient payouts', async () => {
  const f = await scoped();
  try {
    f.records.push(f.payment(0, f.roots[0]), f.payment(1, f.roots[1]), ...Array.from({ length: 1200 }, (_, i) => f.payment(i + 2, 'ff'.repeat(32))));
    await f.worker.sync({ maxPages: 30 });
    const status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'paid'); assert.equal(status.coverageLimited, false);
    assert.equal(status.confirmations.length, 2); assert.equal(status.paidTokens, '2000000');
    // Older index adapters retain the conservative, bounded recipient scan.
    const legacyReader = { policy: f.policy, status: () => f.store.status(), activity: (query: Parameters<IndexStore['activity']>[0]) => f.store.activity(query) };
    const fallback = await indexedInvoiceStatus(legacyReader, f.policy, f.request, now);
    assert.equal(fallback.state, 'review_required'); assert.equal(fallback.coverageLimited, true);
    assert.throws(() => f.store.activity({ disclosure_roots: f.roots } as never));
  } finally { f.store.close(); }
});
test('reference-set cursors retain one record snapshot and reject changed filters', async () => {
  const f = await scoped();
  try {
    f.records.push(f.payment(0, f.roots[0]), f.payment(1, f.roots[1])); await f.worker.sync();
    const query = { kind: 'withdrawal_succeeded' as const, recipient: f.recipient, disclosure_roots: f.roots, limit: 1 };
    const first = f.store.invoiceActivity(query);
    assert.equal(first.items[0].record.index, 1); assert(first.nextCursor);
    f.state.height++; f.records.push(f.payment(2, f.roots[0])); await f.worker.sync();
    const second = f.store.invoiceActivity({ ...query, cursor: first.nextCursor });
    assert.equal(second.items[0].record.index, 0); assert.equal(second.nextCursor, null);
    assert.equal(second.snapshot.upperExclusive, first.snapshot.upperExclusive);
    assert.throws(() => f.store.invoiceActivity({ ...query, disclosure_roots: [f.roots[0]], cursor: first.nextCursor! }), /Cursor/);
    assert.throws(() => f.store.invoiceActivity({ ...query, recipient: 'other.test.near', cursor: first.nextCursor! }), /Cursor/);
    for (const roots of [[], [f.roots[0], f.roots[0]], Array(33).fill('ff'.repeat(32)), ["' OR 1=1 --"]])
      assert.throws(() => f.store.invoiceActivity({ ...query, disclosure_roots: roots }));
    assert.equal(f.store.invoiceActivity({ ...query, limit: 50 }).items.length, 3);
  } finally { f.store.close(); }
});
test('matching reference floods still report incomplete coverage instead of a false final total', async () => {
  const f = await scoped();
  try {
    f.records.push(...Array.from({ length: 1001 }, (_, i) => f.payment(i, f.roots[0])));
    await f.worker.sync({ maxPages: 30 });
    const status = await indexedInvoiceStatus(f.store, f.policy, f.request, now);
    assert.equal(status.state, 'review_required'); assert.equal(status.coverageLimited, true);
    assert.equal(status.confirmations.length, 1000); assert.equal(status.reusedPaymentReferences, 999);
    validateInvoiceStatus(status, f.invoice);
  } finally { f.store.close(); }
});
test('v2 public plans must use a signed invoice reference and exact payout destination', async () => {
  const f = await scoped();
  try {
    const p = f.invoice.policy, domain = await shaField(`core:ft:v3|${p.network}|${p.registry}|${p.tokenId}|${p.denomination}`);
    const plan = async (root: string, recipient = f.invoice.recipient) => ({ tokenCall: { contract: p.tokenId, method: 'ft_transfer_call', args: { receiver_id: p.registry, amount: '1500', msg: JSON.stringify({ vault: f.vault, recipient, disclosure_root: root, proof: Buffer.alloc(256).toString('base64'), public_inputs: ['42','2','3',await shaField(`core:action:ft:v3|${domain}|withdraw|${f.vault}|${recipient}|${root}`),domain] }) }, attachedYoctoNear: '1', gas: '300000000000000' } });
    for (const root of f.roots) assert.equal((await matchInvoicePlan(await plan(root), f.invoice, f.payer)).reference.expectedDisclosureRoot, root);
    await assert.rejects(async () => matchInvoicePlan(await plan('ff'.repeat(32)), f.invoice, f.payer), /invoice root/);
    await assert.rejects(async () => matchInvoicePlan(await plan(f.roots[0], 'other.test.near'), f.invoice, f.payer), /invoice root/);
  } finally { f.store.close(); }
});
test('v2 HTTP lookup sends reference nonces without business terms and verifies the returned set', async () => {
  const f = await scoped();
  f.source.accessKeys = async account => account === f.invoice.merchantAccount ? [{ public_key: f.publicKey, access_key: { permission: 'FullAccess' } }] : [];
  const server = createReadOnlyApi({ source: f.source, policy: f.policy, index: f.store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await f.worker.sync();
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const gateway = new HttpGateway(`http://127.0.0.1:${address.port}`);
    const status = await gateway.invoiceStatus(f.signed);
    assert.equal(status.state, Date.now() >= Date.parse(f.invoice.expiresAt) ? 'expired' : 'awaiting_payment');
    assert.equal(status.settlementRoot, null); assert.deepEqual(status.settlementRoots, f.roots);
    assert(!JSON.stringify(f.request).includes(f.invoice.title));
    assert(!JSON.stringify(f.request).includes(f.invoice.reference));
    assert(!InvoiceStatusInput.safeParse({ ...f.request, title: f.invoice.title }).success);
    assert(!InvoiceStatusInput.safeParse({ ...f.request, units: 3 }).success);
    await assert.rejects(() => assertInvoiceReferenceAvailable(f.invoice, f.roots[0], { ...status, settlementRoots: [...f.roots].reverse() }), /differs/);
    f.store.invoiceActivity = () => { throw new Error('Private database diagnostics must not leak'); };
    const failed = await fetch(`http://127.0.0.1:${address.port}/v1/invoices/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.request) });
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: 'INDEX_READ_FAILED' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.store.close(); }
});
