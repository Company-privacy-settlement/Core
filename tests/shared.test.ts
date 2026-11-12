import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { domain, contextHash, NoteTree, quoteFees, STORAGE_FEE, type Pool } from '../sdk/core.js';
import { discoverSharedVaults, loadSharedTree, chooseSharedVault, predictSharedVault, type SharedPolicy, type SharedChainSource } from '../sdk/shared.js';

async function fixture(ft = false) {
  const vector = JSON.parse(await readFile(ft ? 'test-vectors/shared-ft.json' : 'test-vectors/shared.json', 'utf8'));
  const policy: SharedPolicy = { network: 'sandbox', registry: 'forest.test.near', denomination: vector.pool.denomination, feeRecipient: 'treasury.test.near', registryWasmSha256: 'aa'.repeat(32), vaultWasmSha256: 'bb'.repeat(32), verifierSha256: 'cc'.repeat(32) };
  if (ft) policy.tokenId = 'usdc.test.near';
  const q = quoteFees(policy.denomination), pool: Pool = ft ? { version: 3, tokenId: policy.tokenId!, network: policy.network, contract: policy.registry, denomination: policy.denomination } : { version: 2, network: policy.network, contract: policy.registry, denomination: policy.denomination };
  const ids = [predictSharedVault(policy.registry, 'alice.test.near', 'ab'.repeat(32)), predictSharedVault(policy.registry, 'bob.test.near', 'cd'.repeat(32))];
  const config = { protocol: ft ? 'core-shared-ft-registry-v3' : 'core-shared-registry-v2', asset_token_id: ft ? policy.tokenId! : null, deposit_token_amount: ft ? (BigInt(policy.denomination) + BigInt(q.depositProtocolFee)).toString() : null, withdrawal_token_fee: ft ? q.withdrawalProtocolFee : null, storage_credit_bond: '5000000000000000000000', network: policy.network, denomination: policy.denomination, fee_recipient: policy.feeRecipient,
    deposit_fee_bps: 15, withdrawal_fee_bps: 15, deposit_attached: ft ? STORAGE_FEE.toString() : q.depositAttached, withdrawal_attached: ft ? STORAGE_FEE.toString() : q.withdrawalAttached, withdrawal_received: q.withdrawalReceived,
    storage_fee: STORAGE_FEE.toString(), vault_wasm_sha256: policy.vaultWasmSha256, verifier_sha256: policy.verifierSha256,
    vault_count: 2, creation_deposit: '450', vault_funding: '400', registration_fee: '50', domain: domain(pool), root: vector.root, leaf_count: 2, capacity: 256, outstanding_notes: 2 };
  const records = ids.map((account_id, index) => ({ index, account_id, state: 'Ready', available_notes: 1, reserved_notes: 0 }));
  const local = ids.map(() => ({ protocol: ft ? 'core-shared-ft-vault-v3' : 'core-shared-vault-v2', asset_token_id: ft ? policy.tokenId! : null, deposit_token_amount: ft ? (BigInt(policy.denomination) + BigInt(q.depositProtocolFee)).toString() : null, storage_credit_bond: '5000000000000000000000', registry: policy.registry, network: policy.network, denomination: policy.denomination,
    fee_recipient: policy.feeRecipient, deposit_fee_bps: 15, withdrawal_fee_bps: 15, storage_fee: STORAGE_FEE.toString(), deposit_attached: ft ? STORAGE_FEE.toString() : q.depositAttached,
    withdrawal_received: q.withdrawalReceived, available_notes: 1, reserved_notes: 0, pending_deposits: 0, held_notes: 1 }));
  const blocks: string[] = []; const seen = (b: string) => blocks.push(b);
  const source: SharedChainSource = { network: policy.network, factory: policy.registry, finalizedBlock: async () => 'pinned-final-block',
    config: async b => { seen(b); return config; },
    records: async (from, limit, b) => { seen(b); return records.slice(from, from + limit); },
    vaultConfig: async (account, b) => { seen(b); return local[ids.indexOf(account)]; },
    codeSha256: async (account, b) => { seen(b); return account === policy.registry ? policy.registryWasmSha256 : policy.vaultWasmSha256; },
    accessKeys: async (_account, b) => { seen(b); return []; },
    commitments: async b => { seen(b); return [vector.a, vector.b]; },
  };
  return { policy, pool, source, config, records, local, blocks, ids, vector };
}

