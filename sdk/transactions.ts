import { z } from "zod";
import { canonical } from "./client/crypto.js";
import { parseCall, preparedPayment } from "./client/payment.js";
import { transactionRef } from "./client/journal.js";
import type { Call, TxRef, Verification } from "./client/types.js";
import type { OperationsSource } from "./operations.js";
import type { SharedPolicy } from "./shared.js";
import { AccountId, Atomic } from "./validation.js";
const scalar = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(77);
const base = {
  contract: AccountId,
  attachedYoctoNear: Atomic,
  gas: z.literal("300000000000000"),
};
const callSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...base,
      method: z.literal("ft_transfer_call"),
      args: z
        .object({
          receiver_id: AccountId,
          amount: Atomic,
          msg: z.string().max(4096),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("storage_deposit"),
      args: z
        .object({ account_id: AccountId, registration_only: z.literal(true) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("prepay_storage"),
      args: z.object({ account_id: AccountId }).strict(),
    })
    .strict(),
  ...(["retry_deposit", "claim_deposit_refund"] as const).map((method) =>
    z
      .object({
        ...base,
        method: z.literal(method),
        args: z.object({ commitment: scalar }).strict(),
      })
      .strict(),
  ),
  z
    .object({
      ...base,
      method: z.literal("retry_withdrawal"),
      args: z.object({ nullifier: scalar }).strict(),
    })
    .strict(),
]);
export const VerifyTransactionInput = z
  .object({
    transaction: z
      .object({
        hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
        signer: AccountId,
      })
      .strict(),
    call: callSchema,
  })
  .strict();
/** Public, read-only transaction equality check. Never treats a failed outer FT transaction as a safe refund. */
export async function verifyTransaction(
  source: OperationsSource,
  policy: SharedPolicy,
  transaction: TxRef,
  input: Call,
): Promise<Verification> {
  const parsed = VerifyTransactionInput.parse({ transaction, call: input }),
    tx = transactionRef(parsed.transaction),
    call = parseCall(parsed.call);
  if (source.network !== policy.network || source.factory !== policy.registry)
    throw new Error("Wrong transaction source");
  if (call.method === "ft_transfer_call") {
    const prepared = await preparedPayment(
      { tokenCall: call },
      policy,
      tx.signer,
    );
    if (canonical(prepared.payment) !== canonical(call))
      throw new Error("Use the canonical reviewed FT plan");
  } else if (
    ![policy.tokenId, policy.registry].includes(call.contract) &&
    !new RegExp(
      `^v[a-f0-9]{32}\\.${policy.registry.replaceAll(".", "\\.")}$`,
    ).test(call.contract)
  )
    throw new Error("Transaction is outside this group");
  if (!source.transaction)
    throw new Error("Transaction verification is unavailable");
  const raw = await source.transaction(tx.hash, tx.signer);
  if (raw === null) return { status: "pending" };
  const r = z
    .object({
      final_execution_status: z.string(),
      transaction: z.object({
        hash: z.string(),
        signer_id: AccountId,
        receiver_id: AccountId,
        actions: z.array(z.unknown()),
      }),
      status: z.unknown(),
    })
    .parse(raw);
  if (
    r.transaction.hash !== tx.hash ||
    r.transaction.signer_id !== tx.signer ||
    r.transaction.receiver_id !== call.contract ||
    r.transaction.actions.length !== 1
  )
    throw new Error(
      "Transaction does not match the reviewed signer and receiver",
    );
  const action = z
    .object({
      FunctionCall: z
        .object({
          method_name: z.string(),
          args: z.string(),
          deposit: z.string(),
          gas: z.union([z.string(), z.number().int().nonnegative()]),
        })
        .strict(),
    })
    .strict()
    .parse(r.transaction.actions[0]).FunctionCall;
  if (
    action.method_name !== call.method ||
    action.deposit !== call.attachedYoctoNear ||
    String(action.gas) !== call.gas ||
    canonical(
      JSON.parse(Buffer.from(action.args, "base64").toString("utf8")),
    ) !== canonical(call.args)
  )
    throw new Error("Transaction actions do not match the reviewed call");
  if (r.final_execution_status !== "FINAL") return { status: "pending" };
  let effect: "accepted" | "not-accepted" | "unknown" = "unknown";
  if (
    r.status &&
    typeof r.status === "object" &&
    "SuccessValue" in r.status &&
    typeof r.status.SuccessValue === "string"
  ) {
    if (call.method === "ft_transfer_call") {
      try {
        const used: unknown = JSON.parse(
          Buffer.from(r.status.SuccessValue, "base64").toString("utf8"),
        );
        if (used === call.args.amount) effect = "accepted";
        else if (used === "0") effect = "not-accepted";
      } catch {
        /* Resolver outcome is unknown; do not resend. */
      }
    } else effect = "accepted";
  }
  return { status: "final", effect, transaction: tx };
}
