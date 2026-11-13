import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { InMemorySigner, KeyPair, transactions } from 'near-api-js';
import { releaseFixture } from './fixtures/releases.js';
import { operationsFixture } from './fixtures/operations.js';
import { domain, quoteFees } from '../sdk/core.js';
import { digest } from '../scripts/lib/release.js';
import { buildDeploymentPlan, decodeDeploymentSignedTransaction, deploymentKeyFile, deploymentPreflight, executeDeployment, loadDeployment, reconcileDeployment, saveDeploymentPlan, type DeploymentSource } from '../scripts/lib/deployment.js';

async function fixture(t: { after(fn: () => void): void }, native = false) {
  const f = releaseFixture(t), base = operationsFixture(native), pair = KeyPair.fromRandom('ed25519'), pk = pair.getPublicKey().toString();
  if (native) { delete (f.policy as Partial<typeof f.policy>).tokenId; f.add('policies/usdc.json', f.policy); }
  const release = f.build();
  const input = { format: 'core-testnet-deployment-input-v1', groupId: 'usdc', rpcUrl: 'https://rpc.testnet.near.org', publicKey: pk,
    gasReserveYoctoNear: '100000000000000000000000', maxRegistrationYoctoNear: native ? '0' : '10000000000000000000000', ...(native ? {} : { tokenCodeSha256: 'f'.repeat(64) }) };
  const plan = buildDeploymentPlan(f.output, release.manifestSha256, input), planFile = resolve(f.dir, 'plan.json'), saved = saveDeploymentPlan(planFile, plan);
  const context = loadDeployment(planFile, saved.planSha256, f.output), p = plan.policy, q = quoteFees(p.denomination);
  const config = { ...base.config, network: 'testnet', denomination: p.denomination, asset_token_id: p.tokenId ?? null, fee_recipient: p.feeRecipient,
    vault_wasm_sha256: p.vaultWasmSha256, verifier_sha256: p.verifierSha256, leaf_count: 0, outstanding_notes: 0, vault_count: 0,
    domain: domain(p.tokenId ? { network: 'testnet', contract: p.registry, version: 3, tokenId: p.tokenId, denomination: p.denomination } : { network: 'testnet', contract: p.registry, version: 2, denomination: p.denomination }),
    deposit_attached: native ? q.depositAttached : base.config.deposit_attached, withdrawal_attached: native ? q.withdrawalAttached : base.config.withdrawal_attached, withdrawal_received: p.denomination };
  let keys = [{ public_key: pk, access_key: { permission: 'FullAccess' as unknown, nonce: 1 } }];
  const state = { chainId: 'testnet', syncing: false, age: 0, headLag: 0, code: false, emptyState: true, balance: '100000000000000000000000000', treasury: true, gasPrice: '100000000', tokenHash: 'f'.repeat(64), min: '1250000000000000000000', height: 20, broadcasts: 0, fail: false, loseResponse: false, unknown: false };
  const registered = new Set<string>(), history = new Map<string, any>(), reads: string[] = [];
  const seen = (b: string) => { reads.push(b); };
  const source: DeploymentSource = {
    network: 'testnet', factory: p.registry,
    chain: async () => ({ chainId: state.chainId, syncing: state.syncing, latestHeight: state.height + state.headLag, latestTime: new Date(Date.now() - state.age).toISOString() }),
    finalBlock: async () => ({ hash: bs58.encode(Buffer.alloc(32, state.height)), height: state.height }),
    finalizedBlock: async () => { throw new Error('Must use the pinned final block'); },
    account: async (a, b) => { seen(b); return !state.treasury && a === p.feeRecipient ? null : { amount: state.balance, locked: '0', storage_usage: 100, code_hash: state.code && a === p.registry ? bs58.encode(Buffer.from(p.registryWasmSha256, 'hex')) : bs58.encode(Buffer.alloc(32)) }; },
    accessKeys: async (_, b) => { seen(b); return keys; },
    codeSha256: async (a, b) => { seen(b); return a === p.tokenId ? state.tokenHash : p.registryWasmSha256; },
    emptyState: async (_, b) => { seen(b); return state.emptyState; },
    costs: async b => { seen(b); return { storageByteCost: '10000000000000000000', gasPrice: state.gasPrice }; },
    config: async b => { seen(b); return config; }, records: async () => [], vaultConfig: async () => { throw new Error('No vaults'); }, commitments: async () => [],
    contractView: async (_, method, args, b) => {
      seen(b);
      if (method === 'ft_metadata') return { spec: 'ft-1.0.0', decimals: 6, symbol: 'TEST' };
      if (method === 'storage_balance_bounds') return { min: state.min, max: state.min };
      if (method === 'storage_balance_of') return registered.has(args.account_id as string) ? { total: state.min, available: '0' } : null;
      throw new Error('Unexpected view');
    },
    transaction: async hash => state.unknown ? null : history.get(hash) ?? null,
    submit: async encoded => {
      state.broadcasts++;
      const { transaction: tx, signature } = decodeDeploymentSignedTransaction(Buffer.from(encoded, 'base64'));
      const hash = bs58.encode(createHash('sha256').update(tx.encode()).digest());
      const actions = tx.actions.map((a: transactions.Action) => {
        if (a.deployContract) return { DeployContract: { code: createHash('sha256').update(Buffer.from(a.deployContract.code)).digest('base64') } };
        if (a.functionCall) return { FunctionCall: { method_name: a.functionCall.methodName, args: Buffer.from(a.functionCall.args).toString('base64'), gas: Number(a.functionCall.gas), deposit: a.functionCall.deposit.toString() } };
        if (a.deleteKey) return { DeleteKey: { public_key: pk } };
        throw new Error('Unexpected action');
      });
      if (keys[0]) keys[0].access_key.nonce = Number(tx.nonce);
      if (!state.fail) for (const action of tx.actions as transactions.Action[]) {
        if (action.deployContract) state.code = true;
        if (action.functionCall?.methodName === 'storage_deposit') registered.add(JSON.parse(Buffer.from(action.functionCall.args).toString()).account_id);
        if (action.deleteKey) keys = [];
      }
      state.height++;
      const result = { final_execution_status: 'FINAL', transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, public_key: tx.publicKey.toString(), nonce: Number(tx.nonce), signature: `ed25519:${bs58.encode(signature)}`, actions },
        status: state.fail ? { Failure: { test: 'final failure' } } : { SuccessValue: '' }, transaction_outcome: { outcome: { status: { SuccessReceiptId: hash } } }, receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] };
      history.set(hash, result);
      if (state.loseResponse) throw new Error('Response lost after broadcast');
      return result;
    },
  };
  const signer = async (tx: transactions.Transaction) => (await transactions.signTransaction(tx, await InMemorySigner.fromKeyPair('testnet', p.registry, pair), p.registry, 'testnet'))[1];
  const journal = resolve(f.dir, 'journal.json');
  const run = (phase: 'deploy' | 'register-registry' | 'register-treasury' | 'seal', options = {}) => executeDeployment(context, source, phase, journal, saved.planSha256, signer, options);
  return { ...f, context, input, planFile, saved, plan, source, state, reads, registered, config, history, pair, signer, journal, run, setKeys: (v: typeof keys) => { keys = v; } };
}

