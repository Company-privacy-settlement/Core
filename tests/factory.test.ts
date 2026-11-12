import test from 'node:test';
import assert from 'node:assert/strict';
import { domain, quoteFees, STORAGE_FEE } from '../sdk/core.js';
import { discoverVaults, predictVaultAccount, type FactoryPolicy, type FactoryChainSource } from '../sdk/factory.js';

function fixture() {
  const policy: FactoryPolicy = { network: 'sandbox', factory: 'factory.test.near', denomination: '1000000000000000000000000', feeRecipient: 'treasury.test.near', factoryWasmSha256: 'aa'.repeat(32), vaultWasmSha256: 'bb'.repeat(32), verifierSha256: 'cc'.repeat(32) };
  const q = quoteFees(policy.denomination);
  const feeConfig = { fee_recipient: policy.feeRecipient, deposit_fee_bps: 15, withdrawal_fee_bps: 15, deposit_protocol_fee: q.depositProtocolFee, withdrawal_protocol_fee: q.withdrawalProtocolFee };
  const account = `v${'ab'.repeat(16)}.${policy.factory}`;
  const pool = { network: policy.network, contract: account, denomination: policy.denomination };
  const factoryConfig = { protocol: 'core-factory-v1', network: policy.network, denomination: policy.denomination, vault_wasm_sha256: policy.vaultWasmSha256, verifier_sha256: policy.verifierSha256, vault_funding: '400', registration_fee: '50', creation_deposit: '450', vault_count: 1, ...feeConfig };
  const record = { index: 0, account_id: account, creator: 'alice.test.near', state: 'Ready', funding: '400' };
  const vaultConfig = { protocol: 'core-v1', network: policy.network, denomination: policy.denomination, domain: domain(pool), verifier_sha256: policy.verifierSha256, storage_fee: STORAGE_FEE.toString(), leaf_count: 0, capacity: 256,
    ...feeConfig, deposit_attached: q.depositAttached, withdrawal_attached: q.withdrawalAttached, withdrawal_received: q.withdrawalReceived };
  const blocks: string[] = [];
  const seen = (block: string) => { blocks.push(block); };
  const source: FactoryChainSource = {
    network: policy.network, factory: policy.factory,
    finalizedBlock: async () => 'final-block',
    config: async block => { seen(block); return factoryConfig; },
    records: async (_from, _limit, block) => { seen(block); return [record]; },
    vaultConfig: async (_account, block) => { seen(block); return vaultConfig; },
    codeSha256: async (id, block) => { seen(block); return id === policy.factory ? policy.factoryWasmSha256 : policy.vaultWasmSha256; },
    accessKeys: async (_account, block) => { seen(block); return []; },
  };
  return { policy, source, factoryConfig, record, vaultConfig, blocks };
}

test('address prediction binds creator and salt and stays a direct child', () => {
  const salt = 'ab'.repeat(32), factory = 'factory.test.near';
  const a = predictVaultAccount(factory, 'alice.test.near', salt);
  assert.match(a, /^v[0-9a-f]{32}\.factory\.test\.near$/);
  assert.notEqual(a, predictVaultAccount(factory, 'bob.test.near', salt));
  assert.notEqual(a, predictVaultAccount(factory, 'alice.test.near', 'cd'.repeat(32)));
  assert.throws(() => predictVaultAccount(factory, 'alice.test.near', 'AB'.repeat(32)));
});

test('factory discovery pins code, verifier, domains, empty key lists and one final block', async () => {
  const f = fixture(), catalog = await discoverVaults(f.source, f.policy);
  assert.equal(catalog.vaults.length, 1);
  assert.equal(catalog.vaults[0].canDeposit, true);
  assert.equal(catalog.nextIndex, null);
  assert.deepEqual(new Set(f.blocks), new Set(['final-block']));
});

test('discovery excludes pending/failed accounts even if someone deployed at their address', async () => {
  for (const state of ['Pending', 'Failed']) {
    const f = fixture(); f.record.state = state;
    f.source.vaultConfig = async () => { throw new Error('Must not inspect unsuccessful vault'); };
    assert.equal((await discoverVaults(f.source, f.policy)).vaults.length, 0);
  }
});

test('discovery rejects a factory or vault with any remaining access key', async () => {
  for (const target of ['factory', 'vault']) {
    const f = fixture();
    f.source.accessKeys = async account => (account === f.policy.factory) === (target === 'factory') ? [{ public_key: 'test-key' }] : [];
    await assert.rejects(discoverVaults(f.source, f.policy), /access keys/);
  }
});

test('discovery rejects replaced code, verifier, denomination or root domain', async () => {
  const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.source.codeSha256 = async () => 'dd'.repeat(32); },
    f => { f.source.codeSha256 = async a => a === f.policy.factory ? f.policy.factoryWasmSha256 : 'dd'.repeat(32); },
    f => { f.vaultConfig.verifier_sha256 = 'dd'.repeat(32); },
    f => { f.vaultConfig.denomination = '42'; },
    f => { f.vaultConfig.domain = '42'; },
    f => { f.factoryConfig.verifier_sha256 = 'dd'.repeat(32); },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); await assert.rejects(discoverVaults(f.source, f.policy)); }
});

test('discovery rejects forged child records and truncated pagination', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.record.account_id = 'v' + 'ab'.repeat(16) + '.other.test.near'; },
    (f: ReturnType<typeof fixture>) => { f.record.index = 1; },
    (f: ReturnType<typeof fixture>) => { f.source.records = async () => []; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(discoverVaults(f.source, f.policy)); }
});

test('full vaults remain discoverable but cannot accept deposits', async () => {
  const f = fixture(); f.vaultConfig.leaf_count = 256;
  assert.equal((await discoverVaults(f.source, f.policy)).vaults[0].canDeposit, false);
});
test('discovery refuses changed fee recipient, rates and principal-reducing withdrawal quotes', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.factoryConfig.fee_recipient = 'attacker.test.near'; },
    (f: ReturnType<typeof fixture>) => { f.vaultConfig.fee_recipient = 'attacker.test.near'; },
    (f: ReturnType<typeof fixture>) => { f.vaultConfig.deposit_fee_bps = 150; },
    (f: ReturnType<typeof fixture>) => { f.vaultConfig.withdrawal_attached = STORAGE_FEE.toString(); },
    (f: ReturnType<typeof fixture>) => { f.vaultConfig.withdrawal_received = (BigInt(f.policy.denomination) - 1n).toString(); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(discoverVaults(f.source, f.policy)); }
});
