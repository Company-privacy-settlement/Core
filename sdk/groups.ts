import { z } from 'zod';
import { CAPACITY, domain, field, validateNote, type Note, type Pool } from './core.js';
import { SharedPolicySchema, discoverSharedVaults, discoverSharedVaultGroup, pinSharedSource, type SharedChainSource, type SharedPolicy, type SharedCatalog } from './shared.js';

const Group = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  depositsEnabled: z.boolean(),
  policy: SharedPolicySchema,
}).strict();
/** Approval comes from a caller-held file, never an API-supplied policy list. */
export const ApprovedGroupsSchema = z.object({ version: z.literal(1), groups: z.array(Group).min(1).max(8) }).strict().superRefine((value, ctx) => {
  const ids = new Set<string>(), registries = new Set<string>(), first = value.groups[0]?.policy;
  if (!first) return;
  for (const [i, group] of value.groups.entries()) {
    const p = group.policy;
    if (ids.has(group.id) || registries.has(p.registry)) ctx.addIssue({ code: 'custom', path: ['groups', i], message: 'Duplicate group ID or registry' });
    ids.add(group.id); registries.add(p.registry);
    if (p.network !== first.network || p.denomination !== first.denomination || p.tokenId !== first.tokenId)
      ctx.addIssue({ code: 'custom', path: ['groups', i, 'policy'], message: 'Approved groups must use the same network, asset and denomination' });
  }
});
export type ApprovedGroups = z.infer<typeof ApprovedGroupsSchema>;
export type ApprovedGroup = ApprovedGroups['groups'][number];
export type GroupSourceFactory = (policy: SharedPolicy) => SharedChainSource;
export function groupPool(group: ApprovedGroup): Pool {
  const p = group.policy;
  return p.tokenId ? { version: 3, tokenId: p.tokenId, network: p.network, contract: p.registry, denomination: p.denomination }
    : { version: 2, network: p.network, contract: p.registry, denomination: p.denomination };
}

const Scalar = z.string().max(77).refine(v => { try { return field(v).toString() === v; } catch { return false; } });
const NoteSchema = z.object({ version: z.literal(1), domain: Scalar, secret: Scalar, nullifier: Scalar, commitment: Scalar }).strict();
/** Domain lookup and integrity validation happen locally, before any chain query. */
export async function approvedGroupForNote(input: ApprovedGroups, raw: unknown): Promise<{ group: ApprovedGroup; note: Note }> {
  const directory = ApprovedGroupsSchema.parse(input), note = NoteSchema.parse(raw);
  const group = directory.groups.find(g => domain(groupPool(g)) === note.domain);
  if (!group) throw new Error('Note belongs to a group outside the approved directory; retain its original trusted policy');
  await validateNote(groupPool(group), note);
  return { group, note };
}

export type GroupStatus = {
  id: string; policy: SharedPolicy; depositsEnabled: boolean;
  depositState: 'available' | 'full' | 'disabled' | 'no_eligible_vault';
  capacity: number; remainingOutputs: number; catalog: SharedCatalog;
};
export type ApprovedGroupCatalog = { version: 1; blockHash: string; groups: GroupStatus[] };
const fingerprint = (c: SharedCatalog) => JSON.stringify([c.pool, c.root, c.leafCount, c.outstandingNotes, c.creationDeposit, c.vaultCount]);

export async function discoverApprovedGroups(factory: GroupSourceFactory, input: ApprovedGroups, options: { maxRecordsPerGroup?: number } = {}): Promise<ApprovedGroupCatalog> {
  const directory = ApprovedGroupsSchema.parse(input);
  const max = z.number().int().min(1).max(1000).parse(options.maxRecordsPerGroup ?? 1000);
  // Validate every source binding before the first RPC read.
  const sources = directory.groups.map(g => {
    const source = factory(g.policy);
    if (source.network !== g.policy.network || source.factory !== g.policy.registry) throw new Error('Group source differs from approved policy');
    return source;
  });
  const blockHash = z.string().min(1).parse(await sources[0].finalizedBlock()), groups: GroupStatus[] = [];
  for (const [i, group] of directory.groups.entries()) {
    const source = pinSharedSource(sources[i], blockHash);
    let catalog = await discoverSharedVaults(source, group.policy, { maxRecords: 1 });
    const remainingOutputs = CAPACITY - catalog.leafCount;
    let depositState: GroupStatus['depositState'] = !group.depositsEnabled ? 'disabled' : remainingOutputs === 0 ? 'full' : 'no_eligible_vault';
    if (group.depositsEnabled && remainingOutputs > 0) {
      const complete = await discoverSharedVaultGroup(source, group.policy, { maxRecords: max });
      if (fingerprint(catalog) !== fingerprint(complete)) throw new Error('Approved group snapshot changed during discovery');
      catalog = complete;
      if (catalog.vaults.some(v => v.canDeposit)) depositState = 'available';
    }
    groups.push({ id: group.id, policy: group.policy, depositsEnabled: group.depositsEnabled, depositState, capacity: CAPACITY, remainingOutputs, catalog });
  }
  return { version: 1, blockHash, groups };
}

/** File order is the operator's explicit priority. No deployment or fund movement. */
export function chooseDepositGroup(catalog: ApprovedGroupCatalog, preferredId?: string): GroupStatus {
  const selected = preferredId === undefined ? catalog.groups.find(g => g.depositState === 'available') : catalog.groups.find(g => g.id === preferredId);
  if (!selected || selected.depositState !== 'available' || !selected.depositsEnabled || selected.remainingOutputs < 1 || !selected.catalog.vaults.some(v => v.canDeposit))
    throw new Error(preferredId === undefined ? 'No approved group currently accepts deposits' : 'Selected approved group does not currently accept deposits');
  return selected;
}