test('deployment plans bind testnet release/actions and reject modified files or sandbox releases', async t => {
  const f = await fixture(t);
  assert.equal(f.plan.initMethod, 'new_ft'); assert.equal(f.plan.keyRemoval, 'separate_explicit_phase');
  const changed = { ...f.plan, initArgs: { ...f.plan.initArgs, fee_recipient: 'substituted.testnet' } };
  writeFileSync(f.planFile, JSON.stringify(changed));
  assert.throws(() => loadDeployment(f.planFile, f.saved.planSha256, f.output), /reviewed digest/);
  assert.throws(() => loadDeployment(f.planFile, digest(readFileSync(f.planFile)), f.output), /actions differ/);
  const other = releaseFixture(t); other.metadata.network = 'sandbox'; other.policy.network = 'sandbox'; other.add('policies/usdc.json', other.policy);
  const release = other.build();
  assert.throws(() => buildDeploymentPlan(other.output, release.manifestSha256, f.input), /testnet release/);
});

test('deployment preflight uses one finalized block, exact FT costs and no broadcasts', async t => {
  const f = await fixture(t), result = await deploymentPreflight(f.context, f.source, 'deploy');
  assert.equal(new Set(f.reads).size, 1); assert.equal(result.registration.length, 2);
  assert.equal(result.registration[0].deposit, f.state.min); assert.equal(result.broadcast, false);
  assert.equal(result.fundsReady, false); assert.equal(f.state.broadcasts, 0);
});

