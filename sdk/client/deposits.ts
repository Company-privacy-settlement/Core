import { canonical } from './crypto.js';
import { account, object, scalar, parsePolicy, preparedPayment, GAS } from './payment.js';
import type { Policy, Call } from './types.js';

export type DepositRequest = { commitment: string; disclosureRoot: string; vault?: string };
export type DepositPlan = { policy: Policy; checkedAtBlock: { hash: string; height: number }; plan: { tokenCall: Call; checkedAtBlock: string }; remainingOutputs: number; checkedVaults: number; vaultScanComplete: boolean };
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Unexpected public deposit fields');
}
export function parseDepositRequest(raw: unknown): DepositRequest {
  const value = object(raw); exact(value, ['commitment', 'disclosureRoot', ...(value.vault === undefined ? [] : ['vault'])]);
  const commitment = scalar(value.commitment);
  if (commitment === '0' || typeof value.disclosureRoot !== 'string' || !/^[a-f0-9]{64}$/.test(value.disclosureRoot)) throw new Error('Invalid public deposit commitment or disclosure root');
  return { commitment, disclosureRoot: value.disclosureRoot, ...(value.vault === undefined ? {} : { vault: account(value.vault) }) };
}
export async function parseDepositPlan(raw: unknown, trusted: Policy, expected: DepositRequest): Promise<DepositPlan> {
  const value = object(raw), policy = parsePolicy(value.policy), request = parseDepositRequest(expected);
  exact(value, ['policy', 'checkedAtBlock', 'plan', 'remainingOutputs', 'checkedVaults', 'vaultScanComplete']);
  if (!policy.tokenId || canonical(policy) !== canonical(parsePolicy(trusted))) throw new Error('Deposit policy differs from the trusted group');
  const block = object(value.checkedAtBlock), plan = object(value.plan); exact(block, ['hash', 'height']); exact(plan, ['tokenCall', 'checkedAtBlock']);
  if (typeof block.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.hash) || typeof block.height !== 'number' || !Number.isSafeInteger(block.height) || block.height < 0 || plan.checkedAtBlock !== block.hash) throw new Error('Invalid deposit block');
  const { payment, reference } = await preparedPayment(plan, policy, 'inspection.testnet');
  if (reference.kind !== 'deposit' || reference.commitment !== request.commitment || reference.expectedDisclosureRoot !== request.disclosureRoot || (request.vault && reference.vault !== request.vault) || payment.gas !== GAS) throw new Error('Deposit call differs from the requested note and receipt');
  if (typeof value.remainingOutputs !== 'number' || !Number.isInteger(value.remainingOutputs) || value.remainingOutputs < 1 || value.remainingOutputs > 256 || typeof value.checkedVaults !== 'number' || !Number.isInteger(value.checkedVaults) || value.checkedVaults < 1 || value.checkedVaults > 20 || typeof value.vaultScanComplete !== 'boolean') throw new Error('Invalid deposit capacity snapshot');
  return { policy, checkedAtBlock: { hash: block.hash, height: block.height }, plan: { tokenCall: payment, checkedAtBlock: block.hash }, remainingOutputs: value.remainingOutputs, checkedVaults: value.checkedVaults, vaultScanComplete: value.vaultScanComplete };
}
