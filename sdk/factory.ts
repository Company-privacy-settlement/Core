import { z } from 'zod';
import { domain, sha256, quoteFees, DEPOSIT_FEE_BPS, WITHDRAWAL_FEE_BPS, STORAGE_FEE, type Pool } from './core.js';

const Decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const FactoryConfig = z.object({
  protocol: z.literal('core-factory-v1'), network: z.enum(['sandbox', 'testnet']), denomination: Decimal,
  fee_recipient: z.string(), deposit_fee_bps: z.literal(DEPOSIT_FEE_BPS), withdrawal_fee_bps: z.literal(WITHDRAWAL_FEE_BPS),
  deposit_protocol_fee: Decimal, withdrawal_protocol_fee: Decimal,
  vault_wasm_sha256: Hash, verifier_sha256: Hash, vault_funding: Decimal,
  registration_fee: Decimal, creation_deposit: Decimal, vault_count: Count,
});
const Record = z.object({ index: Count, account_id: z.string(), creator: z.string(), state: z.enum(['Pending', 'Ready', 'Failed']), funding: Decimal });
const VaultConfig = z.object({
  protocol: z.literal('core-v1'), network: z.enum(['sandbox', 'testnet']), denomination: Decimal,
  domain: Decimal, verifier_sha256: Hash, storage_fee: Decimal,
  fee_recipient: z.string(), deposit_fee_bps: z.literal(DEPOSIT_FEE_BPS), withdrawal_fee_bps: z.literal(WITHDRAWAL_FEE_BPS),
  deposit_protocol_fee: Decimal, withdrawal_protocol_fee: Decimal, deposit_attached: Decimal, withdrawal_attached: Decimal, withdrawal_received: Decimal,
  leaf_count: Count, capacity: z.literal(256),
});

export type FactoryPolicy = {
  network: Pool['network']; factory: string; denomination: string; feeRecipient: string;
  factoryWasmSha256: string; vaultWasmSha256: string; verifierSha256: string;
};
export interface FactoryChainSource {
  readonly network: Pool['network']; readonly factory: string;
  finalizedBlock(): Promise<string>;
  config(block: string): Promise<unknown>;
  records(fromIndex: number, limit: number, block: string): Promise<unknown>;
  vaultConfig(account: string, block: string): Promise<unknown>;
  codeSha256(account: string, block: string): Promise<string>;
  accessKeys(account: string, block: string): Promise<unknown[]>;
}

export function predictVaultAccount(factory: string, creator: string, salt: string): string {
  domain({ network: 'testnet', contract: factory, denomination: '1' });
  domain({ network: 'testnet', contract: creator, denomination: '1' });
  if (factory.length > 30 || !/^[a-f0-9]{64}$/.test(salt)) throw new Error('Invalid factory length or salt');
  return `v${sha256(`core:vault:v1|${creator}|${salt}`).slice(0, 32)}.${factory}`;
}

