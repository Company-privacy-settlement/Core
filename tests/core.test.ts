import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { groth16 } from 'snarkjs';
import { createNote, domain, field, FIELD, NoteTree, validateNote, contextHash, shutdownProver, type Pool } from '../sdk/core.js';
import { createReceipt, disclose, verifyDisclosure, encryptPrivate, decryptPrivate } from '../sdk/disclosure.js';
import { credentialMessage, credentialHash, verifyKyb, type KybCredential, type KybClaims } from '../sdk/kyb.js';
import { verifyBundle, type ChainRecord, type EvidenceSource, type SettlementBundle } from '../sdk/evidence.js';
import { createFreshRecipient, chooseIndependentVault } from '../sdk/wallet.js';
import bs58 from 'bs58';

const pool: Pool = { network: 'sandbox', contract: 'pool.test.near', denomination: '1000000000000000000000000' };
after(shutdownProver);
const values = { sender: 'Business A', recipient: 'Business B', asset: 'NEAR', amount: pool.denomination, purpose: 'invoice', reference: 'INV-001', occurredAt: '2026-11-12T00:00:00Z', credentialHash: '' };

test('notes belong to exactly one domain and recipient keeps independent secrets', async () => {
  const note = await createNote(pool), receiverNote = await createNote(pool);
  await validateNote(pool, note);
  assert.notEqual(note.commitment, receiverNote.commitment);
  await assert.rejects(validateNote({ ...pool, contract: 'other.test.near' }, note));
  await assert.rejects(validateNote(pool, { ...note, secret: receiverNote.secret }));
  assert.notEqual(domain(pool), domain({ ...pool, network: 'testnet' }));
});
test('fresh implicit account keys are client-generated and only exported encrypted', () => {
  const a = createFreshRecipient('recipient-backup-password'), b = createFreshRecipient('recipient-backup-password');
  assert.match(a.accountId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.accountId, b.accountId);
  assert.equal(Buffer.from(bs58.decode(a.publicKey.slice(8))).toString('hex'), a.accountId);
  const backup = decryptPrivate(a.encryptedBackup, 'recipient-backup-password') as any;
  const secret = bs58.decode(backup.secretKey.slice(8));
  assert.equal(secret.length, 64);
  assert.equal(Buffer.from(secret.subarray(32)).toString('hex'), a.accountId);
  assert.equal('secretKey' in a, false);
});
test('independent-vault selection keeps pool domains separate', () => {
  const vaults = [pool, { ...pool, contract: 'other.test.near' }];
  assert.ok(vaults.some(p => p.contract === chooseIndependentVault(vaults).contract));
  assert.throws(() => chooseIndependentVault([]));
  assert.throws(() => chooseIndependentVault([pool, pool]));
  assert.throws(() => chooseIndependentVault([pool, { ...pool, denomination: '42' }]));
});
test('fields reject modulus aliases and noncanonical decimal strings', () => {
  for (const n of ['01', '-1', ' 1', FIELD.toString(), (FIELD + 1n).toString()]) assert.throws(() => field(n));
  assert.equal(field('0'), 0n);
});
test('action context binds output, recipient, receipt and pool', () => {
  const action = { kind: 'withdraw' as const, target: 'receiver.test.near', disclosureRoot: 'ab'.repeat(32) };
  const ctx = contextHash(pool, action);
  assert.notEqual(ctx, contextHash(pool, { ...action, target: 'attacker.test.near' }));
  assert.notEqual(ctx, contextHash(pool, { ...action, disclosureRoot: 'cd'.repeat(32) }));
  assert.notEqual(ctx, contextHash({ ...pool, denomination: '42' }, action));
});
test('selective receipt openings hide unrelated values and reject tampering', () => {
  const receipt = createReceipt(values), selected = disclose(receipt, ['asset', 'amount', 'reference']);
  assert.equal(selected.openings.length, 3);
  assert.ok(!JSON.stringify(selected).includes('Business A'));
  assert.ok(verifyDisclosure(selected, receipt.root));
  const changed = structuredClone(selected); changed.openings[0].value = 'USD';
  assert.equal(verifyDisclosure(changed, receipt.root), false);
  assert.equal(verifyDisclosure(selected, '00'.repeat(32)), false);
  assert.equal(verifyDisclosure({ ...selected, openings: [selected.openings[0], selected.openings[0]] }, receipt.root), false);
});
test('each receipt uses fresh independent salts', () => {
  assert.notEqual(createReceipt(values).root, createReceipt(values).root);
});
test('private backup encryption authenticates password and ciphertext', () => {
  const envelope = encryptPrivate(values, 'hackathon-private-passphrase');
  assert.deepEqual(decryptPrivate(envelope, 'hackathon-private-passphrase'), values);
  assert.throws(() => decryptPrivate(envelope, 'wrong-password'));
  const tampered = JSON.parse(envelope); tampered.tag = '00'.repeat(16);
  assert.throws(() => decryptPrivate(JSON.stringify(tampered), 'hackathon-private-passphrase'));
});
test('KYB checks issuer, subject, signature, expiry and revocations', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const claims: KybClaims = { version: 1, issuer: 'example-provider', subjectCommitment: '42', businessIdHash: 'ab'.repeat(32), jurisdiction: 'AE', checks: ['registration', 'beneficial_owners', 'sanctions'], issuedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', nonce: 'cd'.repeat(32) };
  const credential: KybCredential = { claims, signature: sign(null, Buffer.from(credentialMessage(claims)), privateKey).toString('base64') };
  const options = { trustedIssuers: { 'example-provider': publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revokedHashes: new Set<string>(), expectedSubject: '42', now: new Date('2026-11-12T00:00:00Z') };
  assert.ok(verifyKyb(credential, options));
  assert.equal(verifyKyb(credential, { ...options, trustedIssuers: {} }), false);
  assert.equal(verifyKyb(credential, { ...options, expectedSubject: '43' }), false);
  assert.equal(verifyKyb(credential, { ...options, now: new Date('2027-02-01T00:00:00Z') }), false);
  assert.equal(verifyKyb(credential, { ...options, revokedHashes: new Set([credentialHash(credential)]) }), false);
  assert.equal(verifyKyb({ ...credential, claims: { ...claims, jurisdiction: 'US' } }, options), false);
});
function evidenceFixture() {
  const receipt = createReceipt(values);
  const record: ChainRecord = { index: 0, kind: 'deposit', commitment: '42', nullifier: null, recipient: null, disclosure_root: receipt.root, block_height: 42, timestamp_ns: '1794441600000000000' };
  const tx: any = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: { hash: 'example-tx', signer_id: 'sender.test.near' }, receipts_outcome: [{ outcome: { executor_id: pool.contract, status: { SuccessValue: '' }, logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'core_privacy', version: '1.0.0', event: 'deposit', data: [record] })] } }] };
  const source: EvidenceSource = { network: 'sandbox', contract: pool.contract, getRecord: async () => record, getTransaction: async () => tx };
  const bundle: SettlementBundle = { version: 1, network: 'sandbox', contract: pool.contract, scope: 'selected_transactions', transactions: [{ tx: { hash: 'example-tx', signer: 'sender.test.near', recordIndex: 0 }, disclosure: disclose(receipt, ['amount']) }] };
  return { record, tx, source, bundle };
}
test('bundle proves submitted TX inclusion without claiming complete history or identity', async () => {
  const { bundle, source } = evidenceFixture();
  const result = await verifyBundle(bundle, source);
  assert.ok(result.valid); assert.equal(result.claims.completeHistory, false); assert.equal(result.claims.legalIdentityVerified, false);
});
test('bundle rejects failed, unfinalized or foreign-executor transaction logs', async () => {
  for (const mutate of [
    (tx: any) => { tx.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    (tx: any) => { tx.status = { Failure: {} }; },
    (tx: any) => { tx.receipts_outcome[0].outcome.executor_id = 'fake.test.near'; },
    (tx: any) => { tx.transaction.hash = 'different'; },
    (tx: any) => { tx.receipts_outcome[0].outcome.status = { Failure: {} }; },
  ]) {
    const { bundle, source, tx } = evidenceFixture(); mutate(tx);
    await assert.rejects(verifyBundle(bundle, source));
  }
});
test('bundle rejects duplicate records and swapped receipt openings', async () => {
  const { bundle, source } = evidenceFixture();
  bundle.transactions.push(bundle.transactions[0]); await assert.rejects(verifyBundle(bundle, source));
  bundle.transactions.pop(); bundle.transactions[0].disclosure!.openings[0].value = '999';
  await assert.rejects(verifyBundle(bundle, source));
});
test('real public Groth16 vector verifies; changing root or authorization fails', async () => {
  const v = JSON.parse(await readFile('test-vectors/spend.json', 'utf8'));
  const tree = await NoteTree.from([v.inputCommitment]);
  assert.equal(tree.root, v.root);
  assert.ok(await groth16.verify(v.vkey, v.transfer.public_inputs, v.transfer.snarkjsProof));
  const modified = [...v.transfer.public_inputs]; modified[1] = '42';
  assert.equal(await groth16.verify(v.vkey, modified, v.transfer.snarkjsProof), false);
});