test('deployment preflight rejects wrong chain, stale ownership, existing code/state, low funds and changed token costs', async t => {
  for (const mode of ['mainnet', 'sync', 'stale', 'lag', 'code', 'state', 'balance', 'treasury', 'keys', 'permission', 'token', 'registration', 'gas']) {
    const f = await fixture(t);
    if (mode === 'mainnet') f.state.chainId = 'mainnet';
    if (mode === 'sync') f.state.syncing = true;
    if (mode === 'stale') f.state.age = 180000;
    if (mode === 'lag') f.state.headLag = 20;
    if (mode === 'code') f.state.code = true;
    if (mode === 'state') f.state.emptyState = false;
    if (mode === 'balance') f.state.balance = '1';
    if (mode === 'treasury') f.state.treasury = false;
    if (mode === 'keys') f.setKeys([]);
    if (mode === 'permission') f.setKeys([{ public_key: f.plan.publicKey, access_key: { nonce: 1, permission: { FunctionCall: {} } } }]);
    if (mode === 'token') f.state.tokenHash = '0'.repeat(64);
    if (mode === 'registration') f.state.min = '100000000000000000000000';
    if (mode === 'gas') f.state.gasPrice = '1000000000000';
    await assert.rejects(() => deploymentPreflight(f.context, f.source, 'deploy')); assert.equal(f.state.broadcasts, 0);
  }
});

test('deployment executes atomic init, explicit registrations and separately acknowledged sealing', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('deploy')).state, 'complete');
  assert.equal((await f.run('deploy')).state, 'already_complete'); assert.equal(f.state.broadcasts, 1);
  await assert.rejects(() => f.run('seal'), /acknowledgement/);
  await assert.rejects(() => f.run('seal', { acknowledgeKeyRemoval: true }), /Register/);
  assert.equal((await f.run('register-registry')).state, 'complete');
  assert.equal((await f.run('register-treasury')).state, 'complete');
  f.config.leaf_count = 1;
  await assert.rejects(() => f.run('seal', { acknowledgeKeyRemoval: true }), /Seal before/);
  f.config.leaf_count = 0;
  assert.equal((await f.run('seal', { acknowledgeKeyRemoval: true })).state, 'complete');
  assert.equal((await deploymentPreflight(f.context, f.source, 'verify')).keyless, true);
  assert.equal(f.state.broadcasts, 4); assert.equal(existsSync(f.journal + '.lock'), false);
});

test('native groups deploy and seal without FT registration', async t => {
  const f = await fixture(t, true); assert.equal(f.plan.initMethod, 'new');
  await f.run('deploy'); await assert.rejects(() => f.run('register-registry'), /no token registration/);
  await f.run('seal', { acknowledgeKeyRemoval: true });
  assert.equal((await deploymentPreflight(f.context, f.source, 'verify')).keyless, true);
});

test('uncertain broadcasts stay blocked and reconcile only their original final transaction', async t => {
  const f = await fixture(t); f.state.loseResponse = true;
  await assert.rejects(() => f.run('deploy'), /uncertain/);
  await assert.rejects(() => f.run('deploy'), /Unresolved/); assert.equal(f.state.broadcasts, 1);
  f.state.unknown = true;
  const pending = await reconcileDeployment(f.context, f.source, f.journal, f.saved.planSha256);
  assert.equal(pending.attempts[0].state, 'submitted'); assert.equal(pending.automaticResubmit, false);
  f.state.unknown = false;
  const result = await reconcileDeployment(f.context, f.source, f.journal, f.saved.planSha256);
  assert.equal(result.attempts[0].state, 'complete'); assert.equal(f.state.broadcasts, 1);
});

