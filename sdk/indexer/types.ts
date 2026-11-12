import { z } from "zod";
import { AccountId, Count } from "../validation.js";
import { RecordSchema, type ChainRecord } from "../evidence.js";
import type { FinalBlock, OperationsSource } from "../operations.js";
export const Hash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
export const IndexTxRef = z.object({ hash: Hash, signer: AccountId }).strict();
export type IndexTxRef = z.infer<typeof IndexTxRef>;
export const Kinds = z.enum([
  "deposit",
  "transfer",
  "withdrawal_requested",
  "withdrawal_failed",
  "withdrawal_retried",
  "withdrawal_succeeded",
]);
export const FinalBlockSchema = z
  .object({ hash: Hash, height: Count })
  .strict();
export const CheckpointSchema = z
  .object({
    block: FinalBlockSchema,
    nextIndex: Count,
    sourceRecordCount: Count,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((c) => c.nextIndex <= c.sourceRecordCount);
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const ActivityQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(1024).optional(),
    kind: Kinds.optional(),
    vault: AccountId.optional(),
    recipient: AccountId.optional(),
    nullifier: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(77)
      .optional(),
    commitment: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(77)
      .optional(),
  })
  .strict();
export type ActivityQuery = z.input<typeof ActivityQuery>;
export const ProvenanceSchema = z
  .object({
    transaction: IndexTxRef,
    outerOutcome: z.enum(["succeeded", "failed"]),
    receipts: z
      .array(z.object({ id: Hash, blockHash: Hash }).strict())
      .min(1)
      .max(50),
    verifiedAt: FinalBlockSchema,
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ActivityItem = {
  record: ChainRecord;
  observedAt: FinalBlock;
  provenance: Provenance | null;
};
export interface IndexSource extends OperationsSource {
  blockAt(height: number): Promise<FinalBlock>;
}
export class IndexError extends Error {
  constructor(
    readonly code:
      | "FINALITY_CONFLICT"
      | "STALE_FINALITY"
      | "INDEX_CONFLICT"
      | "RECORD_MISMATCH"
      | "INVALID_CURSOR"
      | "INDEX_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "IndexError";
  }
}
export function sharedRecord(
  input: unknown,
  tokenId: string | undefined,
  denomination: string,
): ChainRecord {
  const r = RecordSchema.parse(input);
  Count.parse(r.index);
  Count.parse(r.block_height);
  Kinds.parse(r.kind);
  if (
    r.amount !== denomination ||
    (r.asset_token_id ?? undefined) !== tokenId ||
    r.vault === undefined ||
    r.protocol_fee_charged === undefined
  )
    throw new IndexError(
      "RECORD_MISMATCH",
      "Wrong shared record asset or accounting fields",
    );
  const scalar = z
    .string()
    .max(77)
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine(
      (v) =>
        BigInt(v) <
        21888242871839275222246405745257275088548364400416034343698204186575808495617n,
    );
  if (r.commitment !== null) scalar.parse(r.commitment);
  if (r.nullifier !== null) scalar.parse(r.nullifier);
  if (r.vault !== null) AccountId.parse(r.vault);
  if (r.recipient !== null) AccountId.parse(r.recipient);
  const deposit = r.kind === "deposit",
    transfer = r.kind === "transfer";
  if (
    deposit
      ? r.commitment === null ||
        r.nullifier !== null ||
        r.vault === null ||
        r.recipient !== null
      : transfer
        ? r.commitment === null ||
          r.nullifier === null ||
          r.vault !== null ||
          r.recipient !== null
        : r.commitment !== null ||
          r.nullifier === null ||
          r.vault === null ||
          r.recipient === null
  )
    throw new IndexError("RECORD_MISMATCH", "Invalid record action bindings");
  const fee = ((BigInt(denomination) * 15n) / 10000n).toString(),
    charged = ["deposit", "withdrawal_requested"].includes(r.kind) ? fee : "0",
    earned = ["deposit", "withdrawal_succeeded"].includes(r.kind) ? fee : "0",
    storage = [
      "deposit",
      "transfer",
      "withdrawal_requested",
      "withdrawal_retried",
    ].includes(r.kind)
      ? "20000000000000000000000"
      : "0";
  if (
    r.protocol_fee_charged !== charged ||
    r.protocol_fee_earned !== earned ||
    r.storage_fee_charged !== storage
  )
    throw new IndexError(
      "RECORD_MISMATCH",
      "Record fees differ from the pinned protocol",
    );
  return r;
}
