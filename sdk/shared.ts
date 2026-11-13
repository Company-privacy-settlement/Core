import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { domain, sha256, quoteFees, NoteTree, STORAGE_FEE, type Pool } from './core.js';
import { AccountId, Atomic } from './validation.js';
import { NearRpcFactorySource, type FactoryChainSource } from './factory.js';

const Amount = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RegistryConfig = z.object({
  protocol: z.enum(['core-shared-registry-v2', 'core-shared-ft-registry-v3']), network: z.enum(['sandbox', 'testnet']), denomination: Amount, asset_token_id: z.string().nullable().optional(), deposit_token_amount: Amount.nullable().optional(), withdrawal_token_fee: Amount.nullable().optional(), storage_credit_bond: Amount.optional(),
  fee_recipient: z.string(), deposit_fee_bps: z.literal(15), withdrawal_fee_bps: z.literal(15),
  deposit_attached: Amount, withdrawal_attached: Amount, withdrawal_received: Amount, storage_fee: Amount,
  vault_wasm_sha256: Hash, verifier_sha256: Hash, vault_count: Count, creation_deposit: Amount,
  vault_funding: Amount, registration_fee: Amount, domain: Amount, root: Amount, leaf_count: Count, capacity: z.literal(256), outstanding_notes: Count,
});
const VaultRecord = z.object({ index: Count, account_id: z.string(), state: z.enum(['Pending', 'Ready', 'Failed']), available_notes: Count, reserved_notes: Count });
const VaultConfig = z.object({
  protocol: z.enum(['core-shared-vault-v2', 'core-shared-ft-vault-v3']), registry: z.string(), network: z.enum(['sandbox', 'testnet']), denomination: Amount, asset_token_id: z.string().nullable().optional(), deposit_token_amount: Amount.nullable().optional(), withdrawal_token_fee: Amount.nullable().optional(), storage_credit_bond: Amount.optional(),
  fee_recipient: z.string(), deposit_fee_bps: z.literal(15), withdrawal_fee_bps: z.literal(15), storage_fee: Amount,
  deposit_attached: Amount, withdrawal_received: Amount, available_notes: Count, reserved_notes: Count, pending_deposits: Count, held_notes: Count,
});
export const SharedPolicySchema = z.object({ network: z.enum(['sandbox', 'testnet']), registry: AccountId.max(30), denomination: Atomic.refine(v => BigInt(v) > 0n), feeRecipient: AccountId, registryWasmSha256: Hash, vaultWasmSha256: Hash, verifierSha256: Hash, tokenId: AccountId.optional() }).strict();
export type SharedPolicy = z.infer<typeof SharedPolicySchema>;
export interface SharedChainSource extends FactoryChainSource { commitments(block: string): Promise<unknown>; vaultRecord?(account: string, block: string): Promise<unknown>; }
export class NearRpcSharedSource extends NearRpcFactorySource implements SharedChainSource {
  commitments(block: string): Promise<unknown> { return this.view(this.factory, 'get_commitments', { from_index: 0, limit: 256 }, block); }
  vaultRecord(account: string, block: string): Promise<unknown> { return this.view(this.factory, 'get_vault', { account_id: account }, block); }
}
export function predictSharedVault(registry: string, creator: string, salt: string): string {
  domain({ network: 'testnet', contract: registry, denomination: '1' });
  domain({ network: 'testnet', contract: creator, denomination: '1' });
  if (registry.length > 30 || !/^[a-f0-9]{64}$/.test(salt)) throw new Error('Invalid registry length or salt');
  return `v${sha256(`core:shared-vault:v2|${creator}|${salt}`).slice(0, 32)}.${registry}`;
}

