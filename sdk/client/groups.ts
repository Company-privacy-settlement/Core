import { canonical } from './crypto.js';
import { object, parsePolicy } from './payment.js';
import type { Policy } from './types.js';

export type ApprovedGroup = { id: string; depositsEnabled: boolean; policy: Policy };
export type ApprovedGroups = { version: 1; groups: ApprovedGroup[] };
export type GroupCapacity = {
  policy: Policy; checkedAtBlock: { hash: string; height: number }; capacity: 256;
  usedOutputs: number; remainingOutputs: number; outstandingNotes: number;
  depositCapacityAvailable: boolean; depositVaultObserved: boolean; checkedVaults: number;
  vaultScanComplete: boolean; chainFreshnessChecked: false;
};
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Unexpected group fields');
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid group count');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid group flag'); return value;
}
/** Approvals remain client-held; API origins and private-note fields are rejected. */
export function parseApprovedGroups(input: unknown): ApprovedGroups {
  const value = object(input); exact(value, ['version', 'groups']);
  if (value.version !== 1 || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 8) throw new Error('Use an approved directory with 1–8 groups');
  const ids = new Set<string>(), registries = new Set<string>();
  const groups = value.groups.map(raw => {
    const g = object(raw); exact(g, ['id', 'depositsEnabled', 'policy']);
    if (typeof g.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(g.id)) throw new Error('Invalid group ID');
    const policy = parsePolicy(g.policy);
    if (ids.has(g.id) || registries.has(policy.registry)) throw new Error('Duplicate group ID or registry');
    ids.add(g.id); registries.add(policy.registry);
    return { id: g.id, depositsEnabled: boolean(g.depositsEnabled), policy };
  });
  const first = groups[0].policy;
  if (groups.some(g => g.policy.network !== first.network || g.policy.tokenId !== first.tokenId || g.policy.denomination !== first.denomination))
    throw new Error('Approved groups must use the same network, asset and denomination');
  return { version: 1, groups };
}
export function parseGroupCapacity(input: unknown, trusted: Policy): GroupCapacity {
  const value = object(input), policy = parsePolicy(value.policy), expected = parsePolicy(trusted);
  exact(value, ['policy', 'checkedAtBlock', 'capacity', 'usedOutputs', 'remainingOutputs', 'outstandingNotes', 'depositCapacityAvailable', 'depositVaultObserved', 'checkedVaults', 'vaultScanComplete', 'chainFreshnessChecked']);
  if (canonical(policy) !== canonical(expected)) throw new Error('Group capacity policy differs from the trusted group');
  const block = object(value.checkedAtBlock); exact(block, ['hash', 'height']);
  if (typeof block.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.hash)) throw new Error('Invalid group block');
  const usedOutputs = count(value.usedOutputs), remainingOutputs = count(value.remainingOutputs), outstandingNotes = count(value.outstandingNotes), checkedVaults = count(value.checkedVaults);
  const depositCapacityAvailable = boolean(value.depositCapacityAvailable), depositVaultObserved = boolean(value.depositVaultObserved), vaultScanComplete = boolean(value.vaultScanComplete);
  if (value.capacity !== 256 || usedOutputs > 256 || remainingOutputs !== 256 - usedOutputs || outstandingNotes > usedOutputs || checkedVaults > 1 || depositCapacityAvailable !== (remainingOutputs > 0) || (depositVaultObserved && (!depositCapacityAvailable || checkedVaults === 0)) || value.chainFreshnessChecked !== false)
    throw new Error('Inconsistent group capacity snapshot');
  return { policy, checkedAtBlock: { hash: block.hash, height: count(block.height) }, capacity: 256, usedOutputs, remainingOutputs, outstandingNotes, depositCapacityAvailable, depositVaultObserved, checkedVaults, vaultScanComplete, chainFreshnessChecked: false };
}
