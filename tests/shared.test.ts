import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domain, contextHash, NoteTree, quoteFees, STORAGE_FEE, createNote, sha256, type Pool } from '../sdk/core.js';
import { encryptPrivate } from '../sdk/disclosure.js';
import { discoverSharedVaults, discoverSharedVaultGroup, loadSharedTree, chooseSharedVault, predictSharedVault, type SharedPolicy, type SharedChainSource } from '../sdk/shared.js';

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
    vaultRecord: async (account, b) => { seen(b); return records.find(r => r.account_id === account) ?? null; },
    vaultConfig: async (account, b) => { seen(b); return local[ids.indexOf(account)]; },
    codeSha256: async (account, b) => { seen(b); return account === policy.registry ? policy.registryWasmSha256 : policy.vaultWasmSha256; },
    accessKeys: async (_account, b) => { seen(b); return []; },
    commitments: async b => { seen(b); return [vector.a, vector.b]; },
  };
  return { policy, pool, source, config, records, local, blocks, ids, vector };
}

async function largeFixture(count = 205, ft = false) {
  const f = await fixture(ft), sample = { ...f.local[0] };
  f.config.vault_count = count; f.config.outstanding_notes = 1;
  f.ids.splice(0, f.ids.length, ...Array.from({ length: count }, (_, i) => `v${i.toString(16).padStart(32, '0')}.${f.policy.registry}`));
  f.records.splice(0, f.records.length, ...f.ids.map((account_id, index) => ({ index, account_id, state: 'Ready', available_notes: index === count - 1 ? 1 : 0, reserved_notes: 0 })));
  f.local.splice(0, f.local.length, ...f.ids.map((_, index) => ({ ...sample, available_notes: index === count - 1 ? 1 : 0, held_notes: index === count - 1 ? 1 : 0 })));
  return f;
}

test('payment selection reaches liquidity after multiple catalog pages at one finalized block', async () => {
  for (const ft of [false, true]) {
    const f = await largeFixture(205, ft); let finalizedReads = 0;
    f.source.finalizedBlock = async () => `block-${++finalizedReads}`;
    const first = await discoverSharedVaults(f.source, f.policy);
    assert.equal(first.nextIndex, 100); assert.throws(() => chooseSharedVault(first, 'withdraw'));
    finalizedReads = 0; f.blocks.length = 0;
    const all = await discoverSharedVaultGroup(f.source, f.policy);
    assert.equal(all.checkedRecords, 205); assert.equal(all.nextIndex, null);
    assert.equal(chooseSharedVault(all, 'withdraw'), f.ids[204]);
    assert.equal(finalizedReads, 1); assert.deepEqual(new Set(f.blocks), new Set(['block-1']));
  }
});

test('direct vault verification works beyond the scan budget without scanning other vaults', async () => {
  const f = await largeFixture(1001, true), pages: [number, number][] = [], checked: string[] = [];
  await assert.rejects(discoverSharedVaultGroup(f.source, f.policy), /scan budget exceeded/);
  const records = f.source.records, config = f.source.vaultConfig;
  f.source.records = async (from, limit, b) => { pages.push([from, limit]); return records(from, limit, b); };
  f.source.vaultConfig = async (a, b) => { checked.push(a); return config(a, b); };
  const selected = await discoverSharedVaultGroup(f.source, f.policy, { vault: f.ids[1000] });
  assert.equal(chooseSharedVault(selected, 'withdraw'), f.ids[1000]);
  assert.deepEqual(pages, [[1000, 1]]); assert.deepEqual(checked, [f.ids[1000]]);
});

