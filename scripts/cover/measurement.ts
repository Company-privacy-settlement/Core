import { canonical } from '../../sdk/client/crypto.js';
import { recordFingerprint } from '../../sdk/evidence.js';
import { sharedRecord } from '../../sdk/indexer/types.js';
import { PrivacyObservations, measurePrivacy, type PrivacyDataset } from '../lib/privacy-baseline.js';
import { coverRoot, type CoverSettings } from './model.js';
import type { CoverStore } from './store.js';
import type { RelayRpcSource } from '../../server/relay/signer.js';
export async function coverBaseline(c: CoverSettings, source: RelayRpcSource, store: CoverStore) {
    const first = store.all()[0];
    if (!first)
        return coverSnapshot(c, source, store);
    if (first.state !== 'final')
        throw Error('COVER_BASELINE_REQUIRES_FINAL');
    // Recover the canonical pre-transaction state if collection was interrupted.
    // This is an archival reconstruction, never a claim of an earlier live capture.
    const txBlock = await source.read('block', { block_id: first.result.transaction_outcome.block_hash });
    if (!Number.isSafeInteger(txBlock.header.height) || txBlock.header.height < 1)
        throw Error('COVER_BASELINE_BLOCK');
    const prior = await source.read('block', { block_id: txBlock.header.height - 1 });
    return coverSnapshot(c, source, store, { height: prior.header.height, hash: prior.header.hash });
}
export async function coverSnapshot(c: CoverSettings, source: RelayRpcSource, store: CoverStore, target?: PrivacyDataset['snapshot']) {
    const head = await source.finalBlock(), snapshot = target ?? head, block = await source.read('block', { block_id: snapshot.height });
    if (snapshot.height > head.height || block.header.hash !== snapshot.hash)
        throw Error('COVER_SNAPSHOT_NOT_CANONICAL_FINAL');
    const cfg: any = await source.config(snapshot.hash);
    if (!Number.isSafeInteger(cfg.record_count) || cfg.record_count < 0 || cfg.record_count > 8192)
        throw Error('COVER_JOURNAL_BOUND');
    const attribution = new Map<number, {
        transaction: {
            hash: string;
            signer: string;
        };
        fingerprint: string;
    }>();
    for (const e of store.all().filter(e => e.state === 'final'))
        for (const r of e.result.receipts_outcome) {
            if (r.outcome.executor_id !== c.policy.registry)
                continue;
            for (const log of r.outcome.logs ?? []) {
                if (!log.startsWith('EVENT_JSON:'))
                    continue;
                const ev = JSON.parse(log.slice(11));
                if (ev.standard !== 'core_shared' || ev.version !== '2.0.0')
                    continue;
                for (const value of ev.data) {
                    const record = sharedRecord(value, undefined, c.policy.denomination);
                    if (record.disclosure_root !== coverRoot(c, e.sequence) || ev.event !== record.kind)
                        throw Error('COVER_LABEL_MISMATCH');
                    if (record.block_height > snapshot.height)
                        continue;
                    const block = await source.read('block', { block_id: r.block_hash }), canonicalBlock = await source.read('block', { block_id: block.header.height });
                    if (canonicalBlock.header.hash !== r.block_hash || block.header.timestamp_nanosec !== record.timestamp_ns || block.header.height !== record.block_height)
                        throw Error('COVER_RECEIPT_BLOCK_MISMATCH');
                    attribution.set(record.index, { transaction: { hash: e.prepared!.hash, signer: c.signer }, fingerprint: recordFingerprint(record) });
                }
            }
        }
    const records: PrivacyDataset['records'] = [];
    for (let from = 0; from < cfg.record_count; from += 50) {
        const count = Math.min(50, cfg.record_count - from), page = await source.contractView(c.policy.registry, 'get_records', { from_index: from, limit: count }, snapshot.hash);
        if (!Array.isArray(page) || page.length !== count)
            throw Error('COVER_JOURNAL_INCOMPLETE');
        for (const value of page) {
            const record = sharedRecord(value, undefined, c.policy.denomination), own = attribution.get(record.index);
            if (record.index !== records.length || (own && own.fingerprint !== recordFingerprint(record)))
                throw Error('COVER_JOURNAL_MISMATCH');
            records.push({ record, transaction: own?.transaction ?? null, traffic: own ? 'declared-synthetic' : 'unclassified' });
        }
    }
    if (records.filter(r => r.traffic === 'declared-synthetic').length !== attribution.size)
        throw Error('COVER_ATTRIBUTION_INCOMPLETE');
    return PrivacyObservations.parse({ format: 'core-privacy-observations-v1', policy: c.policy, snapshot, totalRecordCount: cfg.record_count, records, controllers: [{ account: c.signer, controller: 'cover-experiment-operator', basis: 'operator-declaration' }], fundingEdges: [], windowsSeconds: [60, 300, 3600, 86400] });
}
export function measureCoverEffect(before: PrivacyDataset, after: PrivacyDataset, c: CoverSettings) {
    before = PrivacyObservations.parse(before);
    after = PrivacyObservations.parse(after);
    if (canonical(before.policy) !== canonical(c.policy) || canonical(after.policy) !== canonical(c.policy) || canonical(before.windowsSeconds) !== canonical(after.windowsSeconds) || before.snapshot.height > after.snapshot.height || before.records.some((r, i) => canonical(r) !== canonical(after.records[i])))
        throw Error('COVER_COMPARISON_DOMAIN_OR_PREFIX');
    if (before.records.some(r => r.traffic === 'declared-synthetic'))
        throw Error('COVER_BASELINE_ALREADY_SYNTHETIC');
    const b = measurePrivacy(before), a = measurePrivacy(after), synthetic = after.records.filter(r => r.traffic === 'declared-synthetic');
    for (const r of synthetic) {
        const i = Array.from({ length: c.transferCount + 2 }, (_, i) => i).find(i => coverRoot(c, i) === r.record.disclosure_root);
        if (i === undefined || r.transaction?.signer !== c.signer || !(i === 0 ? r.record.kind === 'deposit' : i <= c.transferCount ? r.record.kind === 'transfer' : ['withdrawal_requested', 'withdrawal_succeeded'].includes(r.record.kind)))
            throw Error('COVER_SYNTHETIC_LABEL_INVALID');
    }
    if (after.records.slice(before.records.length).some(r => r.traffic !== 'declared-synthetic'))
        throw Error('COVER_UNCONTROLLED_CONCURRENT_TRAFFIC');
    const probeIndices = new Set(synthetic.filter(r => r.record.kind === 'withdrawal_requested').map(r => r.record.index));
    const probes = a.linkability.requests.filter(r => probeIndices.has(r.recordIndex)).map(r => ({ recordIndex: r.recordIndex, syntheticProbe: true, includingSynthetic: r.candidateOutputCount, excludingDeclaredSynthetic: r.excludingDeclaredSynthetic, artificialCandidateIncrease: r.candidateOutputCount - r.excludingDeclaredSynthetic, windows: r.windows }));
    const nonSynthetic = after.records.filter(r => r.traffic !== 'declared-synthetic'), knownControllers = new Set(nonSynthetic.filter(r => r.record.kind === 'deposit' && r.transaction).map(r => after.controllers.find(c => c.account === r.transaction!.signer)?.controller).filter(Boolean));
    return { format: 'core-cover-effect-v1', before: b, after: a, artificialActivity: { records: synthetic.length, outputs: synthetic.filter(r => ['deposit', 'transfer'].includes(r.record.kind)).length, depositSigners: [...new Set(synthetic.filter(r => r.record.kind === 'deposit').map(r => r.transaction!.signer))], operatorDeclaredControllers: 1, independentParticipantsAdded: 0 }, excludingSynthetic: { outputs: nonSynthetic.filter(r => ['deposit', 'transfer'].includes(r.record.kind)).length, observedDepositSigners: [...new Set(nonSynthetic.filter(r => r.record.kind === 'deposit' && r.transaction).map(r => r.transaction!.signer))], knownDeclaredControllers: knownControllers.size, unknownSignerRecords: nonSynthetic.filter(r => !r.transaction).length, independentPeopleVerified: null }, controlledProbes: probes, customerWithdrawalBenefitMeasured: false, effectiveAnonymityEstablished: false, interpretation: 'Synthetic probes measure mechanical candidate-count changes only. Labelled operator traffic is not independent participation. Missing attribution remains unknown; outputs appended after historical withdrawals do not improve those historical observations.' };
}
