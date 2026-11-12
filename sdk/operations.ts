import { z } from 'zod';
import { NearRpcError } from './factory.js';
import { NearRpcSharedSource, discoverSharedVaults, SharedPolicySchema, type SharedCatalog, type SharedChainSource, type SharedPolicy } from './shared.js';
import { field, STORAGE_FEE } from './core.js';
import { buildFtRegistration, buildStoragePrepayment, quoteFtFees, USDC, type ContractCall } from './ft.js';
import { AccountId, Atomic, Count, Sha256 } from './validation.js';

export type FinalBlock = { hash: string; height: number };
export interface OperationsSource extends SharedChainSource {
  finalBlock(): Promise<FinalBlock>;
  account(account: string, block: string): Promise<unknown | null>;
  contractView(account: string, method: string, args: Record<string, unknown>, block: string): Promise<unknown>;
  transaction?(hash: string, signer: string): Promise<unknown | null>;
}
export class NearRpcOperationsSource extends NearRpcSharedSource implements OperationsSource {
  async transaction(hash: string, signer: string): Promise<unknown | null> {
    try { return await this.rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' }); }
    catch (e) { if (e instanceof NearRpcError && e.causeName === 'UNKNOWN_TRANSACTION') return null; throw e; }
  }
  async finalBlock(): Promise<FinalBlock> {
    const result = await this.rpc('block', { finality: 'final' });
    return z.object({ hash: z.string().min(1), height: Count }).parse(result.header);
  }
  async account(account: string, block: string): Promise<unknown | null> {
    AccountId.parse(account);
    try { return await this.rpc('query', { request_type: 'view_account', account_id: account, block_id: block }); }
    catch (e) { if (e instanceof NearRpcError && e.causeName === 'UNKNOWN_ACCOUNT') return null; throw e; }
  }
  contractView(account: string, method: string, args: Record<string, unknown>, block: string): Promise<unknown> {
    return this.view(account, method, args, block);
  }
}
export class OperationsError extends Error {
  constructor(readonly code: 'VAULT_NOT_READY' | 'WRONG_ASSET' | 'DESTINATION_MISMATCH', message: string) { super(message); this.name = 'OperationsError'; }
}
export async function operationCatalog(source: OperationsSource, policy: SharedPolicy, options: { fromIndex?: number; maxRecords?: number } = {}) {
  const block = z.object({ hash: z.string().min(1), height: Count }).parse(await source.finalBlock());
  const catalog = await discoverSharedVaults(pinned(source, block), policy, options);
  return { checkedAtBlock: block, catalog };
}
const Credit = z.object({ available: Atomic, in_flight: Atomic }).nullable();
const Registration = z.object({ total: Atomic, available: Atomic }).nullable();
export const PreflightInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('deposit'), payer: AccountId, vault: AccountId }).strict(),
  z.object({ operation: z.literal('withdraw'), payer: AccountId, vault: AccountId, recipient: AccountId }).strict(),
]);
export type PreflightRequest = z.infer<typeof PreflightInput>;
export type Blocker = { code: 'ACCOUNT_MISSING' | 'PAYER_NOT_REGISTERED' | 'INSUFFICIENT_TOKENS'; accountId: string };

