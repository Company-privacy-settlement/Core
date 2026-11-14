import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverConfig, coverRoot, validateCoverCall, coverPool, validateCoverCycle, coverCycleReservation } from '../scripts/cover/model.js';
import { CoverStore } from '../scripts/cover/store.js';
import { measureCoverEffect, coverSnapshot, coverBaseline } from '../scripts/cover/measurement.js';
import { createNote, quoteFees, contextHash, domain } from '../sdk/core.js';
import { indexFixture, blockHash } from './fixtures/indexer.js';
import type { ContractCall } from '../sdk/ft.js';
import { PrivacyObservations } from '../scripts/lib/privacy-baseline.js';
import { KeyPair, transactions, utils } from 'near-api-js';
import bs58 from 'bs58';
import { sha256 } from '../sdk/core.js';
import { canonical } from '../sdk/client/crypto.js';
import { CoverSigner } from '../scripts/cover/signer.js';
test('restart reconciliation preserves original argument bytes and rejects changed signed actions',async(t)=>{
 const {c}=fixture(),notes=await Promise.all(Array.from({length:3},()=>createNote(coverPool(c)))),pair=KeyPair.fromRandom('ed25519'),q=quoteFees(c.policy.denomination);
 const call:ContractCall={contract:c.vault,method:'deposit',gas:'300000000000000',attachedYoctoNear:q.depositAttached,args:{disclosure_root:coverRoot(c,0),commitment:notes[0].commitment}};
 const args=Buffer.from(JSON.stringify(call.args)),tx=transactions.createTransaction(c.signer,utils.PublicKey.fromString(pair.getPublicKey().toString()),c.vault,1n,[transactions.functionCall(call.method,args,BigInt(call.gas),BigInt(call.attachedYoctoNear))],bs58.decode(blockHash(1)));
 const bytes=Buffer.from(tx.encode()),hash=Buffer.from(sha256(bytes),'hex'),prepared={hash:bs58.encode(hash),unsignedTransaction:bytes.toString('base64')};
 const raw:any={final_execution_status:'FINAL',transaction:{hash:prepared.hash,signer_id:c.signer,receiver_id:c.vault,public_key:pair.getPublicKey().toString(),nonce:1,signature:'ed25519:'+bs58.encode(pair.sign(hash).signature),actions:[{FunctionCall:{method_name:call.method,args:args.toString('base64'),gas:call.gas,deposit:call.attachedYoctoNear}}]},status:{SuccessValue:''},transaction_outcome:{block_hash:blockHash(2),outcome:{status:{SuccessValue:''}}},receipts_outcome:[{outcome:{status:{SuccessValue:''}}}]};
 const signer=new CoverSigner(c,notes,pair,{transaction:async()=>raw} as any),persisted=JSON.parse(canonical(call));
 let clock=Date.now(),sent=0;
 const expiring=new CoverSigner({...c,expiresAt:clock+1},notes,pair,{read:async()=>{sent++;throw Error('unexpected dispatch');}} as any);
 expiring.fresh=async()=>{};expiring.chainTime=async()=>{const old=clock;clock+=2;return old;};
 const clockMock=t.mock.method(Date,'now',()=>clock);
 await assert.rejects(expiring.submit(0,prepared,call),/COVER_EXPIRED/);assert.equal(sent,0);clockMock.mock.restore();
 assert.notEqual(JSON.stringify(call.args),JSON.stringify(persisted.args));
 await assert.doesNotReject(signer.reconcile(0,prepared,persisted));
 raw.transaction.actions[0].FunctionCall.gas='1';await assert.rejects(signer.reconcile(0,prepared,persisted),/ACTION_CHANGED/);raw.transaction.actions[0].FunctionCall.gas=call.gas;
 const wrong=transactions.createTransaction('foreign.testnet',utils.PublicKey.fromString(pair.getPublicKey().toString()),c.vault,1n,tx.actions,bs58.decode(blockHash(1))),wrongBytes=Buffer.from(wrong.encode());
 await assert.rejects(signer.reconcile(0,{hash:bs58.encode(Buffer.from(sha256(wrongBytes),'hex')),unsignedTransaction:wrongBytes.toString('base64')},persisted),/INTENT_CHANGED/);
});
function fixture() { const f = indexFixture(true), now = 1800000000000, c = CoverConfig.parse({ format: 'core-cover-experiment-v1', id: '11111111-1111-4111-8111-111111111111', policy: { ...f.policy, network: 'testnet' }, signer: 'operator.testnet', vault: f.vault, minIntervalSeconds: 60, maxTransactions: 4, transferCount: 2, maxBudgetYoctoNear: '900000000000000000000000', maxGasPriceYoctoNear: '100000000', expiresAt: now + 3600000 }); return { f, c, now }; }
const call: ContractCall = { contract: 'forest.testnet', method: 'transfer', args: {}, attachedYoctoNear: '20000000000000000000000', gas: '300000000000000' };
test('full-cycle preflight refuses limits that would strand the experimental principal', () => {
    const { c: base } = fixture(), c = { ...base, policy: { ...base.policy, denomination: '100000000000000000000000' } };
    assert.doesNotThrow(() => validateCoverCycle(c));
    assert.throws(() => validateCoverCycle({ ...c, maxTransactions: 3 }), /INCOMPLETE_CYCLE/);
    const total = coverCycleReservation(c);
    assert.throws(() => validateCoverCycle({ ...c, maxBudgetYoctoNear: (total - 1n).toString() }), /BUDGET/);
    assert.doesNotThrow(() => validateCoverCycle({ ...c, maxBudgetYoctoNear: total.toString() }));
});
test('archival baseline uses the pre-transaction journal and excludes later cover receipts', async () => {
    const { c, f, now } = fixture(), s = new CoverStore(':memory:', c, 'public', now);
    const prior = f.record(0), synthetic = f.record(1, { block_height: 20, timestamp_ns: '20000000000', disclosure_root: coverRoot(c, 0) });
    const result = { ...f.transaction([synthetic]), transaction_outcome: { block_hash: blockHash(20) } };
    s.reserve(0, call, now);
    s.update(0, ['preparing'], { state: 'final', prepared: { hash: f.ref.hash, unsignedTransaction: '' }, result });
    const headers = Array.from({ length: 31 }, (_, height) => ({ height, hash: blockHash(height), timestamp_nanosec: String(BigInt(height) * 1000000000n) }));
    let shortPage = false, badTimestamp = false;
    const source: any = {
        finalBlock: async () => ({ height: 30, hash: blockHash(30) }),
        read: async (method: string, args: any) => { assert.equal(method, 'block'); const h = typeof args.block_id === 'number' ? headers[args.block_id] : headers.find(h => h.hash === args.block_id); assert.ok(h); return { header: { ...h, ...(badTimestamp && h.height === 20 ? { timestamp_nanosec: '1' } : {}) } }; },
        config: async (hash: string) => ({ record_count: hash === blockHash(19) ? 1 : 2 }),
        records: async () => { throw Error('Factory catalog is not the event journal'); },
        contractView: async (account: string, method: string, args: any, hash: string) => { assert.equal(account, c.policy.registry); assert.equal(method, 'get_records'); return (shortPage ? [] : hash === blockHash(19) ? [prior] : [prior, synthetic]).slice(args.from_index, args.from_index + args.limit); },
    };
    try {
        const before = await coverBaseline(c, source, s), after = await coverSnapshot(c, source, s);
        assert.equal(before.snapshot.height, 19);
        assert.equal(before.records.length, 1);
        assert.equal(before.records[0].traffic, 'unclassified');
        assert.equal(after.records[1].traffic, 'declared-synthetic');
        assert.equal(after.records[1].transaction!.hash, f.ref.hash);
        assert.equal(measureCoverEffect(before, after, c).artificialActivity.independentParticipantsAdded, 0);
        await assert.rejects(coverSnapshot(c, source, s, { height: 19, hash: blockHash(18) }), /CANONICAL/);
        shortPage = true;
        await assert.rejects(coverSnapshot(c, source, s), /INCOMPLETE/);
        shortPage = false;
        badTimestamp = true;
        await assert.rejects(coverSnapshot(c, source, s), /BLOCK_MISMATCH/);
    }
    finally {
        s.close();
    }
});
test('testnet-native-only configuration rejects mainnet, foreign recipient/network and unsafe bounds', () => { const { c } = fixture(); for (const change of [{ policy: { ...c.policy, network: 'mainnet' } }, { policy: { ...c.policy, network: 'sandbox' } }, { policy: { ...c.policy, tokenId: 'asset.testnet' } }, { minIntervalSeconds: 59 }, { maxTransactions: 11 }, { maxBudgetYoctoNear: '1000000000000000000000001' }, { signer: 'customer.near' }])
    assert.equal(CoverConfig.safeParse({ ...c, ...change }).success, false); });
