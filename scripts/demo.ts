import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Worker, type TransactionResult } from 'near-workspaces';
import { createNote, domain, encodeVerificationKey, NoteTree, proveSpend, shutdownProver, quoteFees, STORAGE_FEE, type Pool } from '../sdk/core.js';
import { createReceipt, disclose } from '../sdk/disclosure.js';
import { NearRpcEvidenceSource, verifyBundle, type SettlementBundle } from '../sdk/evidence.js';
import { ensureSandbox } from './sandbox.js';
import { createFreshRecipient } from '../sdk/wallet.js';

const NEAR = 10n ** 24n, GAS = 300n * 10n ** 12n;
const wasm = 'artifacts/core_pool.wasm';
await readFile(wasm); // Fail before starting sandbox when build is missing.
const vk = JSON.parse(await readFile('artifacts/verification_key.json', 'utf8'));
await ensureSandbox();
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const poolAccount = await root.createSubAccount('pool', { initialBalance: 5n * NEAR });
  const sender = await root.createSubAccount('sender', { initialBalance: 10n * NEAR });
  const relay = await root.createSubAccount('relay', { initialBalance: 5n * NEAR });
  const freshReceiver = createFreshRecipient('local-sandbox-ephemeral-backup');
  const treasury = await root.createSubAccount('treasury', { initialBalance: NEAR });
  const fees = quoteFees(NEAR);
  const receiver = root.getAccount(freshReceiver.accountId); // Not created on-chain yet.
  await poolAccount.deploy(wasm);
  await poolAccount.call(poolAccount, 'new', { network: 'sandbox', denomination: NEAR.toString(), verification_key: encodeVerificationKey(vk), fee_recipient: treasury.accountId }, { attachedDeposit: NEAR, gas: GAS });
  const pool: Pool = { network: 'sandbox', contract: poolAccount.accountId, denomination: NEAR.toString() };
  const config: any = await poolAccount.view('get_config');
  assert.equal(config.domain, domain(pool));
  assert.equal(config.deposit_attached, fees.depositAttached);
  assert.equal(config.withdrawal_attached, fees.withdrawalAttached);
  assert.equal(config.withdrawal_received, NEAR.toString());
  console.log('Sandbox contract initialized:', pool.contract);

  // Receiver creates this request privately. Only commitment crosses to sender.
  const senderNote = await createNote(pool), receiverNote = await createNote(pool);
  const receiptValues = { sender: 'Example US enterprise', recipient: 'Example Abu Dhabi enterprise', asset: 'NEAR', amount: NEAR.toString(), purpose: 'B2B settlement', reference: 'DEMO-001', occurredAt: new Date().toISOString(), credentialHash: '' };
  // Independently salted roots: reusing a root would publicly link these actions.
  const depositReceipt = createReceipt(receiptValues), transferReceipt = createReceipt(receiptValues), withdrawalReceipt = createReceipt(receiptValues);
  const deposit = await sender.callRaw(poolAccount, 'deposit', { commitment: senderNote.commitment, disclosure_root: depositReceipt.root }, { attachedDeposit: BigInt(fees.depositAttached), gas: GAS });
  assert.ok(deposit.succeeded, deposit.summary());
  // The earned deposit fee can be collected while the note principal stays reserved.
  const treasuryBefore = BigInt((await treasury.balance()).total.toString());
  const collection = await relay.callRaw(poolAccount, 'collect_protocol_fees', {}, { attachedDeposit: 1n, gas: GAS });
  assert.equal(collection.parseResult(), true, collection.summary());
  assert.equal(BigInt((await treasury.balance()).total.toString()) - treasuryBefore, BigInt(fees.depositProtocolFee));
  assert.equal((await poolAccount.view<any>('get_config')).outstanding_notes, 1);
  let tree = await NoteTree.from(await poolAccount.view<string[]>('get_commitments', { from_index: 0, limit: 256 }));
  assert.equal((await poolAccount.view<any>('get_config')).root, tree.root);
  console.log('Deposit confirmed; generating real transfer proof…');
  const transferProof = await proveSpend(pool, senderNote, tree, { kind: 'transfer', target: receiverNote.commitment, disclosureRoot: transferReceipt.root });
  await assert.rejects(relay.call(poolAccount, 'transfer', { output_commitment: '42', disclosure_root: transferReceipt.root, ...transferProof.args }, { attachedDeposit: STORAGE_FEE, gas: GAS }));
  const transfer = await relay.callRaw(poolAccount, 'transfer', { output_commitment: receiverNote.commitment, disclosure_root: transferReceipt.root, ...transferProof.args }, { attachedDeposit: STORAGE_FEE, gas: GAS });
  assert.ok(transfer.succeeded, transfer.summary());
  assert.equal(await poolAccount.view('is_spent', { nullifier: transferProof.publicSignals[0] }), true);
  console.log('Private note transfer confirmed through independent relay.');
  tree = await NoteTree.from(await poolAccount.view<string[]>('get_commitments', { from_index: 0, limit: 256 }));
  assert.equal((await poolAccount.view<any>('get_config')).root, tree.root);
  const withdrawProof = await proveSpend(pool, receiverNote, tree, { kind: 'withdraw', target: receiver.accountId, disclosureRoot: withdrawalReceipt.root });
  assert.equal(await receiver.exists(), false);
  const withdrawal = await relay.callRaw(poolAccount, 'withdraw', { recipient: receiver.accountId, disclosure_root: withdrawalReceipt.root, ...withdrawProof.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS });
  assert.ok(withdrawal.succeeded, withdrawal.summary());
  assert.equal(await receiver.exists(), true);
  assert.equal(BigInt((await receiver.balance()).total.toString()), NEAR);
  assert.equal((await poolAccount.view<any>('get_payout', { nullifier: withdrawProof.publicSignals[0] })).state, 'Complete');
  assert.equal((await poolAccount.view<any>('get_config')).accrued_protocol_fees, fees.withdrawalProtocolFee);
  await assert.rejects(relay.call(poolAccount, 'withdraw', { recipient: receiver.accountId, disclosure_root: withdrawalReceipt.root, ...withdrawProof.args }, { attachedDeposit: BigInt(fees.withdrawalAttached), gas: GAS }));
  console.log('Withdrawal created a fresh implicit recipient and paid exactly 1 NEAR; replay rejected.');

  function ref(result: TransactionResult, recordIndex: number) {
    return { hash: result.transactionReceipt.hash, signer: result.transactionReceipt.signer_id, recordIndex };
  }
  const selected = (receipt: typeof depositReceipt) => disclose(receipt, ['asset', 'amount', 'reference']);
  const bundle: SettlementBundle = { version: 1, network: 'sandbox', contract: pool.contract, scope: 'selected_transactions', transactions: [
    { tx: ref(deposit, 0), disclosure: selected(depositReceipt) }, { tx: ref(transfer, 1), disclosure: selected(transferReceipt) },
    { tx: ref(withdrawal, 2), disclosure: selected(withdrawalReceipt) }, { tx: ref(withdrawal, 3), disclosure: selected(withdrawalReceipt) },
  ] };
  const rpcUrl = (worker.provider as any).connection.url;
  const verified = await verifyBundle(bundle, new NearRpcEvidenceSource('sandbox', pool.contract, rpcUrl));
  assert.equal(verified.feeSummary!.protocolFeesCharged, (2n * BigInt(fees.depositProtocolFee)).toString());
  assert.equal(verified.feeSummary!.protocolFeesEarned, (2n * BigInt(fees.depositProtocolFee)).toString());
  await mkdir('demo-output', { recursive: true });
  await writeFile('demo-output/bundle.json', JSON.stringify(bundle, null, 2));
  await writeFile('demo-output/verification.json', JSON.stringify(verified, null, 2));
  console.log('Finalized RPC evidence verified:', verified.records.length, 'records.');
  console.log('TX bundle saved to demo-output/bundle.json (local sandbox ends after demo).');
  console.log('Gas burnt (Tgas):', Object.fromEntries([['deposit', deposit], ['transfer', transfer], ['withdrawal', withdrawal]].map(([name, r]) => [name as string, Number((r as TransactionResult).gas_burnt) / 1e12])));
} finally {
  await worker.tearDown();
  await shutdownProver();
}