test('shared domains bind registry and denomination but no origin vault', () => {
  const pool: Pool = { version: 2, network: 'sandbox', contract: 'forest.test.near', denomination: '1000000000000000000000000' };
  assert.notEqual(domain(pool), domain({ ...pool, version: 1 }));
  const action = { kind: 'withdraw' as const, vault: 'a.forest.test.near', target: 'receiver.test.near', disclosureRoot: 'ab'.repeat(32) };
  assert.notEqual(contextHash(pool, action), contextHash(pool, { ...action, vault: 'b.forest.test.near' }));
  assert.throws(() => contextHash(pool, { ...action, vault: undefined }));
  assert.throws(() => contextHash({ ...pool, version: 1 }, action));
});
test('shared discovery verifies keyless contracts and rebuilds one global root at the same final block', async () => {
  const f = await fixture(), c = await discoverSharedVaults(f.source, f.policy), tree = await loadSharedTree(f.source, c);
  assert.equal(c.pool.version, 2); assert.equal(c.vaults.length, 2); assert.equal(tree.root, f.vector.root);
  assert.deepEqual(new Set(f.blocks), new Set(['pinned-final-block']));
});
test('routing excludes temporarily unactivated liquidity and only uses verified members', async () => {
  const f = await fixture(); f.local[0].available_notes = 0; f.local[0].pending_deposits = 1;
  const c = await discoverSharedVaults(f.source, f.policy);
  assert.equal(c.vaults[0].canWithdraw, false); assert.equal(chooseSharedVault(c, 'withdraw'), f.ids[1]);
});
test('shared discovery rejects wrong group, treasury, code, fee policy or remaining keys', async () => {
  const mutations: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    f => { f.local[0].registry = 'other.test.near'; },
    f => { f.config.fee_recipient = 'attacker.test.near'; },
    f => { f.config.withdrawal_attached = STORAGE_FEE.toString(); },
    f => { f.config.domain = '42'; },
    f => { f.source.accessKeys = async () => [{}]; },
    f => { f.source.codeSha256 = async () => 'dd'.repeat(32); },
  ];
  for (const mutate of mutations) { const f = await fixture(); mutate(f); await assert.rejects(discoverSharedVaults(f.source, f.policy)); }
});
test('untrusted, omitted or reordered commitments cannot become a shared witness', async () => {
  for (const mode of ['omit', 'reorder', 'invent']) {
    const f = await fixture(), c = await discoverSharedVaults(f.source, f.policy);
    f.source.commitments = async () => mode === 'omit' ? [f.vector.a] : mode === 'reorder' ? [f.vector.b, f.vector.a] : [f.vector.a, '42'];
    await assert.rejects(loadSharedTree(f.source, c));
  }
});
test('shared catalog pagination is explicit and full groups cannot receive new deposits', async () => {
  const f = await fixture(); f.config.leaf_count = 256;
  const c = await discoverSharedVaults(f.source, f.policy, { maxRecords: 1 });
  assert.equal(c.nextIndex, 1); assert.equal(c.vaults[0].canDeposit, false);
  assert.throws(() => chooseSharedVault(c, 'deposit'));
});

test('FT discovery pins the token account and keeps NEAR storage distinct from token fees', async () => {
  const f = await fixture(true), c = await discoverSharedVaults(f.source, f.policy);
  assert.equal(c.pool.version, 3); assert.equal(c.pool.tokenId, 'usdc.test.near');
  assert.equal((await loadSharedTree(f.source, c)).root, f.vector.root);
  for (const mutate of [
    (x: typeof f) => { x.config.asset_token_id = 'fake.test.near'; },
    (x: typeof f) => { x.local[0].asset_token_id = 'fake.test.near'; },
    (x: typeof f) => { x.config.withdrawal_token_fee = '1499'; },
    (x: typeof f) => { x.local[0].deposit_token_amount = '1000000'; },
    (x: typeof f) => { x.config.withdrawal_attached = '1500'; },
    (x: typeof f) => { delete x.policy.tokenId; },
  ]) { const next = await fixture(true); mutate(next); await assert.rejects(discoverSharedVaults(next.source, next.policy)); }
});