export async function discoverSharedVaults(source: SharedChainSource, policy: SharedPolicy, options: { fromIndex?: number; maxRecords?: number; vault?: string } = {}) {
  policy = SharedPolicySchema.parse(policy);
  if (source.network !== policy.network || source.factory !== policy.registry) throw new Error('Wrong shared registry');
  [policy.registryWasmSha256, policy.vaultWasmSha256, policy.verifierSha256].forEach(h => Hash.parse(h));
  domain({ network: policy.network, contract: policy.feeRecipient, denomination: '1' });
  const quote = quoteFees(policy.denomination);
  if (policy.tokenId) domain({ network: policy.network, contract: policy.registry, denomination: policy.denomination, version: 3, tokenId: policy.tokenId });
  const blockHash = await source.finalizedBlock();
  const [code, keys, raw] = await Promise.all([source.codeSha256(policy.registry, blockHash), source.accessKeys(policy.registry, blockHash), source.config(blockHash)]);
  if (code !== policy.registryWasmSha256 || keys.length !== 0) throw new Error('Registry code mismatch or remaining keys');
  const config = RegistryConfig.parse(raw);
  const pool: Pool = policy.tokenId ? { version: 3, tokenId: policy.tokenId, network: policy.network, contract: policy.registry, denomination: policy.denomination } : { version: 2, network: policy.network, contract: policy.registry, denomination: policy.denomination };
  if (config.protocol !== (policy.tokenId ? 'core-shared-ft-registry-v3' : 'core-shared-registry-v2') || (config.asset_token_id ?? undefined) !== policy.tokenId) throw new Error('Registry asset mismatch');
  if (config.network !== policy.network || config.denomination !== policy.denomination || config.fee_recipient !== policy.feeRecipient || config.vault_wasm_sha256 !== policy.vaultWasmSha256 || config.verifier_sha256 !== policy.verifierSha256 || config.domain !== domain(pool)) throw new Error('Shared group configuration mismatch');
  if (config.deposit_attached !== (policy.tokenId ? STORAGE_FEE.toString() : quote.depositAttached) || config.withdrawal_attached !== (policy.tokenId ? STORAGE_FEE.toString() : quote.withdrawalAttached) || config.withdrawal_received !== quote.withdrawalReceived || config.storage_fee !== STORAGE_FEE.toString()) throw new Error('Shared fee policy mismatch');
  if (policy.tokenId && (config.deposit_token_amount !== (BigInt(policy.denomination) + BigInt(quote.depositProtocolFee)).toString() || config.withdrawal_token_fee !== quote.withdrawalProtocolFee || config.storage_credit_bond !== '5000000000000000000000')) throw new Error('FT fee policy mismatch');
  if (config.leaf_count > config.capacity || config.outstanding_notes > config.leaf_count || BigInt(config.creation_deposit) !== BigInt(config.vault_funding) + BigInt(config.registration_fee)) throw new Error('Invalid registry accounting');
  let from = Count.parse(options.fromIndex ?? 0), max = options.maxRecords ?? 100;
  if (options.vault !== undefined) {
    const account = AccountId.parse(options.vault);
    if (options.fromIndex !== undefined || options.maxRecords !== undefined) throw new Error('Choose a vault or a catalog page, not both');
    if (!source.vaultRecord) throw new Error('This source does not support direct vault lookup');
    const record = VaultRecord.nullable().parse(await source.vaultRecord(account, blockHash));
    if (!record || record.account_id !== account || record.index >= config.vault_count) throw new Error('Specified vault is not registered in this group');
    from = record.index; max = 1;
  }
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('Scan 1–200 records');
  const end = Math.min(config.vault_count, from + max);
  const vaults: { accountId: string; availableNotes: number; reservedNotes: number; canDeposit: boolean; canWithdraw: boolean }[] = [];
  for (let offset = from; offset < end;) {
    const limit = Math.min(50, end - offset);
    const records = z.array(VaultRecord).parse(await source.records(offset, limit, blockHash));
    if (records.length !== limit) throw new Error('Incomplete shared vault page');
    for (const [i, record] of records.entries()) {
      if (record.index !== offset + i || !/^v[0-9a-f]{32}$/.test(record.account_id.slice(0, 33)) || record.account_id !== `${record.account_id.slice(0, 33)}.${policy.registry}`) throw new Error('Invalid shared vault record');
      if (options.vault !== undefined && record.account_id !== options.vault) throw new Error('Direct vault lookup differs from registry page');
      if (record.state !== 'Ready') continue;
      const [vaultCode, vaultKeys, local] = await Promise.all([source.codeSha256(record.account_id, blockHash), source.accessKeys(record.account_id, blockHash), source.vaultConfig(record.account_id, blockHash)]);
      if (vaultCode !== policy.vaultWasmSha256 || vaultKeys.length !== 0) throw new Error('Shared vault code mismatch or remaining keys');
      const vault = VaultConfig.parse(local);
      if (vault.protocol !== (policy.tokenId ? 'core-shared-ft-vault-v3' : 'core-shared-vault-v2') || (vault.asset_token_id ?? undefined) !== policy.tokenId) throw new Error('Vault asset mismatch');
      if (policy.tokenId && (vault.deposit_token_amount !== config.deposit_token_amount || vault.storage_credit_bond !== config.storage_credit_bond)) throw new Error('Vault token fee policy mismatch');
      if (vault.registry !== policy.registry || vault.network !== policy.network || vault.denomination !== policy.denomination || vault.fee_recipient !== policy.feeRecipient || vault.deposit_attached !== (policy.tokenId ? STORAGE_FEE.toString() : quote.depositAttached) || vault.withdrawal_received !== policy.denomination || vault.storage_fee !== STORAGE_FEE.toString()) throw new Error('Vault belongs to a different group or fee policy');
      if (vault.held_notes > 256 || vault.available_notes + vault.reserved_notes + vault.pending_deposits > vault.held_notes) throw new Error('Invalid vault accounting');
      vaults.push({ accountId: record.account_id, availableNotes: record.available_notes, reservedNotes: record.reserved_notes,
        canDeposit: config.leaf_count < config.capacity && vault.held_notes < 256, canWithdraw: record.available_notes > 0 && vault.available_notes > 0 });
    }
    offset += records.length;
  }
  return { blockHash, pool, root: config.root, leafCount: config.leaf_count, outstandingNotes: config.outstanding_notes,
    creationDeposit: config.creation_deposit, vaultCount: config.vault_count, checkedRecords: Math.max(0, end - from), nextIndex: end < config.vault_count ? end : null, vaults };
}
export type SharedCatalog = Awaited<ReturnType<typeof discoverSharedVaults>>;
/** Payment selection uses one finalized snapshot. Never silently select from a truncated group. */
export async function discoverSharedVaultGroup(source: SharedChainSource, input: SharedPolicy, options: { vault?: string; maxRecords?: number } = {}): Promise<SharedCatalog> {
  const policy = SharedPolicySchema.parse(input);
  if (source.network !== policy.network || source.factory !== policy.registry) throw new Error('Wrong shared registry');
  const block = await source.finalizedBlock();
  const pinned: SharedChainSource = {
    network: source.network, factory: source.factory, finalizedBlock: async () => block,
    config: b => source.config(b), records: (f, l, b) => source.records(f, l, b),
    vaultConfig: (a, b) => source.vaultConfig(a, b), codeSha256: (a, b) => source.codeSha256(a, b),
    accessKeys: (a, b) => source.accessKeys(a, b), commitments: b => source.commitments(b),
    ...(source.vaultRecord ? { vaultRecord: (a: string, b: string) => source.vaultRecord!(a, b) } : {}),
  };
  if (options.vault !== undefined) return discoverSharedVaults(pinned, policy, { vault: options.vault });
  const budget = z.number().int().min(1).max(10000).parse(options.maxRecords ?? 1000);
  const first = await discoverSharedVaults(pinned, policy, { maxRecords: Math.min(100, budget) });
  if (first.vaultCount > budget) throw new Error('Group scan budget exceeded; specify a vault for direct verification');
  const fingerprint = (c: SharedCatalog) => JSON.stringify([c.blockHash, c.pool, c.root, c.leafCount, c.outstandingNotes, c.creationDeposit, c.vaultCount]);
  const catalog = { ...first, vaults: [...first.vaults] }, seen = new Set(first.vaults.map(v => v.accountId));
  while (catalog.nextIndex !== null) {
    const from = catalog.nextIndex;
    const page = await discoverSharedVaults(pinned, policy, { fromIndex: from, maxRecords: Math.min(100, budget - catalog.checkedRecords) });
    if (fingerprint(page) !== fingerprint(first) || page.checkedRecords < 1 || (page.nextIndex !== null && page.nextIndex <= from)) throw new Error('Shared group snapshot changed during discovery');
    for (const vault of page.vaults) {
      if (seen.has(vault.accountId)) throw new Error('Duplicate shared vault in registry pages');
      seen.add(vault.accountId); catalog.vaults.push(vault);
    }
    catalog.checkedRecords += page.checkedRecords; catalog.nextIndex = page.nextIndex;
  }
  return catalog;
}
export async function loadSharedTree(source: SharedChainSource, catalog: SharedCatalog): Promise<NoteTree> {
  if (source.network !== catalog.pool.network || source.factory !== catalog.pool.contract) throw new Error('Wrong shared tree source');
  const leaves = z.array(Amount).parse(await source.commitments(catalog.blockHash));
  if (leaves.length !== catalog.leafCount) throw new Error('Incomplete shared commitment list');
  const tree = await NoteTree.from(leaves);
  if (tree.root !== catalog.root) throw new Error('Shared root mismatch');
  return tree;
}
export function chooseSharedVault(catalog: SharedCatalog, operation: 'deposit' | 'withdraw'): string {
  const eligible = catalog.vaults.filter(v => operation === 'withdraw' ? v.canWithdraw : v.canDeposit);
  if (eligible.length === 0) throw new Error(`No verified vault available for ${operation}`);
  return eligible[randomInt(eligible.length)].accountId;
}
