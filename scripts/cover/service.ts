import { discoverSharedVaults, loadSharedTree } from '../../sdk/shared.js';
import { proveSpend, quoteFees, STORAGE_FEE, validateNote, type Note } from '../../sdk/core.js';
import { RelayRpcSource } from '../../server/relay/signer.js';
import { coverPool, coverRoot, validateCoverCall, validateCoverCycle, type CoverSettings } from './model.js';
import { CoverStore } from './store.js';
import { CoverSigner } from './signer.js';
import type { ContractCall } from '../../sdk/ft.js';
export async function buildCoverCall(c: CoverSettings, notes: Note[], seq: number, source: RelayRpcSource, artifacts: string): Promise<ContractCall> {
    for (const note of notes)
        await validateNote(coverPool(c), note);
    const catalog = await discoverSharedVaults(source, c.policy);
    if (!catalog.vaults.some(v => v.accountId === c.vault && (seq === 0 ? v.canDeposit : v.canWithdraw)))
        throw Error('COVER_VAULT_UNAVAILABLE');
    const config: any = await source.config(catalog.blockHash);
    if (config.leaf_count + (seq === 0 ? notes.length : seq <= c.transferCount ? notes.length - seq : 0) > config.capacity)
        throw Error('COVER_CAPACITY_LIMIT');
    const q = quoteFees(c.policy.denomination), root = coverRoot(c, seq);
    if (seq === 0)
        return { contract: c.vault, method: 'deposit', args: { commitment: notes[0].commitment, disclosure_root: root }, attachedYoctoNear: q.depositAttached, gas: '300000000000000' };
    const tree = await loadSharedTree(source, catalog), withdraw = seq === c.transferCount + 1, action = withdraw ? { kind: 'withdraw' as const, vault: c.vault, target: c.signer, disclosureRoot: root } : { kind: 'transfer' as const, target: notes[seq].commitment, disclosureRoot: root };
    const proof = await proveSpend(coverPool(c), notes[seq - 1], tree, action, artifacts);
    return { contract: c.policy.registry, method: withdraw ? 'withdraw' : 'transfer', args: withdraw ? { vault: c.vault, recipient: c.signer, disclosure_root: root, ...proof.args } : { output_commitment: notes[seq].commitment, disclosure_root: root, ...proof.args }, attachedYoctoNear: withdraw ? q.withdrawalAttached : STORAGE_FEE.toString(), gas: '300000000000000' };
}
async function checkEffect(signer: CoverSigner, sequence: number, call: ContractCall) {
    const c = signer.config, block = await signer.source.finalBlock(), args = call.args as any;
    if (sequence === 0) {
        const d: any = await signer.source.contractView(c.vault, 'get_deposit', { commitment: args.commitment }, block.hash);
        if (d?.state !== 'Active' || d.owner !== c.signer || d.disclosure_root !== args.disclosure_root)
            throw Error('COVER_DEPOSIT_NOT_ACTIVE');
    }
    else if (sequence === c.transferCount + 1) {
        const r: any = await signer.source.contractView(c.policy.registry, 'get_withdrawal', { nullifier: args.public_inputs[0] }, block.hash);
        if (r?.state !== 'Complete' || r.recipient !== c.signer || r.vault !== c.vault || r.disclosure_root !== args.disclosure_root)
            throw Error('COVER_PAYOUT_NOT_COMPLETE');
    }
    else {
        if (await signer.source.contractView(c.policy.registry, 'is_spent', { nullifier: args.public_inputs[0] }, block.hash) !== true)
            throw Error('COVER_TRANSFER_NOT_COMPLETE');
        const leaves = await signer.source.commitments(block.hash);
        if (!Array.isArray(leaves) || !leaves.includes(args.output_commitment))
            throw Error('COVER_OUTPUT_NOT_REGISTERED');
    }
}
export async function coverStep(store: CoverStore, signer: CoverSigner, notes: Note[], artifacts: string) {
    const c = store.config, old = store.all();
    if (old.some(e => e.state !== 'final'))
        throw Error('COVER_RECONCILIATION_REQUIRED');
    const seq = old.length;
    if (seq >= c.transferCount + 2)
        return { state: 'complete', transactions: old.length };
    if (seq === 0)
        validateCoverCycle(c);
    if (seq >= c.maxTransactions)
        throw Error('COVER_COUNT_LIMIT');
    if (Date.now() >= c.expiresAt)
        throw Error('COVER_EXPIRED');
    await signer.fresh();
    const now = await signer.chainTime(), last = old.at(-1);
    if (last && now < Math.max(last.startedAt, last.finalizedAt ?? last.startedAt) + c.minIntervalSeconds * 1000)
        throw Error('COVER_RATE_LIMIT');
    const call = await buildCoverCall(c, notes, seq, signer.source, artifacts);
    validateCoverCall(c, notes, seq, call);
    const started = store.reserve(seq, call, await signer.chainTime());
    if (!started.created)
        return { state: 'existing', sequence: seq };
    try {
        const prepared = await signer.prepare(seq, call);
        store.update(seq, ['preparing'], { state: 'intent', prepared });
        store.update(seq, ['intent'], { state: 'submitted' });
        const result = await signer.submit(seq, prepared, call);
        await checkEffect(signer, seq, call);
        store.update(seq, ['submitted'], { state: 'final', result, finalizedAt: await signer.chainTime() });
        return { state: 'final', sequence: seq, hash: prepared.hash };
    }
    catch (e) {
        store.update(seq, ['preparing', 'intent', 'submitted'], { state: 'uncertain' });
        throw Error('COVER_RECONCILIATION_REQUIRED');
    }
}
export async function reconcileCover(store: CoverStore, signer: CoverSigner) { for (const e of store.all()) {
    if (e.state === 'final')
        continue;
    if (!e.prepared)
        throw Error('COVER_PREPARATION_OPERATOR_REVIEW');
    const result = await signer.reconcile(e.sequence, e.prepared, e.call);
    await checkEffect(signer, e.sequence, e.call);
    store.update(e.sequence, ['intent', 'submitted', 'uncertain'], { state: 'final', result, finalizedAt: await signer.chainTime() });
} return { state: 'reconciled', transactions: store.all().length }; }