test('conservative budget counts principal, attached storage and gas even when an intent is uncertain', () => { const { c, now } = fixture(), s = new CoverStore(':memory:', { ...c, maxBudgetYoctoNear: '49999999999999999999999' }, 'public', now); try {
    assert.throws(() => s.reserve(0, call, now), /BUDGET/);
    assert.equal(s.all().length, 0);
}
finally {
    s.close();
} });
test('durable rate limit is based on the latest final observation and cannot reset on restart', () => { const { c, now } = fixture(), dir = mkdtempSync(join(tmpdir(), 'cover-')), file = join(dir, 'journal.sqlite'); let s = new CoverStore(file, c, 'public', now); try {
    s.reserve(0, call, now);
    s.update(0, ['preparing'], { state: 'final', finalizedAt: now + 10000 });
    s.close();
    s = new CoverStore(file, c, 'public', now + 10000);
    assert.throws(() => s.reserve(1, call, now + 60000), /RATE/);
    s.reserve(1, call, now + 70000);
    assert.equal(s.all().length, 2);
}
finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('count, expiry, signer identity and budget changes fail closed', () => { const { c, now } = fixture(), dir = mkdtempSync(join(tmpdir(), 'cover-id-')), file = join(dir, 'journal.sqlite'), s = new CoverStore(file, { ...c, maxTransactions: 1 }, 'public', now); s.reserve(0, call, now); s.update(0, ['preparing'], { state: 'final' }); assert.throws(() => s.reserve(1, call, now + 60000), /COUNT/); s.close(); try {
    assert.throws(() => new CoverStore(file, c, 'public', now), /IDENTITY/);
    assert.throws(() => new CoverStore(file, { ...c, maxTransactions: 1 }, 'other', now), /IDENTITY/);
    const expired = new CoverStore(':memory:', c, 'public', now);
    assert.throws(() => expired.reserve(0, call, c.expiresAt), /EXPIRED/);
    expired.close();
}
finally {
    rmSync(dir, { recursive: true, force: true });
} });
test('unknown signing results block all new nonces and duplicate reservations do not dispatch twice', () => { const { c, now } = fixture(), s = new CoverStore(':memory:', c, 'public', now); try {
    const first = s.reserve(0, call, now);
    assert.equal(first.created, true);
    assert.equal(s.reserve(0, call, now).created, false);
    s.update(0, ['preparing'], { state: 'uncertain' });
    assert.throws(() => s.reserve(1, call, now + 60000), /RECONCILIATION/);
    assert.equal(s.all().length, 1);
}
finally {
    s.close();
} });
test('runtime mutation cannot raise the committed journal budget', () => { const { c, now } = fixture(), s = new CoverStore(':memory:', c, 'public', now); try {
    c.maxTransactions = 10;
    assert.equal(s.config.maxTransactions, 4);
    assert.throws(() => { (s.config as any).maxTransactions = 10; });
}
finally {
    s.close();
} });
test('the signer allowlist binds its own recipient, exact principal/fees and synthetic disclosure', async () => { const { c } = fixture(), notes = await Promise.all(Array.from({ length: 3 }, () => createNote(coverPool(c)))), q = quoteFees(c.policy.denomination), deposit = { contract: c.vault, method: 'deposit', gas: '300000000000000', attachedYoctoNear: q.depositAttached, args: { commitment: notes[0].commitment, disclosure_root: coverRoot(c, 0) } }; validateCoverCall(c, notes, 0, deposit); assert.throws(() => validateCoverCall(c, notes, 0, { ...deposit, attachedYoctoNear: '1' })); const root = coverRoot(c, 3), withdraw = { contract: c.policy.registry, method: 'withdraw', gas: '300000000000000', attachedYoctoNear: q.withdrawalAttached, args: { vault: c.vault, recipient: c.signer, disclosure_root: root, proof: Buffer.alloc(256).toString('base64'), public_inputs: ['1', '2', '3', contextHash(coverPool(c), { kind: 'withdraw', vault: c.vault, target: c.signer, disclosureRoot: root }), domain(coverPool(c))] } }; validateCoverCall(c, notes, 3, withdraw); assert.throws(() => validateCoverCall(c, notes, 3, { ...withdraw, args: { ...withdraw.args, recipient: 'attacker.testnet' } })); assert.throws(() => validateCoverCall(c, notes, 3, { ...withdraw, method: 'transfer' })); });
test('artificial output increases are separate from independent people and historical withdrawals', () => {
    const { c, f } = fixture(), record = (index: number, kind: string, seconds: number, synthetic = false) => ({ record: f.record(index, { kind, block_height: seconds, timestamp_ns: String(BigInt(seconds) * 1000000000n), commitment: ['deposit', 'transfer'].includes(kind) ? String(index + 7) : null, nullifier: kind === 'deposit' ? null : '55', vault: kind === 'transfer' ? null : f.vault, recipient: ['deposit', 'transfer'].includes(kind) ? null : c.signer, disclosure_root: synthetic ? coverRoot(c, kind === 'withdrawal_requested' ? 3 : kind === 'deposit' ? 0 : index) : 'ab'.repeat(32), protocol_fee_charged: ['deposit', 'withdrawal_requested'].includes(kind) ? (BigInt(c.policy.denomination) * 15n / 10000n).toString() : '0', protocol_fee_earned: kind === 'deposit' ? (BigInt(c.policy.denomination) * 15n / 10000n).toString() : '0', storage_fee_charged: '20000000000000000000000' }), transaction: { hash: 'B'.repeat(44), signer: synthetic ? c.signer : 'user.testnet' }, traffic: synthetic ? 'declared-synthetic' as const : 'unclassified' as const });
    const before = PrivacyObservations.parse({ format: 'core-privacy-observations-v1', policy: c.policy, snapshot: { height: 10, hash: 'B'.repeat(44) }, totalRecordCount: 1, records: [record(0, 'deposit', 1)] }), after = PrivacyObservations.parse({ ...before, snapshot: { height: 30, hash: 'C'.repeat(44) }, totalRecordCount: 3, records: [...before.records, record(1, 'deposit', 11, true), record(2, 'withdrawal_requested', 21, true)] });
    const r = measureCoverEffect(before, after, c);
    assert.equal(r.controlledProbes[0].includingSynthetic, 2);
    assert.equal(r.controlledProbes[0].excludingDeclaredSynthetic, 1);
    assert.equal(r.artificialActivity.independentParticipantsAdded, 0);
    assert.equal(r.excludingSynthetic.independentPeopleVerified, null);
    assert.equal(r.customerWithdrawalBenefitMeasured, false);
    assert.equal(r.effectiveAnonymityEstablished, false);
    const relabel = structuredClone(after);
    relabel.records[0].transaction = null;
    assert.throws(() => measureCoverEffect(before, relabel, c), /PREFIX/);
    const unknown = structuredClone(after);
    unknown.records[1].traffic = 'unclassified';
    assert.throws(() => measureCoverEffect(before, unknown, c), /CONCURRENT/);
    const impostor = structuredClone(after);
    impostor.records[1].transaction!.signer = 'foreign.testnet';
    assert.throws(() => measureCoverEffect(before, impostor, c), /LABEL/);
    const wrongKind = structuredClone(after);
    wrongKind.records[1].record.disclosure_root = coverRoot(c, 1);
    assert.throws(() => measureCoverEffect(before, wrongKind, c), /LABEL/);
});
