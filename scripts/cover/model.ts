import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { SharedPolicySchema } from '../../sdk/shared.js';
import { AccountId, Atomic } from '../../sdk/validation.js';
import { canonical } from '../../sdk/client/crypto.js';
import { sha256, quoteFees, STORAGE_FEE, contextHash, domain, field, type Note } from '../../sdk/core.js';
import type { ContractCall } from '../../sdk/ft.js';
export const CoverConfig = z.object({ format: z.literal('core-cover-experiment-v1'), id: z.string().uuid(), policy: SharedPolicySchema, signer: AccountId, vault: AccountId, minIntervalSeconds: z.number().int().min(60).max(86400), maxTransactions: z.number().int().min(1).max(10), transferCount: z.number().int().min(0).max(8), maxBudgetYoctoNear: Atomic.refine(n => BigInt(n) > 0n && BigInt(n) <= 10n ** 24n), maxGasPriceYoctoNear: Atomic.refine(n => BigInt(n) > 0n && BigInt(n) <= 1000000000n), expiresAt: z.number().int().positive() }).strict().superRefine((c, ctx) => { if (c.policy.network !== 'testnet' || c.policy.tokenId || !c.signer.endsWith('.testnet') || !c.vault.endsWith('.' + c.policy.registry) || c.signer === c.policy.feeRecipient || c.signer === c.policy.registry || c.maxTransactions > c.transferCount + 2)
    ctx.addIssue({ code: 'custom', message: 'COVER_TESTNET_NATIVE_OWN_ACCOUNT_ONLY' }); });
export type CoverSettings = z.infer<typeof CoverConfig>;
export function newExperimentId() { return randomUUID(); }
export function coverRoot(c: CoverSettings, sequence: number) { return sha256(`core:declared-synthetic:v1|${c.id}|${sequence}`); }
export function coverPool(c: CoverSettings) { return { network: 'testnet' as const, contract: c.policy.registry, denomination: c.policy.denomination, version: 2 as const }; }
export function coverCycleReservation(c: CoverSettings) {
    const q = quoteFees(c.policy.denomination), gas = 300000000000000n * BigInt(c.maxGasPriceYoctoNear);
    return BigInt(q.depositAttached) + BigInt(q.withdrawalAttached) + BigInt(c.transferCount) * STORAGE_FEE + BigInt(c.transferCount + 2) * gas;
}
export function validateCoverCycle(c: CoverSettings) {
    if (c.maxTransactions < c.transferCount + 2)
        throw Error('COVER_INCOMPLETE_CYCLE_LIMIT');
    if (coverCycleReservation(c) > BigInt(c.maxBudgetYoctoNear))
        throw Error('COVER_BUDGET_LIMIT');
}
export function validateCoverCall(c: CoverSettings, notes: Note[], sequence: number, call: ContractCall) {
    CoverConfig.parse(c);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > c.transferCount + 1 || notes.length !== c.transferCount + 1)
        throw Error('COVER_SEQUENCE');
    const expectedRoot = coverRoot(c, sequence), q = quoteFees(c.policy.denomination), spend = z.object({ proof: z.string().length(344).refine(v => Buffer.from(v, 'base64').length === 256 && Buffer.from(v, 'base64').toString('base64') === v), public_inputs: z.array(z.string().refine(v => { try {
            return field(v).toString() === v;
        }
        catch {
            return false;
        } })).length(5) }).strict();
    let expected: ContractCall;
    if (sequence === 0)
        expected = { contract: c.vault, method: 'deposit', gas: '300000000000000', attachedYoctoNear: q.depositAttached, args: { commitment: notes[0].commitment, disclosure_root: expectedRoot } };
    else {
        const withdraw = sequence === c.transferCount + 1, a = call.args as any;
        const s = spend.parse({ proof: a.proof, public_inputs: a.public_inputs }), pool = coverPool(c), action = withdraw ? { kind: 'withdraw' as const, vault: c.vault, target: c.signer, disclosureRoot: expectedRoot } : { kind: 'transfer' as const, target: notes[sequence].commitment, disclosureRoot: expectedRoot };
        if (s.public_inputs[4] !== domain(pool) || s.public_inputs[3] !== contextHash(pool, action))
            throw Error('COVER_PROOF_BINDING');
        expected = { contract: c.policy.registry, method: withdraw ? 'withdraw' : 'transfer', gas: '300000000000000', attachedYoctoNear: withdraw ? q.withdrawalAttached : STORAGE_FEE.toString(), args: withdraw ? { vault: c.vault, recipient: c.signer, disclosure_root: expectedRoot, ...s } : { output_commitment: notes[sequence].commitment, disclosure_root: expectedRoot, ...s } };
    }
    if (canonical(expected) !== canonical(call))
        throw Error('COVER_CALL_CHANGED');
}