test('only a proven final failure permits an explicit fresh-nonce retry', async t => {
  const f = await fixture(t); f.state.fail = true;
  assert.equal((await f.run('deploy')).state, 'failed');
  await assert.rejects(() => f.run('deploy'), /Explicit retry/);
  f.state.fail = false; assert.equal((await f.run('deploy', { retryFinalFailure: true })).state, 'complete');
  const journal = JSON.parse(readFileSync(f.journal, 'utf8'));
  assert.equal(journal.attempts.length, 2); assert.notEqual(journal.attempts[0].hash, journal.attempts[1].hash);
});

test('signing preserves durable intent, rejects substituted payloads and rechecks state before dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(() => executeDeployment(f.context, f.source, 'deploy', f.journal, f.saved.planSha256, async tx => {
    f.state.code = true; return f.signer(tx);
  }), /overwrite/);
  assert.equal(f.state.broadcasts, 0); assert.equal(JSON.parse(readFileSync(f.journal, 'utf8')).attempts[0].state, 'intent');
  const other = await fixture(t);
  await assert.rejects(() => executeDeployment(other.context, other.source, 'deploy', other.journal, other.saved.planSha256, async tx => {
    tx.receiverId = 'different.testnet'; return other.signer(tx);
  }), /Signer changed/);
  assert.equal(other.state.broadcasts, 0);
});

test('journal locks reject concurrent signing and preserve the original intent', async t => {
  const f = await fixture(t); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), resume = new Promise<void>(r => { finish = r; });
  const first = executeDeployment(f.context, f.source, 'deploy', f.journal, f.saved.planSha256, async tx => { enter(); await resume; return f.signer(tx); });
  await entered; await assert.rejects(() => f.run('deploy'), /EEXIST/); finish(); await first;
  assert.equal(f.state.broadcasts, 1);
});

test('signed bytes are snapshotted before the post-signing preflight can mutate a signer result', async t => {
  const f = await fixture(t); let signed: transactions.SignedTransaction | undefined;
  const chain = f.source.chain;
  f.source.chain = async () => { if (signed) signed.transaction.receiverId = 'late-substitution.testnet'; return chain(); };
  const result = await executeDeployment(f.context, f.source, 'deploy', f.journal, f.saved.planSha256, async tx => { signed = await f.signer(tx); return signed; });
  assert.equal(result.state, 'complete');
  assert.equal([...f.history.values()][0].transaction.receiver_id, f.plan.policy.registry);
});

test('journal binding and final outcome verification reject altered plans or actions', async t => {
  const f = await fixture(t); f.state.loseResponse = true; await assert.rejects(() => f.run('deploy'));
  await assert.rejects(() => reconcileDeployment(f.context, f.source, f.journal, '0'.repeat(64)), /another plan/);
  const original = [...f.history.values()][0]; original.transaction.actions[0].DeployContract.code = Buffer.alloc(32).toString('base64');
  await assert.rejects(() => reconcileDeployment(f.context, f.source, f.journal, f.saved.planSha256), /deploy code differs/);
  assert.equal(JSON.parse(readFileSync(f.journal, 'utf8')).attempts[0].state, 'submitted');
});

test('deployment key file is local, owner-only and bound to the reviewed account/public key', async t => {
  const f = await fixture(t), file = resolve(f.dir, 'local-key.json');
  writeFileSync(file, JSON.stringify({ account_id: f.plan.policy.registry, public_key: f.plan.publicKey, private_key: f.pair.toString() }), { mode: 0o600 });
  assert.equal(typeof deploymentKeyFile(file, f.plan), 'function'); chmodSync(file, 0o644);
  assert.throws(() => deploymentKeyFile(file, f.plan), /owner-only/);
  chmodSync(file, 0o600); writeFileSync(file, JSON.stringify({ account_id: 'other.testnet', public_key: f.plan.publicKey, private_key: f.pair.toString() }));
  assert.throws(() => deploymentKeyFile(file, f.plan), error => error instanceof Error && !error.message.includes(f.pair.toString()));
});
