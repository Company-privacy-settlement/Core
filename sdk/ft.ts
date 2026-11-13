import { contextHash, domain, field, quoteFees, STORAGE_FEE, validateNote, type Note, type Pool, type Spend } from './core.js';
import type { SharedCatalog } from './shared.js';

/** Circle native USDC, not bridged USDC.e. Reference checked 2026-11-12. */
export const USDC = {
  decimals: 6,
  testnet: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  mainnet: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
} as const;
export const STORAGE_CREDIT_BOND = 5n * 10n ** 21n;
export type ContractCall = { contract: string; method: string; args: Record<string, unknown>; attachedYoctoNear: string; gas: string };
const GAS = '300000000000000';
function account(value: string) { domain({ network: 'testnet', contract: value, denomination: '1' }); }
function ftPool(pool: Pool): asserts pool is Pool & { version: 3; tokenId: string } {
  if (pool.version !== 3) throw new Error('Use an FT shared group'); domain(pool);
}
export function parseUsdc(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value) || value.length > 50) throw new Error('Use a positive USDC amount with up to 6 decimals');
  const [whole, fractional = ''] = value.split('.'); const amount = BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, '0'));
  quoteFtFees(amount.toString()); return amount.toString();
}
/** Token quantities and yoctoNEAR are deliberately separate; never sum currencies. */
export function quoteFtFees(amount: string) {
  const q = quoteFees(amount);
  if (BigInt(q.withdrawalProtocolFee) === 0n) throw new Error('FT denomination fee rounds to zero');
  return { principalTokens: q.amount, depositProtocolFeeTokens: q.depositProtocolFee, withdrawalProtocolFeeTokens: q.withdrawalProtocolFee,
    depositTransferTokens: (BigInt(q.amount) + BigInt(q.depositProtocolFee)).toString(), withdrawalFeeTransferTokens: q.withdrawalProtocolFee,
    recipientTokens: q.amount, actionStorageYoctoNear: STORAGE_FEE.toString(), firstUseStorageBondYoctoNear: STORAGE_CREDIT_BOND.toString(), transferCallYoctoNear: '1' };
}
function vaultFor(catalog: SharedCatalog, vault: string, operation: 'deposit' | 'withdraw') {
  ftPool(catalog.pool);
  const record = catalog.vaults.find(v => v.accountId === vault);
  if (!record || !(operation === 'deposit' ? record.canDeposit : record.canWithdraw)) throw new Error('Choose a verified, eligible FT vault');
}
export async function buildFtDeposit(catalog: SharedCatalog, vault: string, note: Note, disclosureRoot: string) {
  vaultFor(catalog, vault, 'deposit'); const pool = catalog.pool; ftPool(pool); await validateNote(pool, note);
  return buildFtDepositCommitment(catalog, vault, note.commitment, disclosureRoot);
}
/** Public deposit preparation never requires a note's secret or nullifier. */
export function buildFtDepositCommitment(catalog: SharedCatalog, vault: string, commitment: string, disclosureRoot: string) {
  vaultFor(catalog, vault, 'deposit'); const pool = catalog.pool; ftPool(pool);
  if (field(commitment) === 0n) throw new Error('Empty commitment');
  if (!/^[0-9a-f]{64}$/.test(disclosureRoot)) throw new Error('Invalid receipt root');
  const quote = quoteFtFees(pool.denomination);
  return { quote, storageTarget: vault, tokenCall: { contract: pool.tokenId, method: 'ft_transfer_call',
    args: { receiver_id: vault, amount: quote.depositTransferTokens, msg: JSON.stringify({ commitment, disclosure_root: disclosureRoot }) },
    attachedYoctoNear: '1', gas: GAS } satisfies ContractCall,
    completion: { contract: vault, method: 'get_deposit', args: { commitment }, requiredState: 'Active' } };
}
export function buildFtWithdrawal(catalog: SharedCatalog, vault: string, recipient: string, disclosureRoot: string, spend: Spend) {
  vaultFor(catalog, vault, 'withdraw'); const pool = catalog.pool; ftPool(pool);
  const expected = contextHash(pool, { kind: 'withdraw', vault, target: recipient, disclosureRoot });
  if (spend.public_inputs.length !== 5 || spend.public_inputs.some(s => { try { field(s); return false; } catch { return true; } }) || spend.public_inputs[4] !== domain(pool) || spend.public_inputs[3] !== expected || !/^[A-Za-z0-9+/]+={0,2}$/.test(spend.proof) || Buffer.from(spend.proof, 'base64').length !== 256) throw new Error('Proof does not bind this FT withdrawal');
  const quote = quoteFtFees(pool.denomination);
  return { quote, storageTarget: pool.contract, tokenCall: { contract: pool.tokenId, method: 'ft_transfer_call',
    args: { receiver_id: pool.contract, amount: quote.withdrawalFeeTransferTokens, msg: JSON.stringify({ vault, recipient, disclosure_root: disclosureRoot, ...spend }) },
    attachedYoctoNear: '1', gas: GAS } satisfies ContractCall,
    completion: { contract: pool.contract, method: 'get_withdrawal', args: { nullifier: spend.public_inputs[0] }, requiredState: 'Complete' } };
}
export function buildStoragePrepayment(target: string, payer: string, credit: null | { available: string; in_flight: string }): ContractCall | null {
  account(target); account(payer);
  if (credit && (!/^\d+$/.test(credit.available) || !/^\d+$/.test(credit.in_flight))) throw new Error('Invalid storage credit');
  const available = BigInt(credit?.available ?? '0');
  if (available >= STORAGE_FEE) return null;
  const attached = STORAGE_FEE - available + (credit === null ? STORAGE_CREDIT_BOND : 0n);
  return { contract: target, method: 'prepay_storage', args: { account_id: payer }, attachedYoctoNear: attached.toString(), gas: GAS };
}
/** Read storage_balance_bounds and storage_balance_of on the pinned token before calling. */
export function buildFtRegistration(tokenId: string, accountId: string, minimumYoctoNear: string): ContractCall {
  account(tokenId); account(accountId);
  if (!/^[1-9][0-9]*$/.test(minimumYoctoNear) || BigInt(minimumYoctoNear) > 10n ** 24n) throw new Error('Invalid FT storage minimum');
  return { contract: tokenId, method: 'storage_deposit', args: { account_id: accountId, registration_only: true }, attachedYoctoNear: minimumYoctoNear, gas: GAS };
}
