import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNote, contextHash, domain, STORAGE_FEE, type Pool } from '../sdk/core.js';
import { buildFtDeposit, buildFtWithdrawal, buildFtRegistration, buildStoragePrepayment, parseUsdc, quoteFtFees, STORAGE_CREDIT_BOND, USDC } from '../sdk/ft.js';
import type { SharedCatalog } from '../sdk/shared.js';
import { chooseIndependentVault } from '../sdk/wallet.js';
import { verifyBundle, type ChainRecord, type SettlementBundle } from '../sdk/evidence.js';
const pool: Pool = { version: 3, network: 'sandbox', contract: 'forest.test.near', denomination: '1000000', tokenId: 'usdc.test.near' };
const vault = 'b.forest.test.near';
function catalog(): SharedCatalog { return { blockHash: 'final-block', pool, root: '1', leafCount: 2, outstandingNotes: 2, creationDeposit: '1', checkedRecords: 1, nextIndex: null,
  vaults: [{ accountId: vault, availableNotes: 1, reservedNotes: 0, canDeposit: true, canWithdraw: true }] }; }
test('USDC six-decimal arithmetic preserves full principal with 15 bps on top', () => {
  assert.equal(parseUsdc('1'), '1000000'); assert.equal(parseUsdc('123.456789'), '123456789');
  const q = quoteFtFees(parseUsdc('1')); assert.equal(q.depositTransferTokens, '1001500'); assert.equal(q.withdrawalFeeTransferTokens, '1500'); assert.equal(q.recipientTokens, '1000000');
  assert.equal(q.actionStorageYoctoNear, STORAGE_FEE.toString()); assert.equal(q.transferCallYoctoNear,'1');
  for (const bad of ['0','-1','1e3','1.0000001','01','NaN','0.000001']) assert.throws(() => parseUsdc(bad));
  assert.equal(USDC.testnet.length, 64); assert.equal(USDC.mainnet.length, 64);
});
test('FT domains separate native NEAR, other tokens, amounts and registries', () => {
  const base = domain(pool);
  for (const p of [{ ...pool, tokenId: 'fake.test.near' }, { ...pool, denomination: '10000000' }, { ...pool, contract: 'other.test.near' }, { version: 2 as const, network: pool.network, contract: pool.contract, denomination: pool.denomination }]) assert.notEqual(domain(p), base);
  assert.throws(() => domain({ ...pool, version: 2 } as unknown as Pool));
  assert.throws(() => chooseIndependentVault([pool,{...pool,contract:'other.test.near',tokenId:'fake.test.near'}]), /assets/);
  const action = { kind: 'withdraw' as const, vault, target: 'receiver.test.near', disclosureRoot: 'd4'.repeat(32) };
  assert.notEqual(contextHash(pool, action), contextHash(pool, { ...action, vault: 'a.forest.test.near' }));
});
test('FT call builders bind the verified vault, token, note and payout proof', async () => {
  const c = catalog(), note = await createNote(pool), receipt = 'd4'.repeat(32);
  const deposit = await buildFtDeposit(c,vault,note,receipt);
  assert.equal(deposit.tokenCall.contract,pool.tokenId); assert.equal(deposit.tokenCall.args.amount,'1001500'); assert.equal(deposit.storageTarget,vault);
  await assert.rejects(buildFtDeposit(c,'fake.test.near',note,receipt));
  const vector = JSON.parse(await readFile('test-vectors/shared-ft.json','utf8'));
  const withdrawal = buildFtWithdrawal(c,vault,vector.recipient,vector.disclosureRoot,vector.proofs.aFromB);
  assert.equal(withdrawal.tokenCall.args.amount,'1500'); assert.equal(withdrawal.storageTarget,pool.contract); assert.equal(withdrawal.completion.requiredState,'Complete');
  assert.throws(() => buildFtWithdrawal(c,vault,'attacker.test.near',vector.disclosureRoot,vector.proofs.aFromB));
});
test('NEAR prepayment separates first-use bond and existing balances; FT registration is explicit', () => {
  const first = buildStoragePrepayment(vault,'alice.test.near',null)!; assert.equal(first.attachedYoctoNear,(STORAGE_FEE + STORAGE_CREDIT_BOND).toString());
  assert.equal(buildStoragePrepayment(vault,'alice.test.near',{available:STORAGE_FEE.toString(),in_flight:'0'}), null);
  assert.equal(buildStoragePrepayment(vault,'alice.test.near',{available:'1',in_flight:'0'})!.attachedYoctoNear,(STORAGE_FEE-1n).toString());
  assert.equal(buildFtRegistration(pool.tokenId,'receiver.test.near','1250000000000000000000').method,'storage_deposit');
});
test('FT evidence anchors token identity and never labels token quantities as NEAR', async () => {
  const record: ChainRecord = { index: 0, kind: 'deposit', commitment: '42', nullifier: null, vault, recipient: null, disclosure_root: 'ab'.repeat(32), block_height: 4, timestamp_ns: '1', amount: '1000000', protocol_fee_charged: '1500', protocol_fee_earned: '1500', storage_fee_charged: STORAGE_FEE.toString(), asset_token_id: pool.tokenId };
  const tx = { hash:'test-hash', signer:'alice.test.near', recordIndex:0 };
  const bundle: SettlementBundle = { version:3, assetTokenId:pool.tokenId, network:'sandbox',contract:pool.contract,scope:'selected_transactions',transactions:[{tx}] };
  const source = { network: 'sandbox' as const, contract:pool.contract, getRecord:async()=>record, getTransaction:async()=>({ final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:tx.hash,signer_id:tx.signer},receipts_outcome:[{outcome:{executor_id:pool.contract,status:{SuccessValue:''},logs:[`EVENT_JSON:${JSON.stringify({standard:'core_shared',version:'3.0.0',event:'deposit',data:[{...record}]})}`]}}] }) };
  const result = await verifyBundle(bundle,source); assert.equal(result.feeSummary!.asset,'NEP-141'); assert.equal(result.feeSummary!.assetTokenId,pool.tokenId); assert.equal(result.feeSummary!.storageAsset,'NEAR');
  await assert.rejects(verifyBundle({...bundle,assetTokenId:'fake.test.near'},source),/asset/);
  await assert.rejects(verifyBundle({...bundle,version:2,assetTokenId:undefined},source),/asset/);
  const anchored = await source.getTransaction(); record.asset_token_id = 'fake.test.near'; await assert.rejects(verifyBundle({...bundle,assetTokenId:'fake.test.near'},{...source,getTransaction:async()=>anchored}),/anchor/);
});