// The caller supplies trusted build hashes. Never copy trust anchors from an unknown factory.
// Every read in one discovery uses the same finalized block hash.
export async function discoverVaults(source: FactoryChainSource, policy: FactoryPolicy, options: { fromIndex?: number; maxRecords?: number } = {}) {
  if (source.network !== policy.network || source.factory !== policy.factory) throw new Error('Wrong factory domain');
  domain({ network: policy.network, contract: policy.feeRecipient, denomination: '1' });
  const fees = quoteFees(policy.denomination);
  [policy.factoryWasmSha256, policy.vaultWasmSha256, policy.verifierSha256].forEach(h => Hash.parse(h));
  const fromIndex = Count.parse(options.fromIndex ?? 0), maxRecords = options.maxRecords ?? 100;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200) throw new Error('Scan 1–200 records per request');
  const blockHash = await source.finalizedBlock();
  const [factoryCode, factoryKeys, rawConfig] = await Promise.all([
    source.codeSha256(policy.factory, blockHash), source.accessKeys(policy.factory, blockHash), source.config(blockHash),
  ]);
  if (factoryCode !== policy.factoryWasmSha256 || factoryKeys.length !== 0) throw new Error('Factory code mismatch or factory still has access keys');
  const config = FactoryConfig.parse(rawConfig);
  if (config.network !== policy.network || config.denomination !== policy.denomination || config.vault_wasm_sha256 !== policy.vaultWasmSha256 || config.verifier_sha256 !== policy.verifierSha256 || config.fee_recipient !== policy.feeRecipient || config.deposit_protocol_fee !== fees.depositProtocolFee || config.withdrawal_protocol_fee !== fees.withdrawalProtocolFee) throw new Error('Factory configuration does not match policy');
  if (BigInt(config.vault_funding) <= 0n || BigInt(config.creation_deposit) !== BigInt(config.vault_funding) + BigInt(config.registration_fee)) throw new Error('Invalid creation quote');
  const end = Math.min(config.vault_count, fromIndex + maxRecords);
  const vaults: { pool: Pool; leafCount: number; capacity: number; canDeposit: boolean }[] = [];
  for (let offset = fromIndex; offset < end;) {
    const limit = Math.min(50, end - offset);
    const records = z.array(Record).parse(await source.records(offset, limit, blockHash));
    if (records.length !== limit) throw new Error('Incomplete factory page');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.index !== offset + i || !record.account_id.startsWith('v') || record.account_id.length > 64) throw new Error('Invalid vault record');
      const label = record.account_id.slice(0, 33);
      if (!/^v[0-9a-f]{32}$/.test(label) || record.account_id !== `${label}.${policy.factory}` || record.funding !== config.vault_funding) throw new Error('Vault is not a direct factory child');
      if (record.state !== 'Ready') continue;
      const [code, keys, rawVault] = await Promise.all([
        source.codeSha256(record.account_id, blockHash), source.accessKeys(record.account_id, blockHash), source.vaultConfig(record.account_id, blockHash),
      ]);
      if (code !== policy.vaultWasmSha256 || keys.length !== 0) throw new Error('Vault code mismatch or vault has access keys');
      const vault = VaultConfig.parse(rawVault);
      const pool: Pool = { network: vault.network, contract: record.account_id, denomination: vault.denomination };
      if (vault.network !== policy.network || vault.denomination !== policy.denomination || vault.verifier_sha256 !== policy.verifierSha256 || vault.domain !== domain(pool) || BigInt(vault.storage_fee) !== STORAGE_FEE || vault.leaf_count > vault.capacity) throw new Error('Vault configuration mismatch');
      if (vault.fee_recipient !== policy.feeRecipient || vault.deposit_protocol_fee !== fees.depositProtocolFee || vault.withdrawal_protocol_fee !== fees.withdrawalProtocolFee || vault.deposit_attached !== fees.depositAttached || vault.withdrawal_attached !== fees.withdrawalAttached || vault.withdrawal_received !== fees.withdrawalReceived) throw new Error('Vault fee policy mismatch');
      vaults.push({ pool, leafCount: vault.leaf_count, capacity: vault.capacity, canDeposit: vault.leaf_count < vault.capacity });
    }
    offset += records.length;
  }
  return { blockHash, factory: policy.factory, creationDeposit: config.creation_deposit, checkedRecords: Math.max(0, end - fromIndex), nextIndex: end < config.vault_count ? end : null, vaults };
}

export class NearRpcError extends Error {
  constructor(readonly detail: unknown) { super(`RPC error: ${JSON.stringify(detail)}`); this.name = 'NearRpcError'; }
  get causeName(): string | undefined {
    const error = this.detail as { cause?: { name?: string } } | null;
    return error?.cause?.name;
  }
}

export class NearRpcFactorySource implements FactoryChainSource {
  private id = 0;
  constructor(readonly network: Pool['network'], readonly factory: string, private readonly rpcUrl: string, private readonly requestSignal?: AbortSignal) {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' && !(network === 'sandbox' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS outside sandbox');
  }
  protected async rpc(method: string, params: unknown): Promise<any> {
    const timeout = AbortSignal.timeout(20_000);
    const signal = this.requestSignal ? AbortSignal.any([timeout, this.requestSignal]) : timeout;
    const response = await fetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }), signal });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body: any = await response.json();
    if (body.error) throw new NearRpcError(body.error);
    if (body.result === undefined || body.result === null) throw new Error('RPC response has no result');
    if (body.result.error !== undefined) throw new NearRpcError(body.result.error);
    return body.result;
  }
  protected async view(account: string, method: string, args: unknown, block: string): Promise<unknown> {
    const result = await this.rpc('query', { request_type: 'call_function', block_id: block, account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(result.result).toString());
  }
  async finalizedBlock(): Promise<string> { return (await this.rpc('block', { finality: 'final' })).header.hash; }
  config(block: string): Promise<unknown> { return this.view(this.factory, 'get_config', {}, block); }
  records(fromIndex: number, limit: number, block: string): Promise<unknown> { return this.view(this.factory, 'list_vaults', { from_index: fromIndex, limit }, block); }
  vaultConfig(account: string, block: string): Promise<unknown> { return this.view(account, 'get_config', {}, block); }
  async codeSha256(account: string, block: string): Promise<string> {
    const result = await this.rpc('query', { request_type: 'view_code', block_id: block, account_id: account });
    return sha256(Buffer.from(result.code_base64, 'base64'));
  }
  async accessKeys(account: string, block: string): Promise<unknown[]> {
    return z.array(z.unknown()).parse((await this.rpc('query', { request_type: 'view_access_key_list', block_id: block, account_id: account })).keys);
  }
}
