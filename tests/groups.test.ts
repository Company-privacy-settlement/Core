import test from 'node:test';
import assert from 'node:assert/strict';
import { createNote, domain } from '../sdk/core.js';
import { ApprovedGroupsSchema, discoverApprovedGroups, chooseDepositGroup, approvedGroupForNote, groupPool, type ApprovedGroups } from '../sdk/groups.js';
import { discoverSharedVaultGroup, chooseSharedVault } from '../sdk/shared.js';
import { groupFixture, groupDirectory } from './fixtures/groups.js';

test('approved group directories reject duplicates, mixed asset families and unexpected policy fields', async () => {
  const a = groupFixture('old'), b = groupFixture('next'), { directory } = groupDirectory(a, b);
  const malformed: unknown[] = [
    { version: 1, groups: [] }, { ...directory, rpcUrl: 'http://untrusted' },
    { ...directory, groups: Array(9).fill(a.group) },
  ];
  for (const change of [
    (d: ApprovedGroups) => { d.groups[1].id = d.groups[0].id; },
    (d: ApprovedGroups) => { d.groups[1].policy.registry = d.groups[0].policy.registry; },
    (d: ApprovedGroups) => { d.groups[1].policy.tokenId = 'other.test.near'; },
    (d: ApprovedGroups) => { d.groups[1].policy.network = 'testnet'; },
    (d: ApprovedGroups) => { d.groups[1].policy.denomination = '2000000'; },
    (d: ApprovedGroups) => { d.groups[1].policy.registryWasmSha256 = 'bad'; },
  ]) { const d = structuredClone(directory); change(d); malformed.push(d); }
  for (const value of malformed) {
    assert.equal(ApprovedGroupsSchema.safeParse(value).success, false);
    let calls = 0;
    await assert.rejects(discoverApprovedGroups(() => { calls++; return a.source; }, value as ApprovedGroups));
    assert.equal(calls, 0);
  }
});

test('new deposits move past a full group at a shared final block for native and FT policies', async () => {
  for (const native of [false, true]) {
    const old = groupFixture('old', native), next = groupFixture('next', native);
    old.config.leaf_count = 256;
    const { directory, factory } = groupDirectory(old, next);
    const catalog = await discoverApprovedGroups(factory, directory), selected = chooseDepositGroup(catalog);
    assert.equal(catalog.groups[0].depositState, 'full'); assert.equal(catalog.groups[0].remainingOutputs, 0);
    assert.equal(selected.id, 'next'); assert.equal(selected.remainingOutputs, 254);
    assert.equal(chooseSharedVault(selected.catalog, 'deposit'), next.vault);
    assert.equal(old.finalizedReads(), 1); assert.equal(next.finalizedReads(), 0);
    assert.deepEqual(new Set([...old.blocks, ...next.blocks, ...old.reads.map(r => r.block), ...next.reads.map(r => r.block)]), new Set(['groups-final-block']));
    assert.notEqual(domain(catalog.groups[0].catalog.pool), domain(selected.catalog.pool));
  }
});

test('file priority is explicit and preferred full or disabled groups cannot accept deposits', async () => {
  const a = groupFixture('first'), b = groupFixture('second'), { directory, factory } = groupDirectory(a, b);
  let catalog = await discoverApprovedGroups(factory, directory);
  assert.equal(chooseDepositGroup(catalog).id, 'first'); assert.equal(chooseDepositGroup(catalog, 'second').id, 'second');
  a.group.depositsEnabled = false;
  catalog = await discoverApprovedGroups(factory, directory);
  assert.equal(catalog.groups[0].depositState, 'disabled'); assert.equal(chooseDepositGroup(catalog).id, 'second');
  assert.throws(() => chooseDepositGroup(catalog, 'first'), /does not currently accept/);
  assert.throws(() => chooseDepositGroup(catalog, 'unknown'), /does not currently accept/);
  b.config.leaf_count = 256; catalog = await discoverApprovedGroups(factory, directory);
  assert.throws(() => chooseDepositGroup(catalog), /No approved group/);
});

