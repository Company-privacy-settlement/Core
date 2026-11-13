import { canonical } from './crypto.js';
import { object, account, parsePolicy, parseCall, GAS } from './payment.js';
import type { Policy, Call } from './types.js';
export type RecipientReadiness = {
  policy: Policy; recipient: string; checkedAtBlock: { hash: string; height: number };
  accountKind: 'near_implicit' | 'eth_implicit' | 'named_or_other';
  accountExists: boolean; tokenRegistered: boolean; state: 'account_missing' | 'registration_required' | 'ready';
  canReceiveTokens: boolean; storageMinimumYoctoNear: string; registrationCall: Call | null;
  activationAmountYoctoNear: null; gasBudgetIncluded: false; chainFreshnessChecked: false;
};
export function parseRecipientReadiness(raw: unknown, trusted: Policy, expectedRecipient: string): RecipientReadiness {
  const r = object(raw), policy = parsePolicy(r.policy), expected = parsePolicy(trusted), recipient = account(r.recipient), block = object(r.checkedAtBlock);
  const fields = ['policy','recipient','checkedAtBlock','accountKind','accountExists','tokenRegistered','state','canReceiveTokens','storageMinimumYoctoNear','registrationCall','activationAmountYoctoNear','gasBudgetIncluded','chainFreshnessChecked'];
  if (Object.keys(r).sort().join('|') !== fields.sort().join('|') || Object.keys(block).sort().join('|') !== 'hash|height') throw new Error('Unexpected recipient readiness fields');
  if (!policy.tokenId || canonical(policy) !== canonical(expected) || recipient !== account(expectedRecipient) || recipient === policy.registry || recipient.endsWith('.' + policy.registry)) throw new Error('Recipient readiness differs from the trusted destination');
  if (typeof block.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.hash) || typeof block.height !== 'number' || !Number.isSafeInteger(block.height) || block.height < 0) throw new Error('Invalid recipient readiness block');
  if (typeof r.accountExists !== 'boolean' || typeof r.tokenRegistered !== 'boolean') throw new Error('Invalid recipient readiness flags');
  const state = !r.accountExists ? 'account_missing' : !r.tokenRegistered ? 'registration_required' : 'ready';
  const accountKind = /^[0-9a-f]{64}$/.test(recipient) ? 'near_implicit' : /^0x[0-9a-f]{40}$/.test(recipient) ? 'eth_implicit' : 'named_or_other';
  if (r.state !== state || r.accountKind !== accountKind || r.canReceiveTokens !== (state === 'ready') || r.activationAmountYoctoNear !== null || r.gasBudgetIncluded !== false || r.chainFreshnessChecked !== false) throw new Error('Inconsistent recipient readiness');
  if (typeof r.storageMinimumYoctoNear !== 'string' || !/^[1-9][0-9]{0,24}$/.test(r.storageMinimumYoctoNear) || BigInt(r.storageMinimumYoctoNear) > 10n ** 24n) throw new Error('Invalid recipient registration minimum');
  const registrationCall = r.registrationCall === null ? null : parseCall(r.registrationCall);
  const expectedCall = state === 'registration_required' ? { contract: policy.tokenId, method: 'storage_deposit', args: { account_id: recipient, registration_only: true }, attachedYoctoNear: r.storageMinimumYoctoNear, gas: GAS } : null;
  if (canonical(registrationCall) !== canonical(expectedCall)) throw new Error('Recipient registration call is not bound to this account and token');
  return { policy, recipient, checkedAtBlock: { hash: block.hash, height: block.height }, accountKind,
    accountExists: r.accountExists, tokenRegistered: r.tokenRegistered, state, canReceiveTokens: state === 'ready',
    storageMinimumYoctoNear: r.storageMinimumYoctoNear, registrationCall, activationAmountYoctoNear: null, gasBudgetIncluded: false, chainFreshnessChecked: false };
}