test('direct verification rejects foreign records, page mismatches and unsafe selected contracts', async () => {
  const mutations: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    f => { f.source.vaultRecord = async () => null; },
    f => { f.source.vaultRecord = async () => ({ ...f.records[0], index: 2 }); },
    f => { f.source.vaultRecord = async () => ({ ...f.records[0], index: 1 }); },
    f => { f.source.accessKeys = async a => a === f.ids[0] ? [{}] : []; },
    f => { f.source.codeSha256 = async a => a === f.ids[0] ? 'dd'.repeat(32) : f.policy.registryWasmSha256; },
    f => { f.local[0].registry = 'foreign.test.near'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); mutate(f);
    await assert.rejects(discoverSharedVaultGroup(f.source, f.policy, { vault: f.ids[0] }));
  }
  const pending = await fixture(); pending.records[0].state = 'Pending';
  const catalog = await discoverSharedVaultGroup(pending.source, pending.policy, { vault: pending.ids[0] });
  assert.throws(() => chooseSharedVault(catalog, 'withdraw'), /No verified vault/);
});

test('group discovery refuses partial budgets or inconsistent page snapshots', async () => {
  const f = await largeFixture();
  await assert.rejects(discoverSharedVaultGroup(f.source, f.policy, { maxRecords: 100 }), /scan budget exceeded/);
  let reads = 0; const config = f.source.config;
  f.source.config = async b => ({ ...await config(b) as object, root: ++reads === 1 ? f.config.root : '42' });
  await assert.rejects(discoverSharedVaultGroup(f.source, f.policy), /snapshot changed/);
});

test('CLI verifies an explicitly chosen FT deposit vault beyond the first catalog page', async () => {
  const f = await largeFixture(205, true), dir = await mkdtemp(join(tmpdir(), 'core-vault-cli-'));
  const registryCode = Buffer.from('registry-code'), vaultCode = Buffer.from('vault-code');
  f.policy.registryWasmSha256 = sha256(registryCode); f.policy.vaultWasmSha256 = sha256(vaultCode);
  f.config.vault_wasm_sha256 = f.policy.vaultWasmSha256;
  const pages: [number, number][] = [], blocks: string[] = [];
  let finalizedReads = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body), p = call.params; let result: unknown;
      if (call.method === 'block') { finalizedReads++; result = { header: { hash: 'fixed-final-block' } }; }
      else {
        assert.equal(call.method, 'query'); blocks.push(p.block_id);
        if (p.request_type === 'view_code') result = { code_base64: (p.account_id === f.policy.registry ? registryCode : vaultCode).toString('base64') };
        else if (p.request_type === 'view_access_key_list') result = { keys: [] };
        else {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()); let value: unknown;
          if (p.method_name === 'get_config') value = p.account_id === f.policy.registry ? f.config : f.local[f.ids.indexOf(p.account_id)];
          else if (p.method_name === 'get_vault') value = f.records.find(v => v.account_id === args.account_id) ?? null;
          else if (p.method_name === 'list_vaults') { pages.push([args.from_index, args.limit]); value = f.records.slice(args.from_index, args.from_index + args.limit); }
          else throw new Error('Unexpected RPC method');
          result = { result: [...Buffer.from(JSON.stringify(value))] };
        }
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const password = 'shared CLI regression password', policyFile = join(dir, 'policy.json'), noteFile = join(dir, 'note.json');
    await writeFile(policyFile, JSON.stringify(f.policy));
    await writeFile(noteFile, encryptPrivate(await createNote(f.pool), password));
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', 'shared-deposit-args', policyFile, `http://127.0.0.1:${address.port}`, noteFile, 'ab'.repeat(32), f.ids[204]], { env: { ...process.env, CORE_NOTE_PASSWORD: password } });
    const plan = JSON.parse(stdout);
    assert.equal(plan.tokenCall.args.receiver_id, f.ids[204]); assert.equal(plan.tokenCall.args.amount, '1001500');
    assert.equal(plan.checkedAtBlock, 'fixed-final-block'); assert.equal(finalizedReads, 1);
    assert.deepEqual(new Set(blocks), new Set(['fixed-final-block'])); assert.deepEqual(pages, [[204, 1]]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

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
