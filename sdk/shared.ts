import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { domain, sha256, quoteFees, NoteTree, STORAGE_FEE, type Pool } from './core.js';
import { NearRpcFactorySource, type FactoryChainSource } from './factory.js';

const Amount = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RegistryConfig = z.object({
  protocol: z.literal('core-shared-registry-v2'), network: z.enum(['sandbox', 'testnet']), denomination: Amount,
  fee_recipient: z.string(), deposit_fee_bps: z.literal(15), withdrawal_fee_bps: z.literal(15),
  deposit_attached: Amount, withdrawal_attached: Amount, withdrawal_received: Amount, storage_fee: Amount,
  vault_wasm_sha256: Hash, verifier_sha256: Hash, vault_count: Count, creation_deposit: Amount,
  vault_funding: Amount, registration_fee: Amount, domain: Amount, root: Amount, leaf_count: Count, capacity: z.literal(256), outstanding_notes: Count,
});
const VaultRecord = z.object({ index: Count, account_id: z.string(), state: z.enum(['Pending', 'Ready', 'Failed']), available_notes: Count, reserved_notes: Count });
const VaultConfig = z.object({
  protocol: z.literal('core-shared-vault-v2'), registry: z.string(), network: z.enum(['sandbox', 'testnet']), denomination: Amount,
  fee_recipient: z.string(), deposit_fee_bps: z.literal(15), withdrawal_fee_bps: z.literal(15), storage_fee: Amount,
  deposit_attached: Amount, withdrawal_received: Amount, available_notes: Count, reserved_notes: Count, pending_deposits: Count, held_notes: Count,
});
export type SharedPolicy = { network: Pool['network']; registry: string; denomination: string; feeRecipient: string; registryWasmSha256: string; vaultWasmSha256: string; verifierSha256: string };
export interface SharedChainSource extends FactoryChainSource { commitments(block: string): Promise<unknown>; }
export class NearRpcSharedSource extends NearRpcFactorySource implements SharedChainSource {
  commitments(block: string): Promise<unknown> { return this.view(this.factory, 'get_commitments', { from_index: 0, limit: 256 }, block); }
}
export function predictSharedVault(registry: string, creator: string, salt: string): string {
  domain({ network: 'testnet', contract: registry, denomination: '1' });
  domain({ network: 'testnet', contract: creator, denomination: '1' });
  if (registry.length > 30 || !/^[a-f0-9]{64}$/.test(salt)) throw new Error('Invalid registry length or salt');
  return `v${sha256(`core:shared-vault:v2|${creator}|${salt}`).slice(0, 32)}.${registry}`;
}

export async function discoverSharedVaults(source: SharedChainSource, policy: SharedPolicy, options: { fromIndex?: number; maxRecords?: number } = {}) {
  if (source.network !== policy.network || source.factory !== policy.registry) throw new Error('Wrong shared registry');
  [policy.registryWasmSha256, policy.vaultWasmSha256, policy.verifierSha256].forEach(h => Hash.parse(h));
  domain({ network: policy.network, contract: policy.feeRecipient, denomination: '1' });
  const quote = quoteFees(policy.denomination);
  const blockHash = await source.finalizedBlock();
  const [code, keys, raw] = await Promise.all([source.codeSha256(policy.registry, blockHash), source.accessKeys(policy.registry, blockHash), source.config(blockHash)]);
  if (code !== policy.registryWasmSha256 || keys.length !== 0) throw new Error('Registry code mismatch or remaining keys');
  const config = RegistryConfig.parse(raw);
  const pool: Pool = { version: 2, network: policy.network, contract: policy.registry, denomination: policy.denomination };
  if (config.network !== policy.network || config.denomination !== policy.denomination || config.fee_recipient !== policy.feeRecipient || config.vault_wasm_sha256 !== policy.vaultWasmSha256 || config.verifier_sha256 !== policy.verifierSha256 || config.domain !== domain(pool)) throw new Error('Shared group configuration mismatch');
  if (config.deposit_attached !== quote.depositAttached || config.withdrawal_attached !== quote.withdrawalAttached || config.withdrawal_received !== quote.withdrawalReceived || config.storage_fee !== STORAGE_FEE.toString()) throw new Error('Shared fee policy mismatch');
  if (config.leaf_count > config.capacity || config.outstanding_notes > config.leaf_count || BigInt(config.creation_deposit) !== BigInt(config.vault_funding) + BigInt(config.registration_fee)) throw new Error('Invalid registry accounting');
  const from = Count.parse(options.fromIndex ?? 0), max = options.maxRecords ?? 100;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('Scan 1–200 records');
  const end = Math.min(config.vault_count, from + max);
  const vaults: { accountId: string; availableNotes: number; reservedNotes: number; canDeposit: boolean; canWithdraw: boolean }[] = [];
  for (let offset = from; offset < end;) {
    const limit = Math.min(50, end - offset);
    const records = z.array(VaultRecord).parse(await source.records(offset, limit, blockHash));
    if (records.length !== limit) throw new Error('Incomplete shared vault page');
    for (const [i, record] of records.entries()) {
      if (record.index !== offset + i || !/^v[0-9a-f]{32}$/.test(record.account_id.slice(0, 33)) || record.account_id !== `${record.account_id.slice(0, 33)}.${policy.registry}`) throw new Error('Invalid shared vault record');
      if (record.state !== 'Ready') continue;
      const [vaultCode, vaultKeys, local] = await Promise.all([source.codeSha256(record.account_id, blockHash), source.accessKeys(record.account_id, blockHash), source.vaultConfig(record.account_id, blockHash)]);
      if (vaultCode !== policy.vaultWasmSha256 || vaultKeys.length !== 0) throw new Error('Shared vault code mismatch or remaining keys');
      const vault = VaultConfig.parse(local);
      if (vault.registry !== policy.registry || vault.network !== policy.network || vault.denomination !== policy.denomination || vault.fee_recipient !== policy.feeRecipient || vault.deposit_attached !== quote.depositAttached || vault.withdrawal_received !== policy.denomination || vault.storage_fee !== STORAGE_FEE.toString()) throw new Error('Vault belongs to a different group or fee policy');
      if (vault.held_notes > 256 || vault.available_notes + vault.reserved_notes + vault.pending_deposits > vault.held_notes) throw new Error('Invalid vault accounting');
      vaults.push({ accountId: record.account_id, availableNotes: record.available_notes, reservedNotes: record.reserved_notes,
        canDeposit: config.leaf_count < config.capacity && vault.held_notes < 256, canWithdraw: record.available_notes > 0 && vault.available_notes > 0 });
    }
    offset += records.length;
  }
  return { blockHash, pool, root: config.root, leafCount: config.leaf_count, outstandingNotes: config.outstanding_notes,
    creationDeposit: config.creation_deposit, checkedRecords: Math.max(0, end - from), nextIndex: end < config.vault_count ? end : null, vaults };
}
export type SharedCatalog = Awaited<ReturnType<typeof discoverSharedVaults>>;
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
