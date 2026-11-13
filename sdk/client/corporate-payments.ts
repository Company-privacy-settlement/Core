import { canonical, sha256 } from './crypto.js';
import { account, feeQuote, object, parsePolicy, preparedPayment, validatePrerequisite } from './payment.js';
import type { Call, Operation, Policy } from './types.js';
import type { SettlementGuards } from './session.js';
import type { OrganizationClient } from './organizations.js';

export type CorporateContent = { format: 'core-corporate-payment-v1'; title: string; policy: Policy; payer: string; payment: Call; prerequisites: Call[] };
export type CorporatePayload = { format: 'core-corporate-approval-v1'; organizationId: string; paymentId: string; creatorAccount: string; creatorMembershipVersion: number; expiresAt: string; content: CorporateContent };
export type CorporatePayment = { payload: CorporatePayload; contentHash: string; state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'dispatched' | 'invalidated'; version: number; approvedBy: string | null; approverMembershipVersion: number | null; approvedAt: string | null; approvalValid: boolean; dispatches: { callHash: string; kind: 'payment' | 'prerequisite'; createdAt: string }[] };
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).sort().join('|') !== keys.sort().join('|')) throw new Error('Unsupported corporate payment fields'); }
export function corporateId(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error('Invalid corporate payment ID'); return value; }
export async function corporateContent(input: unknown): Promise<CorporateContent> {
  const raw = JSON.parse(canonical(input)), c = object(raw);
  exact(c, ['format','title','policy','payer','payment','prerequisites']);
  if (c.format !== 'core-corporate-payment-v1' || typeof c.title !== 'string' || c.title.trim() !== c.title || c.title.length < 2 || c.title.length > 120 || /[\u0000-\u001f\u007f]/.test(c.title)) throw new Error('Use a payment title of 2–120 characters');
  const policy = parsePolicy(c.policy), payer = account(c.payer);
  if (policy.network !== 'testnet' || !policy.tokenId) throw new Error('Corporate payments support testnet FT withdrawals');
  const prepared = await preparedPayment({ tokenCall: c.payment }, policy, payer);
  if (prepared.reference.kind !== 'withdrawal') throw new Error('Corporate payment must be a withdrawal');
  if (!Array.isArray(c.prerequisites) || c.prerequisites.length > 8) throw new Error('At most eight reviewed prerequisites are supported');
  const prerequisites = c.prerequisites.map(call => validatePrerequisite(call, policy, payer, prepared.reference));
  if (new Set(prerequisites.map(canonical)).size !== prerequisites.length) throw new Error('Duplicate reviewed prerequisite');
  return { format:'core-corporate-payment-v1',title:c.title,policy,payer,payment:prepared.payment,prerequisites };
}
export async function verifyCorporatePayment(input: unknown, organizationId?: string): Promise<CorporatePayment> {
  const value = JSON.parse(canonical(input)) as CorporatePayment, p = value?.payload;
  if (!p) throw new Error('Invalid corporate payment');
  exact(object(p), ['format','organizationId','paymentId','creatorAccount','creatorMembershipVersion','expiresAt','content']);
  corporateId(p.organizationId); corporateId(p.paymentId); account(p.creatorAccount);
  if (p.format !== 'core-corporate-approval-v1' || (organizationId !== undefined && p.organizationId !== organizationId) || !Number.isSafeInteger(p.creatorMembershipVersion) || p.creatorMembershipVersion < 1 || !Number.isFinite(Date.parse(p.expiresAt)) || p.expiresAt !== new Date(p.expiresAt).toISOString() || p.creatorAccount !== p.content.payer) throw new Error('Corporate approval binding mismatch');
  const content = await corporateContent(p.content);
  if (canonical(content) !== canonical(p.content) || value.contentHash !== await sha256(canonical(p)) || !['pending','approved','rejected','cancelled','dispatched','invalidated'].includes(value.state) || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.approvalValid !== 'boolean' || !Array.isArray(value.dispatches) || value.dispatches.length > 9) throw new Error('Corporate payment content or checksum mismatch');
  if (value.approvedBy !== null) account(value.approvedBy);
  if (value.approvalValid && (!value.approvedBy || value.approvedBy === p.creatorAccount || !Number.isSafeInteger(value.approverMembershipVersion) || value.approverMembershipVersion! < 1 || value.state !== 'approved')) throw new Error('Invalid independent approval');
  return value;
}
export function corporateQuote(content: CorporateContent) {
  const q = feeQuote(content.policy);
  return { principalTokens: q.principalTokens, feeTokens: q.feeTokens,
    maximumAttachedYoctoNear: [...content.prerequisites,content.payment].reduce((sum,c)=>sum+BigInt(c.attachedYoctoNear),0n).toString() };
}
/** Requires an adapter supporting and awaiting beforeDispatch immediately before its provider call. */
export function corporateSettlementGuards(client: OrganizationClient, approved: CorporatePayment): SettlementGuards {
  const selected = JSON.parse(canonical(approved)) as CorporatePayment, base = `/v1/organizations/${corporateId(selected.payload.organizationId)}/payments/${corporateId(selected.payload.paymentId)}`;
  const bind = async (operation: Pick<Operation,'payment'|'payer'|'policy'>) => {
    const fixed = await verifyCorporatePayment(selected), c = fixed.payload.content;
    if (canonical(operation.policy) !== canonical(c.policy) || operation.payer !== c.payer || canonical(operation.payment) !== canonical(c.payment)) throw new Error('Payment differs from the independently approved corporate content');
    return fixed;
  };
  const current = async () => {
    const value = await verifyCorporatePayment(await client.request(base), selected.payload.organizationId);
    if (value.contentHash !== selected.contentHash || canonical(value.payload) !== canonical(selected.payload) || !value.approvalValid || value.state !== 'approved' || Date.now() >= Date.parse(value.payload.expiresAt)) throw new Error('Independent corporate approval is unavailable or no longer current');
    return value;
  };
  return {
    async beforeImport(payment,payer) { await bind({payment:payment.payment,payer,policy:selected.payload.content.policy}); await current(); },
    async beforeSubmit(operation,review) {
      await bind(operation);
      if (review.kind === 'retry' || review.kind === 'refund') return () => {};
      await current(); const checked = Date.now();
      return () => { if (Date.now() < checked || Date.now()-checked > 15000 || Date.now() >= Date.parse(selected.payload.expiresAt)) throw new Error('Corporate approval check expired; review again'); };
    },
    async beforeDispatch(operation,review) {
      await bind(operation);
      if (review.kind === 'retry' || review.kind === 'refund') return;
      if (!review.call || !review.callHash || !['payment','prerequisite'].includes(review.kind ?? '')) throw new Error('Unsupported corporate dispatch');
      const permit = await client.request<{ contentHash:string;callHash:string;expiresAt:string }>(base+'/authorize','POST',{ contentHash:selected.contentHash,kind:review.kind,call:review.call });
      if (permit.contentHash !== selected.contentHash || permit.callHash !== review.callHash || Date.now() >= Date.parse(permit.expiresAt) || Date.parse(permit.expiresAt) > Date.now()+16000 || !Number.isFinite(Date.parse(permit.expiresAt))) throw new Error('Invalid corporate dispatch authorization');
    },
  };
}
