import { z } from "zod";
import { AccountId, Count, Sha256 } from "./validation.js";
import { canonical, sha256 } from "./client/crypto.js";
import {
  verifyInvoiceProofSignature,
  invoiceRootsFromHash,
  type InvoiceProof,
  type InvoiceStatus,
} from "./client/invoices.js";
import { RecordSchema } from "./evidence.js";
import type { OperationsSource } from "./operations.js";
import type { SharedPolicy } from "./shared.js";
import type { ActivityReader } from "./indexer/store.js";
import { IndexError } from "./indexer/types.js";
export const InvoiceProofInput = z
  .object({
    invoiceHash: Sha256,
    merchantAccount: AccountId,
    nonce: Sha256,
    publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const invoiceLookup = {
  invoiceHash: Sha256, recipient: AccountId, units: z.number().int().min(1).max(32), expiresAt: z.string().datetime(),
};
export const InvoiceStatusInput = z.union([
  z.object(invoiceLookup).strict(),
  z.object({ ...invoiceLookup, version: z.literal(2), paymentNonces: z.array(Sha256).min(1).max(32) }).strict()
    .refine(r => r.paymentNonces.length === r.units && new Set(r.paymentNonces).size === r.units, "Distinct payment nonces must match units"),
]);
export async function verifyInvoiceMerchant(
  source: OperationsSource,
  policy: SharedPolicy,
  input: InvoiceProof,
) {
  if (source.network !== policy.network || source.factory !== policy.registry)
    throw new Error("Invoice verification source differs from policy");
  const proof = InvoiceProofInput.parse(input);
  if (!(await verifyInvoiceProofSignature(proof, policy.network)))
    return { verified: false, reason: "SIGNATURE_INVALID" as const };
  const checkedAt = z
    .object({ hash: z.string().min(1), height: Count })
    .parse(await source.finalBlock());
  const keys = z
    .array(
      z.object({
        public_key: z.string(),
        access_key: z.object({ permission: z.unknown() }),
      }),
    )
    .parse(await source.accessKeys(proof.merchantAccount, checkedAt.hash));
  const verified = keys.some(
    (k) =>
      k.public_key === proof.publicKey &&
      k.access_key.permission === "FullAccess",
  );
  return {
    verified,
    reason: verified ? null : "FULL_ACCESS_KEY_NOT_CURRENT",
    merchantAccount: proof.merchantAccount,
    invoiceHash: proof.invoiceHash,
    checkedAt,
    claims: { legalIdentityVerified: false, kybVerified: false },
  };
}
export async function indexedInvoiceStatus(
  index: ActivityReader,
  policy: SharedPolicy,
  input: z.infer<typeof InvoiceStatusInput>,
  now = Date.now(),
): Promise<InvoiceStatus> {
  const request = InvoiceStatusInput.parse(input);
  if (canonical(index.policy) !== canonical(policy))
    throw new Error("Invoice index policy mismatch");
  const scoped = "version" in request && request.version === 2,
    roots = scoped ? await invoiceRootsFromHash(request.invoiceHash, request.paymentNonces) : [await sha256("core:invoice:settlement:v1|" + request.invoiceHash)],
    rootSet = new Set(roots),
    seen = new Set<string>(),
    confirmations: InvoiceStatus["confirmations"] = [];
  let cursor: string | undefined,
    checkedAt: InvoiceStatus["checkedAt"] | undefined,
    limited = false,
    late = 0n;
  for (let page = 0; page < 20; page++) {
    const result = z
      .object({
        items: z
          .array(z.object({ record: RecordSchema, provenance: z.unknown() }))
          .max(50),
        nextCursor: z.string().nullable(),
        index: z.object({
          checkpoint: z
            .object({
              block: z.object({ hash: z.string(), height: Count }),
              nextIndex: Count,
              sourceRecordCount: Count,
              updatedAt: z.string().datetime(),
            })
            .nullable(),
        }),
      })
      .parse(
        index.activity({
          kind: "withdrawal_succeeded",
          recipient: request.recipient,
          ...(!scoped ? { disclosure_root: roots[0] } : {}),
          limit: 50,
          ...(cursor ? { cursor } : {}),
        }),
      );
    if (!result.index.checkpoint)
      throw new IndexError("INDEX_NOT_READY", "Invoice index has not synced");
    if (!checkedAt) {
      checkedAt = {
        ...result.index.checkpoint.block,
        updatedAt: result.index.checkpoint.updatedAt,
      };
      limited =
        result.index.checkpoint.nextIndex <
        result.index.checkpoint.sourceRecordCount;
    }
    for (const item of result.items) {
      const r = item.record;
      if (
        r.kind !== "withdrawal_succeeded" ||
        r.recipient !== request.recipient ||
        (!scoped && r.disclosure_root !== roots[0]) ||
        r.amount !== policy.denomination ||
        (r.asset_token_id ?? undefined) !== policy.tokenId ||
        !r.nullifier
      )
        throw new Error("Invoice confirmation binding mismatch");
      if (!rootSet.has(r.disclosure_root)) continue;
      if (seen.has(r.nullifier)) continue;
      seen.add(r.nullifier);
      const paidLate =
        BigInt(r.timestamp_ns) >=
        BigInt(Date.parse(request.expiresAt)) * 1000000n;
      if (paidLate) late += BigInt(policy.denomination);
      const transaction = item.provenance
        ? z
            .object({
              transaction: z.object({ hash: z.string(), signer: AccountId }),
            })
            .parse(item.provenance).transaction
        : null;
      confirmations.push({
        ...(scoped ? { settlementRoot: r.disclosure_root } : {}),
        recordIndex: r.index,
        nullifier: r.nullifier,
        blockHeight: r.block_height,
        late: paidLate,
        transaction,
      });
    }
    if (result.nextCursor === null) break;
    if (page === 19) {
      limited = true;
      break;
    }
    if (result.nextCursor === cursor)
      throw new Error("Invoice pagination repeated");
    cursor = result.nextCursor;
  }
  const paid = BigInt(seen.size) * BigInt(policy.denomination),
    expected = BigInt(request.units) * BigInt(policy.denomination),
    expired = now >= Date.parse(request.expiresAt);
  const state: InvoiceStatus["state"] = limited
    ? "review_required"
    : paid > expected
      ? "overpaid"
      : paid === expected
        ? late > 0n
          ? "paid_late"
          : "paid"
        : paid > 0n
          ? expired
            ? "partial_expired"
            : "partial"
          : expired
            ? "expired"
            : "awaiting_payment";
  return {
    invoiceHash: request.invoiceHash,
    settlementRoot: scoped ? null : roots[0],
    ...(scoped ? { settlementRoots: roots, reusedPaymentReferences: confirmations.length - new Set(confirmations.map(c => c.settlementRoot)).size } : {}),
    state,
    expectedTokens: expected.toString(),
    paidTokens: paid.toString(),
    remainingTokens: (paid < expected ? expected - paid : 0n).toString(),
    overpaidTokens: (paid > expected ? paid - expected : 0n).toString(),
    lateTokens: late.toString(),
    confirmedPayments: seen.size,
    coverageLimited: limited,
    checkedAt: checkedAt!,
    chainFreshnessChecked: false,
    confirmations,
  };
}
