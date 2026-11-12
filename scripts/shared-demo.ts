import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Worker, type TransactionResult, type NearAccount } from 'near-workspaces';
import { createNote, proveSpend, encodeVerificationKey, sha256, quoteFees, STORAGE_FEE, shutdownProver, type Pool } from '../sdk/core.js';
import { discoverSharedVaults, loadSharedTree, predictSharedVault, NearRpcSharedSource, type SharedPolicy } from '../sdk/shared.js';
import { createFreshRecipient } from '../sdk/wallet.js';
import { createReceipt, disclose, type Receipt } from '../sdk/disclosure.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { ensureSandbox } from './sandbox.js';

const NEAR = 10n ** 24n, GAS = 300n * 10n ** 12n;
const registryWasm = await readFile('artifacts/core_forest.wasm'), vaultWasm = await readFile('artifacts/core_shared_vault.wasm');
const vk = encodeVerificationKey(JSON.parse(await readFile('artifacts/verification_key.json', 'utf8')));
await ensureSandbox(); const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const forest = await root.createSubAccount('forest', { initialBalance: 25n * NEAR });
  const alice = await root.createSubAccount('alice', { initialBalance: 30n * NEAR });
  const bob = await root.createSubAccount('bob', { initialBalance: 30n * NEAR });
  const relay = await root.createSubAccount('relay', { initialBalance: 10n * NEAR });
  const treasury = await root.createSubAccount('treasury', { initialBalance: NEAR });
  const rpc = (worker.provider as any).connection.url as string;
  const evidence = new NearRpcEvidenceSource('sandbox', forest.accountId, rpc);
  async function final(tx: TransactionResult) { const out: any = await evidence.getTransaction({ hash: tx.transactionReceipt.hash, signer: tx.transactionReceipt.signer_id, recordIndex: 0 }); assert.equal(out.final_execution_status, 'FINAL'); }
  await forest.deploy(registryWasm);
  await forest.call(forest, 'new', { network: 'sandbox', denomination: NEAR.toString(), verification_key: vk, fee_recipient: treasury.accountId }, { attachedDeposit: NEAR, gas: GAS });
  const config: any = await forest.view('get_config');
  async function createVault(owner: NearAccount) {
    const salt = randomBytes(32).toString('hex'), address = predictSharedVault(forest.accountId, owner.accountId, salt);
    assert.equal(await forest.view('predict_vault', { creator: owner.accountId, salt }), address);
    const tx = await owner.callRaw(forest, 'create_vault', { salt }, { attachedDeposit: BigInt(config.creation_deposit), gas: GAS });
    assert.equal(tx.parseResult(), true, tx.summary()); await final(tx);
    const vault = root.getAccount(address); assert.deepEqual((await vault.viewAccessKeys(address)).keys, []); return vault;
  }
  const a = await createVault(alice), b = await createVault(bob);
  const key = await forest.getKey(); assert.ok(key);
  await final(await forest.batch(forest).deleteKey(key.getPublicKey()).transact());
  const policy: SharedPolicy = { network: 'sandbox', registry: forest.accountId, denomination: NEAR.toString(), feeRecipient: treasury.accountId,
    registryWasmSha256: sha256(registryWasm), vaultWasmSha256: sha256(vaultWasm), verifierSha256: sha256(Buffer.from(vk, 'base64')) };
  const source = new NearRpcSharedSource('sandbox', forest.accountId, rpc);
  let catalog = await discoverSharedVaults(source, policy);
  assert.equal(catalog.vaults.length, 2);
  const pool: Pool = catalog.pool, fees = quoteFees(NEAR);
  const notes = [await createNote(pool), await createNote(pool), await createNote(pool)];
  const receipts = new Map<string, Receipt>();
  function receipt() {
    const r = createReceipt({ sender: 'demo sender', recipient: 'demo recipient', asset: 'NEAR', amount: NEAR.toString(), purpose: 'shared anonymity demo', reference: randomBytes(16).toString('hex'), occurredAt: new Date().toISOString(), credentialHash: '' });
    receipts.set(r.root, r); return r.root;
  }
  const transactions: TransactionResult[] = [];
  const beforePrincipal = BigInt((await forest.balance()).total.toString());
  for (const [index, vault, owner] of [[0, a, alice], [1, b, bob], [2, b, bob]] as const) {
    const tx = await owner.callRaw(vault, 'deposit', { commitment: notes[index].commitment, disclosure_root: receipt() }, { attachedDeposit: BigInt(fees.depositAttached), gas: GAS });
    assert.equal(tx.parseResult(), true, tx.summary()); await final(tx); transactions.push(tx);
    assert.equal((await vault.view<any>('get_deposit', { commitment: notes[index].commitment })).state, 'Active');
  }
  assert.ok(BigInt((await forest.balance()).total.toString()) - beforePrincipal < NEAR / 10n);
  catalog = await discoverSharedVaults(source, policy);
  assert.equal(catalog.outstandingNotes, 3); assert.equal(catalog.leafCount, 3);
  console.log('Three deposits across two keyless vaults share one verified root; registry holds no deposit principal.');
  const duplicate = await alice.callRaw(b, 'deposit', { commitment: notes[0].commitment, disclosure_root: receipt() }, { attachedDeposit: BigInt(fees.depositAttached), gas: GAS });
  assert.equal(duplicate.parseResult(), false, duplicate.summary()); await final(duplicate);
  assert.equal((await b.view<any>('get_deposit', { commitment: notes[0].commitment })).state, 'Refundable');
  const beforeRefund = BigInt((await alice.balance()).total.toString());
  const refunded = await relay.callRaw(b, 'claim_deposit_refund', { commitment: notes[0].commitment }, { attachedDeposit: 1n, gas: GAS });
  assert.equal(refunded.parseResult(), true, refunded.summary()); await final(refunded);
  assert.equal(BigInt((await alice.balance()).total.toString()) - beforeRefund, NEAR + BigInt(fees.depositProtocolFee));
  assert.equal((await forest.view<any>('get_config')).outstanding_notes, 3);
  console.log('Duplicate cross-vault deposit rejected and principal plus protocol fee refunded to the original payer.');
  await assert.rejects(alice.call(forest, 'register_deposit', { commitment: '42', disclosure_root: receipt() }, { attachedDeposit: 3n * STORAGE_FEE / 4n, gas: GAS }));

  const transferred = await createNote(pool), transferRoot = receipt();
  let tree = await loadSharedTree(source, catalog);
  const transferProof = await proveSpend(pool, notes[0], tree, { kind: 'transfer', target: transferred.commitment, disclosureRoot: transferRoot });
  const transfer = await relay.callRaw(forest, 'transfer', { output_commitment: transferred.commitment, disclosure_root: transferRoot, ...transferProof.args }, { attachedDeposit: STORAGE_FEE, gas: GAS });
  assert.equal(transfer.parseResult(), 3); await final(transfer); transactions.push(transfer);
  catalog = await discoverSharedVaults(source, policy); tree = await loadSharedTree(source, catalog);
  const receiver1 = createFreshRecipient('shared-demo-local-recipient'), out1 = receipt();
  const first = await proveSpend(pool, transferred, tree, { kind: 'withdraw', vault: b.accountId, target: receiver1.accountId, disclosureRoot: out1 });
  const paid = await relay.callRaw(forest, 'withdraw', { vault: b.accountId, recipient: receiver1.accountId, disclosure_root: out1, ...first.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS });
  assert.equal(paid.parseResult(), true, paid.summary()); await final(paid); transactions.push(paid);
  assert.equal((await root.getAccount(receiver1.accountId).balance()).total.toString(), NEAR.toString());
  console.log('A-origin note transferred privately and paid from vault B to a fresh recipient.');

  const receiver2 = createFreshRecipient('shared-demo-race-recipient'), raceRoot = receipt();
  const proofA = await proveSpend(pool, notes[1], tree, { kind: 'withdraw', vault: a.accountId, target: receiver2.accountId, disclosureRoot: raceRoot });
  const proofB = await proveSpend(pool, notes[1], tree, { kind: 'withdraw', vault: b.accountId, target: receiver2.accountId, disclosureRoot: raceRoot });
  assert.equal(proofA.publicSignals[0], proofB.publicSignals[0]);
  const raced = await Promise.all([
    relay.callRaw(forest, 'withdraw', { vault: a.accountId, recipient: receiver2.accountId, disclosure_root: raceRoot, ...proofA.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS }),
    alice.callRaw(forest, 'withdraw', { vault: b.accountId, recipient: receiver2.accountId, disclosure_root: raceRoot, ...proofB.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS }),
  ]);
  const winners = raced.filter(tx => { try { return tx.parseResult() === true; } catch { return false; } });
  assert.equal(winners.length, 1); await final(winners[0]); transactions.push(winners[0]);
  assert.equal((await root.getAccount(receiver2.accountId).balance()).total.toString(), NEAR.toString());
  catalog = await discoverSharedVaults(source, policy); assert.equal(catalog.outstandingNotes, 1);
  console.log('Concurrent valid proofs targeting different vaults paid once; global nullifier prevented the second spend.');

  const liquidity = catalog.vaults.find(v => v.canWithdraw); assert.ok(liquidity);
  const missing = `retry-recipient.${root.accountId}`, retryRoot = receipt();
  tree = await loadSharedTree(source, catalog);
  const retryProof = await proveSpend(pool, notes[2], tree, { kind: 'withdraw', vault: liquidity.accountId, target: missing, disclosureRoot: retryRoot });
  const failed = await relay.callRaw(forest, 'withdraw', { vault: liquidity.accountId, recipient: missing, disclosure_root: retryRoot, ...retryProof.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS });
  assert.equal(failed.parseResult(), false, failed.summary()); await final(failed); transactions.push(failed);
  assert.equal(await forest.view('is_spent', { nullifier: retryProof.publicSignals[0] }), true);
  assert.equal((await forest.view<any>('get_withdrawal', { nullifier: retryProof.publicSignals[0] })).state, 'Retryable');
  const recipient = await root.createSubAccount('retry-recipient', { initialBalance: NEAR });
  const retried = await relay.callRaw(forest, 'retry_withdrawal', { nullifier: retryProof.publicSignals[0] }, { attachedDeposit: STORAGE_FEE, gas: GAS });
  assert.equal(retried.parseResult(), true, retried.summary()); await final(retried); transactions.push(retried);
  assert.equal((await recipient.balance()).total.toString(), (2n * NEAR).toString());
  assert.equal((await forest.view<any>('get_config')).outstanding_notes, 0);
  assert.equal((await forest.view<any>('get_config')).pending_withdrawal_fees, '0');
  console.log('Failed native payout stayed reserved and retried to the same recipient without a second 0.15% charge.');

  const bundle: SettlementBundle = { version: 2, network: 'sandbox', contract: forest.accountId, scope: 'selected_transactions', transactions: [] };
  for (const tx of transactions) {
    for (const outcome of tx.result.receipts_outcome as any[]) {
      if (outcome.outcome.executor_id !== forest.accountId) continue;
      for (const log of outcome.outcome.logs) {
        if (!log.startsWith('EVENT_JSON:')) continue;
        const event = JSON.parse(log.slice(11));
        for (const record of event.data ?? []) {
          if (typeof record.index !== 'number') continue;
          const r = receipts.get(record.disclosure_root); assert.ok(r);
          bundle.transactions.push({ tx: { hash: tx.transactionReceipt.hash, signer: tx.transactionReceipt.signer_id, recordIndex: record.index }, disclosure: disclose(r, ['asset', 'amount']) });
        }
      }
    }
  }
  const verified = await verifyBundle(bundle, evidence);
  assert.equal(verified.records.length, 12);
  assert.equal(verified.feeSummary!.protocolFeesCharged, (6n * BigInt(fees.depositProtocolFee)).toString());
  assert.equal(verified.feeSummary!.protocolFeesEarned, verified.feeSummary!.protocolFeesCharged);
  const beforeFees = BigInt((await treasury.balance()).total.toString());
  for (const contract of [a, b, forest]) {
    const collected = await relay.callRaw(contract, 'collect_protocol_fees', {}, { attachedDeposit: 1n, gas: GAS });
    assert.equal(collected.parseResult(), true, collected.summary()); await final(collected);
  }
  assert.equal(BigInt((await treasury.balance()).total.toString()) - beforeFees, 6n * BigInt(fees.depositProtocolFee));
  await mkdir('demo-output', { recursive: true });
  await writeFile('demo-output/shared-validation.json', JSON.stringify({ policy, bundle, verification: verified, crossedVaults: true, concurrentSpendPaidOnce: true, retryChargedProtocolFeeOnce: true }, null, 2));
  console.log('Shared v2 demo verified: 12 finalized records and correct fees; report demo-output/shared-validation.json');
} finally { await worker.tearDown(); await shutdownProver(); }