/** Bind discovery, balances, storage and operation reads to the same finalized block. */
function pinned(source: OperationsSource, block: FinalBlock): SharedChainSource {
  return { network: source.network, factory: source.factory, finalizedBlock: async () => block.hash,
    config: b => source.config(b), records: (f,l,b) => source.records(f,l,b), vaultConfig: (a,b) => source.vaultConfig(a,b),
    codeSha256: (a,b) => source.codeSha256(a,b), accessKeys: (a,b) => source.accessKeys(a,b), commitments: b => source.commitments(b) };
}
async function verified(source: OperationsSource, input: SharedPolicy, vault?: string) {
  const policy = SharedPolicySchema.parse(input);
  if (source.network !== policy.network || source.factory !== policy.registry) throw new Error('Wrong operations source');
  const block = z.object({ hash: z.string().min(1), height: Count }).parse(await source.finalBlock());
  let fromIndex = 0;
  if (vault) {
    AccountId.parse(vault);
    const record = z.object({ index: Count, account_id: AccountId }).nullable().parse(await source.contractView(policy.registry, 'get_vault', { account_id: vault }, block.hash));
    if (!record || record.account_id !== vault) throw new OperationsError('VAULT_NOT_READY', 'Vault is not registered in the trusted group');
    fromIndex = record.index;
  }
  const catalog = await discoverSharedVaults(pinned(source, block), policy, { fromIndex, maxRecords: 1 });
  if (vault && !catalog.vaults.some(v => v.accountId === vault)) throw new OperationsError('VAULT_NOT_READY', 'Vault is not a verified ready member');
  return { policy, block, catalog };
}
export async function preflightFt(source: OperationsSource, policy: SharedPolicy, request: PreflightRequest) {
  const input = PreflightInput.parse(request);
  const snapshot = await verified(source, policy, input.vault);
  const { block, catalog } = snapshot, pool = catalog.pool;
  if (pool.version !== 3) throw new OperationsError('WRONG_ASSET', 'FT preflight requires a token-bound v3 group');
  const member = catalog.vaults[0];
  if (!(input.operation === 'deposit' ? member.canDeposit : member.canWithdraw)) throw new OperationsError('VAULT_NOT_READY', 'Selected vault has no capacity or available liquidity');
  if (input.operation === 'withdraw' && (input.recipient === policy.registry || input.recipient.endsWith(`.${policy.registry}`))) throw new OperationsError('DESTINATION_MISMATCH', 'Recipient cannot be the registry or a vault');
  const target = input.operation === 'deposit' ? input.vault : pool.contract;
  const quote = quoteFtFees(pool.denomination);
  const needed = input.operation === 'deposit' ? quote.depositTransferTokens : quote.withdrawalFeeTransferTokens;
  const accounts = [...new Set([input.payer, input.vault, ...(input.operation === 'withdraw' ? [pool.contract, input.recipient] : [])])];
  const [metadata, bounds, rawBalance, rawCredit, states] = await Promise.all([
    source.contractView(pool.tokenId, 'ft_metadata', {}, block.hash),
    source.contractView(pool.tokenId, 'storage_balance_bounds', {}, block.hash),
    source.contractView(pool.tokenId, 'ft_balance_of', { account_id: input.payer }, block.hash),
    source.contractView(target, 'get_storage_credit', { account_id: input.payer }, block.hash),
    Promise.all(accounts.map(async accountId => ({ accountId,
      account: z.object({ amount: Atomic, locked: Atomic, storage_usage: Count }).nullable().parse(await source.account(accountId, block.hash)),
      registration: Registration.parse(await source.contractView(pool.tokenId, 'storage_balance_of', { account_id: accountId }, block.hash)) }))),
  ]);
  const token = z.object({ spec: z.literal('ft-1.0.0'), name: z.string().max(256), symbol: z.string().max(64), decimals: z.number().int().min(0).max(255) }).parse(metadata);
  // A symbol never establishes identity. Only independently configured Circle accounts get this label.
  const nativeUsdc = pool.tokenId === USDC.testnet && pool.network === 'testnet';
  if (nativeUsdc && token.decimals !== USDC.decimals) throw new Error('Pinned USDC token decimals changed');
  const storageBounds = z.object({ min: Atomic, max: Atomic.nullable() }).parse(bounds);
  const balance = Atomic.parse(rawBalance), credit = Credit.parse(rawCredit);
  const blockers: Blocker[] = [], calls: ContractCall[] = [];
  for (const state of states) {
    if (state.account === null) { blockers.push({ code: 'ACCOUNT_MISSING', accountId: state.accountId }); continue; }
    if (state.accountId === input.payer) {
      if (state.registration === null) blockers.push({ code: 'PAYER_NOT_REGISTERED', accountId: input.payer });
    } else if (state.registration === null) calls.push(buildFtRegistration(pool.tokenId, state.accountId, storageBounds.min));
  }
  if (BigInt(balance) < BigInt(needed)) blockers.push({ code: 'INSUFFICIENT_TOKENS', accountId: input.payer });
  const prepayment = buildStoragePrepayment(target, input.payer, credit);
  if (prepayment) calls.push(prepayment);
  return { operation: input.operation, payer: input.payer, vault: input.vault, recipient: input.operation === 'withdraw' ? input.recipient : null,
    checkedAtBlock: block, token: { accountId: pool.tokenId, ...token, nativeUsdc }, quote, payerTokenBalance: balance,
    tokenAmountRequired: needed, storageTarget: target, storageCredit: credit,
    accounts: states.map(s => ({ accountId: s.accountId, exists: s.account !== null, registered: s.registration !== null })),
    blockers, prerequisites: calls, canPrepare: blockers.length === 0,
    prerequisitesSatisfied: blockers.length === 0 && calls.length === 0,
    requiredAttachedYoctoNear: (calls.reduce((n,c) => n + BigInt(c.attachedYoctoNear), 0n) + 1n).toString(),
    gasBudgetIncluded: false, note: 'Snapshot only. Recheck after prerequisites and before signing. Wallet signs locally; gas and native account activation are separate.' };
}