test('an eligible vault after a pending first record is discovered before declaring a group unavailable', async () => {
  const f = groupFixture('active'), second = { ...f.record, index: 1, account_id: `v${'c'.repeat(32)}.${f.policy.registry}` };
  f.record.state = 'Pending'; f.config.vault_count = 2;
  f.source.records = async (from, limit) => [f.record, second].slice(from, from + limit);
  const { directory, factory } = groupDirectory(f), catalog = await discoverApprovedGroups(factory, directory);
  assert.equal(catalog.groups[0].depositState, 'available');
  assert.equal(chooseSharedVault(catalog.groups[0].catalog, 'deposit'), second.account_id);
});

test('unactivated groups remain visible but cannot create a deposit selection', async () => {
  const f = groupFixture('pending'); f.record.state = 'Pending';
  const { directory, factory } = groupDirectory(f), catalog = await discoverApprovedGroups(factory, directory);
  assert.equal(catalog.groups[0].depositState, 'no_eligible_vault');
  assert.throws(() => chooseDepositGroup(catalog), /No approved group/);
});

test('partial scan budgets, unsafe deployments and inconsistent snapshots never silently select a fallback', async () => {
  const a = groupFixture('old'), b = groupFixture('next'), { directory, factory } = groupDirectory(a, b);
  a.config.vault_count = 2;
  const second = { ...a.record, index: 1, account_id: `v${'d'.repeat(32)}.${a.policy.registry}` };
  a.source.records = async (from, limit) => [a.record, second].slice(from, from + limit);
  await assert.rejects(discoverApprovedGroups(factory, directory, { maxRecordsPerGroup: 1 }), /scan budget exceeded/);
  a.config.vault_count = 1; a.source.accessKeys = async () => [{}];
  await assert.rejects(discoverApprovedGroups(factory, directory), /remaining keys/);
  a.source.accessKeys = async () => [];
  let reads = 0; a.source.config = async () => ({ ...a.config, root: ++reads === 1 ? a.config.root : '42' });
  await assert.rejects(discoverApprovedGroups(factory, directory), /snapshot changed/);
});

test('wrong source bindings are rejected before any group is queried', async () => {
  const a = groupFixture('old'), b = groupFixture('next'), { directory } = groupDirectory(a, b);
  await assert.rejects(discoverApprovedGroups(() => a.source, directory), /differs from approved policy/);
  assert.equal(a.finalizedReads(), 0); assert.equal(b.finalizedReads(), 0);
});

test('full and deposit-disabled groups retain note identity and selected-vault withdrawal verification', async () => {
  const old = groupFixture('old'), next = groupFixture('next'), { directory } = groupDirectory(old, next);
  old.group.depositsEnabled = false; old.config.leaf_count = 256; old.config.vault_count = 1001;
  const note = await createNote(groupPool(old.group)), found = await approvedGroupForNote(directory, note);
  assert.equal(found.group.id, 'old'); assert.equal(found.group.depositsEnabled, false);
  const catalog = await discoverSharedVaultGroup(old.source, found.group.policy, { vault: old.vault });
  assert.equal(chooseSharedVault(catalog, 'withdraw'), old.vault); assert.equal(catalog.vaults[0].canDeposit, false);
  assert.equal(catalog.checkedRecords, 1);
});

test('a note never changes group when capacity or deposit preferences change', async () => {
  const a = groupFixture('old'), b = groupFixture('next'), { directory, factory } = groupDirectory(a, b);
  const note = await createNote(groupPool(a.group)); a.config.leaf_count = 256;
  assert.equal(chooseDepositGroup(await discoverApprovedGroups(factory, directory)).id, 'next');
  assert.equal((await approvedGroupForNote(directory, note)).group.id, 'old');
  await assert.rejects(approvedGroupForNote(directory, { ...note, commitment: '42' }), /Invalid note/);
  const foreign = groupFixture('foreign');
  await assert.rejects(approvedGroupForNote(directory, await createNote(groupPool(foreign.group))), /outside the approved directory/);
});
