import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Worker, type NearAccount, type TransactionResult } from 'near-workspaces';
import { createNote, encodeVerificationKey, NoteTree, proveSpend, sha256, shutdownProver, quoteFees, STORAGE_FEE, type Pool } from '../sdk/core.js';
import { createFreshRecipient } from '../sdk/wallet.js';
import { createReceipt, disclose } from '../sdk/disclosure.js';
import { discoverVaults, predictVaultAccount, NearRpcFactorySource, type FactoryPolicy } from '../sdk/factory.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { ensureSandbox } from './sandbox.js';

const NEAR = 10n ** 24n, GAS = 300n * 10n ** 12n;
const factoryWasm = await readFile('artifacts/core_factory.wasm');
const poolWasm = await readFile('artifacts/core_pool.wasm');
const vk = encodeVerificationKey(JSON.parse(await readFile('artifacts/verification_key.json', 'utf8')));
await ensureSandbox();
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const factory = await root.createSubAccount('factory', { initialBalance: 20n * NEAR });
  const alice = await root.createSubAccount('alice', { initialBalance: 20n * NEAR });
  const bob = await root.createSubAccount('bob', { initialBalance: 20n * NEAR });
  const relay = await root.createSubAccount('relay', { initialBalance: 5n * NEAR });
  const treasury = await root.createSubAccount('treasury', { initialBalance: NEAR });
  const fees = quoteFees(NEAR);
  const rpcUrl = (worker.provider as any).connection.url as string;
  async function finalized(result: TransactionResult) {
    const ref = { hash: result.transactionReceipt.hash, signer: result.transactionReceipt.signer_id, recordIndex: 0 };
    const outcome: any = await new NearRpcEvidenceSource('sandbox', factory.accountId, rpcUrl).getTransaction(ref);
    assert.equal(outcome.final_execution_status, 'FINAL');
  }
  await factory.deploy(factoryWasm);
  await factory.call(factory, 'new', { network: 'sandbox', denomination: NEAR.toString(), verification_key: vk, fee_recipient: treasury.accountId }, { attachedDeposit: NEAR, gas: GAS });
  const config: any = await factory.view('get_config');
  assert.equal(config.vault_wasm_sha256, sha256(poolWasm));
  const creationDeposit = BigInt(config.creation_deposit);
  async function createVault(creator: NearAccount) {
    const salt = randomBytes(32).toString('hex');
    const address: string = await factory.view('predict_vault', { creator: creator.accountId, salt });
    assert.equal(address, predictVaultAccount(factory.accountId, creator.accountId, salt));
    const result = await creator.callRaw(factory, 'create_vault', { salt }, { attachedDeposit: creationDeposit, gas: GAS });
    assert.equal(result.parseResult(), true, result.summary());
    await finalized(result);
    const account = root.getAccount(address);
    assert.deepEqual((await account.viewAccessKeys(address)).keys, []);
    assert.equal(sha256(await account.viewCode()), sha256(poolWasm));
    assert.equal((await factory.view<any>('get_vault', { account_id: address })).state, 'Ready');
    return account;
  }
  const vaultA = await createVault(alice);
  console.log('First vault deployed without access keys:', vaultA.accountId);

  // Force an actual CreateAccount receipt failure using an already occupied child.
  const collisionSalt = randomBytes(32).toString('hex');
  const occupied: string = await factory.view('predict_vault', { creator: alice.accountId, salt: collisionSalt });
  await factory.createSubAccount(occupied.split('.')[0], { initialBalance: NEAR });
  const failed = await alice.callRaw(factory, 'create_vault', { salt: collisionSalt }, { attachedDeposit: creationDeposit, gas: GAS });
  assert.equal(failed.parseResult(), false);
  await finalized(failed);
  assert.equal((await factory.view<any>('get_vault', { account_id: occupied })).state, 'Failed');
  assert.equal((await factory.view<any>('get_refund', { creator: alice.accountId })).available, config.vault_funding);
  await assert.rejects(bob.call(factory, 'claim_refund', {}, { attachedDeposit: 1n, gas: GAS }));
  const refund = await alice.callRaw(factory, 'claim_refund', {}, { attachedDeposit: 1n, gas: GAS });
  assert.equal(refund.parseResult(), true, refund.summary());
  await finalized(refund);
  assert.deepEqual(await factory.view('get_refund', { creator: alice.accountId }), { available: '0', in_flight: '0' });
  assert.equal((await factory.view<any>('get_config')).refund_liability, '0');
  console.log('Failed creation refunded to its creator; unrelated refund claim rejected.');

  // Only the disposable local-sandbox factory key is removed automatically.
  const factoryKey = await factory.getKey();
  assert.ok(factoryKey);
  const locked = await factory.batch(factory).deleteKey(factoryKey.getPublicKey()).transact();
  await finalized(locked);
  assert.deepEqual((await factory.viewAccessKeys(factory.accountId)).keys, []);
  const vaultB = await createVault(bob);
  console.log('Permissionless creation still works after removing the factory key.');

  const policy: FactoryPolicy = {
    network: 'sandbox', factory: factory.accountId, denomination: NEAR.toString(), feeRecipient: treasury.accountId,
    factoryWasmSha256: sha256(factoryWasm), vaultWasmSha256: sha256(poolWasm), verifierSha256: sha256(Buffer.from(vk, 'base64')),
  };
  const catalog = await discoverVaults(new NearRpcFactorySource('sandbox', factory.accountId, rpcUrl), policy);
  assert.equal(catalog.vaults.length, 2); // Failed occupied child is excluded.
  assert.equal(catalog.checkedRecords, 3);
  const beforePrincipal = (await factory.balance()).total.toString();
  const pairs = [[vaultA, alice], [vaultB, bob]] as const;
  const settlements = [];
  for (const [vault, creator] of pairs) {
    const pool: Pool = { network: 'sandbox', contract: vault.accountId, denomination: NEAR.toString() };
    const note = await createNote(pool);
    const receiptValues = { sender: 'sandbox business', recipient: 'sandbox recipient', asset: 'NEAR', amount: NEAR.toString(), purpose: 'distributed vault demo', reference: randomBytes(16).toString('hex'), occurredAt: new Date().toISOString(), credentialHash: '' };
    const depositReceipt = createReceipt(receiptValues), payoutReceipt = createReceipt(receiptValues);
    const deposit = await creator.callRaw(vault, 'deposit', { commitment: note.commitment, disclosure_root: depositReceipt.root }, { attachedDeposit: BigInt(fees.depositAttached), gas: GAS });
    assert.ok(deposit.succeeded, deposit.summary());
    await finalized(deposit);
    settlements.push({ pool, vault, note, deposit, depositReceipt, payoutReceipt });
  }
  assert.equal((await factory.balance()).total.toString(), beforePrincipal);
  assert.equal((await vaultA.view<any>('get_config')).outstanding_notes, 1);
  assert.equal((await vaultB.view<any>('get_config')).outstanding_notes, 1);
  console.log('Principal deposited directly into two independent vaults; factory balance unchanged.');

  const bundles: SettlementBundle[] = [];
  for (const [index, settlement] of settlements.entries()) {
    const { pool, vault, note, deposit, depositReceipt, payoutReceipt } = settlement;
    const receiver = createFreshRecipient('local-only-factory-demo-recipient');
    const tree = await NoteTree.from(await vault.view<string[]>('get_commitments', { from_index: 0, limit: 256 }));
    const proof = await proveSpend(pool, note, tree, { kind: 'withdraw', target: receiver.accountId, disclosureRoot: payoutReceipt.root });
    const args = { recipient: receiver.accountId, disclosure_root: payoutReceipt.root, ...proof.args };
    if (index === 0) {
      await assert.rejects(relay.call(vaultB, 'withdraw', args, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS }));
      assert.equal(await vaultB.view('is_spent', { nullifier: proof.publicSignals[0] }), false);
    }
    const withdrawal = await relay.callRaw(vault, 'withdraw', args, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS });
    assert.equal(withdrawal.parseResult(), true, withdrawal.summary());
    await finalized(withdrawal);
    assert.equal((await root.getAccount(receiver.accountId).balance()).total.toString(), NEAR.toString());
    assert.equal((await vault.view<any>('get_config')).outstanding_notes, 0);
    if (index === 0) assert.equal((await vaultB.view<any>('get_config')).outstanding_notes, 1);
    const ref = (tx: TransactionResult, recordIndex: number) => ({ hash: tx.transactionReceipt.hash, signer: tx.transactionReceipt.signer_id, recordIndex });
    const bundle: SettlementBundle = { version: 1, network: 'sandbox', contract: pool.contract, scope: 'selected_transactions', transactions: [
      { tx: ref(deposit, 0), disclosure: disclose(depositReceipt, ['asset', 'amount', 'reference']) },
      { tx: ref(withdrawal, 1), disclosure: disclose(payoutReceipt, ['asset', 'amount', 'reference']) },
      { tx: ref(withdrawal, 2), disclosure: disclose(payoutReceipt, ['asset', 'amount', 'reference']) },
    ] };
    assert.ok((await verifyBundle(bundle, new NearRpcEvidenceSource('sandbox', pool.contract, rpcUrl))).valid);
    assert.equal((await vault.view<any>('get_config')).accrued_protocol_fees, (2n * BigInt(fees.depositProtocolFee)).toString());
    bundles.push(bundle);
  }
  console.log('Both keyless vaults paid fresh recipients; cross-vault proof replay rejected.');
  const treasuryBefore = BigInt((await treasury.balance()).total.toString());
  for (const [vault] of pairs) {
    const collected = await relay.callRaw(vault, 'collect_protocol_fees', {}, { attachedDeposit: 1n, gas: GAS });
    assert.equal(collected.parseResult(), true, collected.summary());
    await finalized(collected);
    assert.equal((await vault.view<any>('get_config')).accrued_protocol_fees, '0');
  }
  assert.equal(BigInt((await treasury.balance()).total.toString()) - treasuryBefore, 4n * BigInt(fees.depositProtocolFee));
  console.log('Deposit and withdrawal add-on fees collected without reducing either payout.');
  await mkdir('demo-output', { recursive: true });
  await writeFile('demo-output/factory-validation.json', JSON.stringify({ policy, catalog, factoryKeys: [], failedCreationRefunded: true, factoryPrincipalUnchanged: true, crossVaultReplayRejected: true, bundles }, null, 2));
  console.log('Factory demo verified; report: demo-output/factory-validation.json');
} finally {
  await worker.tearDown();
  await shutdownProver();
}