const DecimalField = z.string().max(77).refine(v => { try { return field(v).toString() === v; } catch { return false; } }, 'Invalid scalar field');
export const SettlementReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deposit'), vault: AccountId, commitment: DecimalField, expectedOwner: AccountId.optional(), expectedDisclosureRoot: Sha256.optional() }).strict(),
  z.object({ kind: z.literal('withdrawal'), nullifier: DecimalField, expectedVault: AccountId.optional(), expectedRecipient: AccountId.optional(), expectedDisclosureRoot: Sha256.optional() }).strict(),
]);
export type SettlementRef = z.infer<typeof SettlementReference>;
const Deposit = z.object({ owner: AccountId, disclosure_root: Sha256, state: z.enum(['Pending','Retryable','Active','Refundable','RefundInFlight','Refunded']), attempt: Count.min(1), last_height: Count });
const Withdrawal = z.object({ vault: AccountId, recipient: AccountId, disclosure_root: Sha256, state: z.enum(['Pending','Retryable','Complete']), attempt: Count.min(1), last_height: Count });
export async function observeSettlement(source: OperationsSource, policy: SharedPolicy, reference: SettlementRef) {
  const ref = SettlementReference.parse(reference);
  const snapshot = await verified(source, policy, ref.kind === 'deposit' ? ref.vault : undefined);
  const { block, catalog } = snapshot;
  const contract = ref.kind === 'deposit' ? ref.vault : policy.registry;
  const method = ref.kind === 'deposit' ? 'get_deposit' : 'get_withdrawal';
  const args = ref.kind === 'deposit' ? { commitment: ref.commitment } : { nullifier: ref.nullifier };
  const raw = await source.contractView(contract, method, args, block.hash);
  const record = ref.kind === 'deposit' ? Deposit.nullable().parse(raw) : Withdrawal.nullable().parse(raw);
  if (record && record.last_height > block.height) throw new Error('Operation is newer than the finalized snapshot');
  if (record && (ref.expectedDisclosureRoot && ref.expectedDisclosureRoot !== record.disclosure_root || ref.kind === 'deposit' && ref.expectedOwner && ref.expectedOwner !== (record as z.infer<typeof Deposit>).owner || ref.kind === 'withdrawal' && (ref.expectedVault && ref.expectedVault !== (record as z.infer<typeof Withdrawal>).vault || ref.expectedRecipient && ref.expectedRecipient !== (record as z.infer<typeof Withdrawal>).recipient))) throw new OperationsError('DESTINATION_MISMATCH', 'Settlement destination or receipt binding mismatch');
  // Withdrawal records may point outside the first catalog page. Verify the original payout vault at this same block.
  if (ref.kind === 'withdrawal' && record) {
    const vault = (record as z.infer<typeof Withdrawal>).vault;
    const member = z.object({ index: Count, account_id: AccountId }).parse(await source.contractView(policy.registry, 'get_vault', { account_id: vault }, block.hash));
    const checked = await discoverSharedVaults(pinned(source, block), snapshot.policy, { fromIndex: member.index, maxRecords: 1 });
    if (!checked.vaults.some(v => v.accountId === vault)) throw new Error('Payout vault is not a verified member');
  }
  const state = record?.state ?? 'NotFound';
  const retryAvailable = !!record && (state === 'Retryable' || state === 'Pending' && block.height >= record.last_height + 20);
  const refundAvailable = ref.kind === 'deposit' && state === 'Refundable';
  const retryCall: ContractCall | null = retryAvailable ? { contract, method: ref.kind === 'deposit' ? 'retry_deposit' : 'retry_withdrawal', args, attachedYoctoNear: STORAGE_FEE.toString(), gas: '300000000000000' } : null;
  const refundCall: ContractCall | null = refundAvailable ? { contract, method: 'claim_deposit_refund', args, attachedYoctoNear: '1', gas: '300000000000000' } : null;
  return { reference: ref, checkedAtBlock: block, assetTokenId: catalog.pool.tokenId ?? null, state, record,
    complete: state === 'Active' || state === 'Complete', refunded: state === 'Refunded', retryAvailable, refundAvailable,
    retryAfterBlock: state === 'Pending' && record ? record.last_height + 20 : null, retryCall, refundCall,
    note: 'Finalized contract state, not transaction acceptance. Pending and timeouts do not establish payout failure; retries keep the original destination.' };
}
export async function waitForSettlement(source: OperationsSource, policy: SharedPolicy, ref: SettlementRef, options: { maxAttempts?: number; intervalMs?: number; signal?: AbortSignal } = {}) {
  const maxAttempts = z.number().int().min(1).max(100).parse(options.maxAttempts ?? 20);
  const intervalMs = z.number().int().min(100).max(30_000).parse(options.intervalMs ?? 1000);
  for (let attempt = 1;;attempt++) {
    options.signal?.throwIfAborted();
    const snapshot = await observeSettlement(source, policy, ref);
    options.signal?.throwIfAborted();
    if (snapshot.complete || snapshot.refunded || snapshot.retryAvailable || snapshot.refundAvailable || attempt === maxAttempts) return { ...snapshot, attempts: attempt, timedOut: !snapshot.complete && !snapshot.refunded && !snapshot.retryAvailable && !snapshot.refundAvailable && attempt === maxAttempts };
    await new Promise<void>((resolve,reject) => {
      const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); reject(options.signal?.reason ?? new Error('Aborted')); };
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort',abort); resolve(); }, intervalMs);
      options.signal?.addEventListener('abort',abort,{once:true});
      if (options.signal?.aborted) abort();
    });
  }
}
