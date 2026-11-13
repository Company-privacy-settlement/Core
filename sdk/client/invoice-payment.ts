import { canonical } from './crypto.js';
import { parsePolicy } from './payment.js';
import { noteHash, validatePrivateNote, type PrivateNote } from './notes.js';
import { assertInvoiceReferenceAvailable, invoicePaymentRoots, invoiceRoot, matchInvoicePlan, parseSignedInvoice, requireOpenInvoice, verifySignedInvoice, type SignedInvoice, type InvoiceStatus } from './invoices.js';
import { parseProofBundle, parseProvingContext, type BrowserProver, type ProofBundle, type ProvingAssets, type ProvingContext, type ProverStage } from './prover.js';
import type { SettlementGuards } from './session.js';
import type { Operation, Policy, Reference } from './types.js';

export interface InvoicePaymentGateway {
  invoiceStatus(invoice: SignedInvoice, options?: { signal?: AbortSignal }): Promise<InvoiceStatus>;
  provingContext(policy: Policy, vault: string, options?: { signal?: AbortSignal }): Promise<ProvingContext>;
}
function copy(input: SignedInvoice): SignedInvoice { return JSON.parse(canonical(parseSignedInvoice(input))); }
function reference(root: string, signed: SignedInvoice, value: Reference) {
  if (value.kind !== 'withdrawal' || value.expectedRecipient !== signed.invoice.recipient || value.expectedDisclosureRoot !== root) throw new Error('Payment is not bound to the selected invoice unit');
}
function localAvailability(signed: SignedInvoice, root: string, nullifier: string, operations: readonly Operation[], except?: string, reuseExact = false) {
  for (const operation of operations) {
    if (operation.id === except || canonical(operation.policy) !== canonical(signed.invoice.policy) || operation.reference.kind !== 'withdrawal') continue;
    const old = operation.reference;
    const exact = old.nullifier === nullifier && old.expectedRecipient === signed.invoice.recipient && old.expectedDisclosureRoot === root;
    if (exact && reuseExact) continue;
    if (old.nullifier === nullifier) throw new Error('This note already has a local withdrawal. Reconcile the existing operation; do not spend it again.');
    if (old.expectedRecipient === signed.invoice.recipient && old.expectedDisclosureRoot === root && (signed.invoice.version === 2 || operation.outcome === 'open')) throw new Error('This invoice unit already has a local payment. Reconcile that operation before selecting another note.');
  }
}
async function available(gateway: Pick<InvoicePaymentGateway, 'invoiceStatus'>, signed: SignedInvoice, root: string, signal?: AbortSignal) {
  signal?.throwIfAborted(); requireOpenInvoice(signed.invoice);
  // The gateway must verify the current merchant key. Validate the returned
  // totals/reference set again rather than accepting a status flag alone.
  const status = await gateway.invoiceStatus(copy(signed), { signal }); signal?.throwIfAborted();
  await assertInvoiceReferenceAvailable(signed.invoice, root, status); signal?.throwIfAborted(); requireOpenInvoice(signed.invoice);
  if (!['awaiting_payment', 'partial'].includes(status.state) || BigInt(status.remainingTokens) < BigInt(signed.invoice.policy.denomination)) throw new Error('This invoice is already covered or needs merchant review');
  return status;
}
/** Cryptographic invoice/selected-unit binding for a locally verified proof. */
export async function matchInvoiceProof(raw: ProofBundle, input: SignedInvoice, paymentIndex: number, payer: string) {
  const signed = await verifySignedInvoice(copy(input)), bundle = await parseProofBundle(raw, signed.invoice.policy);
  const prepared = await matchInvoicePlan(bundle.plan, signed.invoice, payer, paymentIndex);
  const root = await invoiceRoot(signed.invoice, paymentIndex);
  reference(root, signed, prepared.reference);
  if (bundle.action.recipient !== signed.invoice.recipient || bundle.action.disclosureRoot !== root) throw new Error('Proof does not match the selected signed invoice unit');
  return { bundle, prepared, root };
}
/** No journal writes or wallet calls: note → public snapshot → local proof. */
export async function prepareInvoiceProof(
  prover: Pick<BrowserProver, 'prove'>, gateway: InvoicePaymentGateway, input: SignedInvoice, paymentIndex: number,
  rawNote: PrivateNote, assets: ProvingAssets, vault: string,
  options: { signal?: AbortSignal; onProgress?: (stage: ProverStage) => void; getOperations?: () => Promise<readonly Operation[]> } = {},
) {
  const signed = await verifySignedInvoice(copy(input)); options.signal?.throwIfAborted();
  const policy = parsePolicy(signed.invoice.policy), root = await invoiceRoot(signed.invoice, paymentIndex), note = await validatePrivateNote(policy, rawNote);
  const nullifier = noteHash([note.nullifier, note.domain]); options.signal?.throwIfAborted();
  if (options.getOperations) localAvailability(signed, root, nullifier, await options.getOperations());
  await available(gateway, signed, root, options.signal);
  const context = parseProvingContext(await gateway.provingContext(parsePolicy(policy), vault, { signal: options.signal }), policy);
  options.signal?.throwIfAborted();
  if (context.vault !== vault) throw new Error('API substituted the selected payout vault');
  const action = { recipient: signed.invoice.recipient, disclosureRoot: root };
  const result = await prover.prove({ policy, note, context, action }, assets, { signal: options.signal, onProgress: options.onProgress });
  options.signal?.throwIfAborted();
  const matched = await matchInvoiceProof(result.bundle, signed, paymentIndex, signed.invoice.recipient); options.signal?.throwIfAborted();
  if (matched.bundle.spend.public_inputs[0] !== nullifier || matched.bundle.spend.public_inputs[2] !== context.root) throw new Error('Prover returned a different note or group root');
  await available(gateway, signed, root, options.signal);
  if (options.getOperations) localAvailability(signed, root, nullifier, await options.getOperations());
  options.signal?.throwIfAborted();
  return result;
}
/** Install on the settlement session so imports and every signature share the gates. */
export function invoiceSettlementGuards(gateway: Pick<InvoicePaymentGateway, 'invoiceStatus'>, input: SignedInvoice): SettlementGuards {
  const signed = copy(input);
  const binding = async (value: Reference) => {
    const roots = await invoicePaymentRoots(signed.invoice), root = value.kind === 'withdrawal' ? value.expectedDisclosureRoot : undefined;
    if (!root || !roots.includes(root)) throw new Error('Operation is not bound to this signed invoice');
    reference(root, signed, value); return root;
  };
  return {
    async beforeImport(payment, _payer, operations) {
      await verifySignedInvoice(copy(signed));
      const root = await binding(payment.reference);
      if (payment.reference.kind !== 'withdrawal') throw new Error('Invoice requires a withdrawal');
      localAvailability(signed, root, payment.reference.nullifier, operations, undefined, true);
      await available(gateway, signed, root);
    },
    async beforeSubmit(operation, review, operations) {
      const root = await binding(operation.reference);
      if (operation.reference.kind !== 'withdrawal') throw new Error('Invoice requires a withdrawal');
      // Already accepted funds must retain their original fixed-destination
      // retry/refund path even if invoice terms expire or the issuer rotates keys.
      if (review.kind === 'retry' || review.kind === 'refund') return () => {};
      await verifySignedInvoice(copy(signed));
      localAvailability(signed, root, operation.reference.nullifier, operations, operation.id);
      await available(gateway, signed, root);
      const checked = Date.now();
      return () => {
        requireOpenInvoice(signed.invoice);
        const age = Date.now() - checked;
        if (age < 0 || age > 15000) throw new Error('Invoice authorization is stale. Refresh and review before signing.');
        reference(root, signed, operation.reference);
      };
    },
  };
}
