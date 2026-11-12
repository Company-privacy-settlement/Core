import { createHash } from "node:crypto";
import bs58 from "bs58";
import { operationsFixture } from "./operations.js";
import type { IndexSource } from "../../sdk/indexer/types.js";
import type { ChainRecord } from "../../sdk/evidence.js";
export function blockHash(height: number) {
  return bs58.encode(createHash("sha256").update(`block:${height}`).digest());
}
export function indexFixture(native = false) {
  const f = operationsFixture(native),
    records: ChainRecord[] = [],
    transactions = new Map<string, unknown>();
  function record(
    index: number,
    changes: Partial<ChainRecord> = {},
  ): ChainRecord {
    return {
      index,
      kind: "deposit",
      commitment: String(index + 1),
      nullifier: null,
      vault: f.vault,
      recipient: null,
      disclosure_root: "ab".repeat(32),
      block_height: 10,
      timestamp_ns: "10000000000",
      amount: f.policy.denomination,
      asset_token_id: f.policy.tokenId ?? null,
      protocol_fee_charged: (
        (BigInt(f.policy.denomination) * 15n) /
        10000n
      ).toString(),
      protocol_fee_earned: (
        (BigInt(f.policy.denomination) * 15n) /
        10000n
      ).toString(),
      storage_fee_charged: "20000000000000000000000",
      ...changes,
    };
  }
  const config = f.source.config,
    view = f.source.contractView;
  const source: IndexSource = {
    ...f.source,
    finalBlock: async () => ({
      hash: blockHash(f.state.height),
      height: f.state.height,
    }),
    blockAt: async (height) => ({ hash: blockHash(height), height }),
    config: async (b) => ({
      ...((await config(b)) as object),
      record_count: records.length,
    }),
    contractView: async (a, m, args, b) =>
      m === "get_records"
        ? records.slice(
            Number(args.from_index),
            Number(args.from_index) + Number(args.limit),
          )
        : view(a, m, args, b),
    transaction: async (hash) => transactions.get(hash) ?? null,
  };
  const ref = {
    hash: bs58.encode(createHash("sha256").update("transaction").digest()),
    signer: f.payer,
  };
  function transaction(selected = records) {
    return {
      final_execution_status: "FINAL",
      transaction: { hash: ref.hash, signer_id: ref.signer },
      status: { SuccessValue: "" },
      receipts_outcome: selected.map((r) => ({
        id: bs58.encode(
          createHash("sha256").update(`receipt:${r.index}`).digest(),
        ),
        block_hash: blockHash(r.block_height),
        outcome: {
          executor_id: f.policy.registry,
          status: { SuccessValue: "" },
          logs: [
            `EVENT_JSON:${JSON.stringify({ standard: "core_shared", version: native ? "2.0.0" : "3.0.0", event: r.kind, data: [r] })}`,
          ],
        },
      })),
    };
  }
  return { ...f, source, records, record, ref, transaction, transactions };
}
