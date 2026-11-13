import { domain } from '../../sdk/core.js';
import { predictSharedVault, type SharedChainSource } from '../../sdk/shared.js';
import type { ApprovedGroup, ApprovedGroups } from '../../sdk/groups.js';
import { operationsFixture } from './operations.js';

export function groupFixture(id: string, native = false) {
  const f = operationsFixture(native), registry = `${id}.test.near`;
  f.policy.registry = registry; f.pool.contract = registry;
  f.config.domain = domain(f.pool); f.local.registry = registry;
  const vault = predictSharedVault(registry, f.payer, 'ab'.repeat(32)); f.record.account_id = vault;
  const blocks: string[] = []; let finalizedReads = 0;
  const source: SharedChainSource = {
    ...f.source, factory: registry,
    finalizedBlock: async () => { finalizedReads++; return 'groups-final-block'; },
    config: async block => { blocks.push(block); return f.source.config(block); },
    records: async (from, limit, block) => { blocks.push(block); return from === 0 && limit === 1 ? [f.record] : []; },
    vaultRecord: async (account, block) => { blocks.push(block); return account === vault ? f.record : null; },
  };
  const group: ApprovedGroup = { id, depositsEnabled: true, policy: f.policy };
  return { ...f, vault, group, source, blocks, finalizedReads: () => finalizedReads };
}
export function groupDirectory(...fixtures: ReturnType<typeof groupFixture>[]) {
  const directory: ApprovedGroups = { version: 1, groups: fixtures.map(f => f.group) };
  const factory = (p: ApprovedGroup['policy']) => {
    const f = fixtures.find(f => f.policy.registry === p.registry);
    if (!f) throw new Error('Unapproved source'); return f.source;
  };
  return { directory, factory };
}
