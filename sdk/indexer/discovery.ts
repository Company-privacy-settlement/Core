import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical } from "../client/crypto.js";
import { Count } from "../validation.js";
import type { IndexStore } from "./store.js";
import {
  FinalBlockSchema,
  Hash,
  IndexError,
  IndexTxRef,
  type IndexSource,
} from "./types.js";
export const DiscoveryState = z
  .object({
    version: z.literal(1),
    startHeight: Count,
    lastComplete: FinalBlockSchema.nullable(),
    current: z
      .object({
        block: FinalBlockSchema,
        previousHash: Hash,
        offset: Count,
        total: Count,
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    scannedTransactions: Count,
    candidatesFound: Count,
    updatedAt: z.string().datetime(),
    blocked: z
      .enum([
        "TRANSACTION_NOT_FINAL",
        "RECEIPTS_INCOMPLETE",
        "TRANSACTION_READ_FAILED",
        "BLOCK_UNAVAILABLE",
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (s) =>
      (!s.current ||
        (s.current.offset <= s.current.total &&
          s.current.block.height >= s.startHeight &&
          (!s.lastComplete ||
            s.current.block.height > s.lastComplete.height))) &&
      (!s.lastComplete || s.lastComplete.height >= s.startHeight),
    "Invalid discovery cursor",
  );
export type DiscoveryState = z.infer<typeof DiscoveryState>;
export type ScanBlock = {
  block: z.infer<typeof FinalBlockSchema>;
  previousHash: string;
  transactions: IndexTxRef[];
};
export interface DiscoverySource extends IndexSource {
  scanBlock(height: number): Promise<ScanBlock | null>;
}
const digest = (refs: IndexTxRef[]) =>
  createHash("sha256").update(canonical(refs)).digest("hex");

/** Scan all transactions, including wrapper-originated calls. Never infer absence from an incomplete receipt graph. */
export class TransactionDiscovery {
  constructor(
    readonly source: DiscoverySource,
    readonly store: IndexStore,
  ) {
    if (
      source.network !== store.policy.network ||
      source.factory !== store.policy.registry
    )
      throw new Error("Discovery source differs from policy");
  }
  async scan(options: {
    startHeight: number;
    maxBlocks?: number;
    maxTransactions?: number;
    signal?: AbortSignal;
  }) {
    const start = Count.parse(options.startHeight),
      maxBlocks = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(options.maxBlocks ?? 10),
      maxTransactions = z
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(options.maxTransactions ?? 100);
    let state = this.store.discovery();
    if (state && state.startHeight !== start)
      throw new IndexError(
        "INDEX_CONFLICT",
        "Discovery start is fixed for this database",
      );
    const cp = this.store.checkpoint();
    if (!cp)
      throw new IndexError(
        "INDEX_NOT_READY",
        "Sync the verified registry journal before discovery",
      );
    options.signal?.throwIfAborted();
    const head = FinalBlockSchema.parse(await this.source.finalBlock()),
      anchor = FinalBlockSchema.parse(
        await this.source.blockAt(cp.block.height),
      );
    if (head.height < cp.block.height)
      throw new IndexError(
        "STALE_FINALITY",
        "Discovery provider is behind the registry checkpoint",
      );
    if (
      anchor.hash !== cp.block.hash ||
      anchor.height !== cp.block.height ||
      (head.height === cp.block.height && head.hash !== cp.block.hash)
    )
      throw new IndexError(
        "FINALITY_CONFLICT",
        "Registry checkpoint changed before discovery",
      );
    if (!state) {
      state = {
        version: 1,
        startHeight: start,
        lastComplete: null,
        current: null,
        scannedTransactions: 0,
        candidatesFound: 0,
        updatedAt: new Date().toISOString(),
        blocked: null,
      };
      this.store.advanceDiscovery(null, state);
    }
    if (state.lastComplete) {
      const old = FinalBlockSchema.parse(
        await this.source.blockAt(state.lastComplete.height),
      );
      if (canonical(old) !== canonical(state.lastComplete))
        throw new IndexError(
          "FINALITY_CONFLICT",
          "Discovery checkpoint changed",
        );
    }
    let processed = 0,
      completed = 0;
    const persist = (next: DiscoveryState, refs: IndexTxRef[] = []) => {
      options.signal?.throwIfAborted();
      this.store.advanceDiscovery(state, next, refs);
      state = next;
    };
    const blocked = (code: DiscoveryState["blocked"]) => {
      persist({
        ...state!,
        blocked: code,
        updatedAt: new Date().toISOString(),
      });
      return { processed, completed, state: state! };
    };
    while (completed < maxBlocks && processed < maxTransactions) {
      options.signal?.throwIfAborted();
      let scan: ScanBlock | null = null;
      if (state.current) {
        scan = await this.source.scanBlock(state.current.block.height);
        if (!scan) return blocked("BLOCK_UNAVAILABLE");
        if (
          canonical(scan.block) !== canonical(state.current.block) ||
          scan.previousHash !== state.current.previousHash ||
          scan.transactions.length !== state.current.total ||
          digest(scan.transactions) !== state.current.digest
        )
          throw new IndexError(
            "FINALITY_CONFLICT",
            "A finalized chunk transaction list changed",
          );
      } else {
        const height = state.lastComplete
          ? state.lastComplete.height + 1
          : start;
        if (height > cp.block.height) break;
        // UNKNOWN_BLOCK can mean a legitimate skipped height or pruned history. A later parent link must prove any gap.
        for (let h = height; h <= Math.min(cp.block.height, height + 63); h++) {
          scan = await this.source.scanBlock(h);
          if (scan) break;
          if (!state.lastComplete) break;
        }
        if (!scan) return blocked("BLOCK_UNAVAILABLE");
        if (state.lastComplete && scan.previousHash !== state.lastComplete.hash)
          throw new IndexError(
            "FINALITY_CONFLICT",
            "Missing canonical block between discovery checkpoints; use archival data",
          );
        if (
          scan.block.height > cp.block.height ||
          (scan.block.height === cp.block.height &&
            scan.block.hash !== cp.block.hash)
        )
          throw new IndexError(
            "FINALITY_CONFLICT",
            "Discovery block differs from the verified upper checkpoint",
          );
        persist({
          ...state,
          current: {
            block: scan.block,
            previousHash: scan.previousHash,
            offset: 0,
            total: scan.transactions.length,
            digest: digest(scan.transactions),
          },
          blocked: null,
          updatedAt: new Date().toISOString(),
        });
      }
      if (
        scan.block.height > cp.block.height ||
        (scan.block.height === cp.block.height &&
          scan.block.hash !== cp.block.hash)
      )
        throw new IndexError(
          "FINALITY_CONFLICT",
          "Discovery block differs from the verified upper checkpoint",
        );
      for (
        let i = state.current!.offset;
        i < scan.transactions.length && processed < maxTransactions;
        i++
      ) {
        options.signal?.throwIfAborted();
        const ref = scan.transactions[i];
        let input: unknown;
        try {
          if (!this.source.transaction)
            throw new Error("Transaction lookup unavailable");
          input = await this.source.transaction(ref.hash, ref.signer);
        } catch {
          return blocked("TRANSACTION_READ_FAILED");
        }
        if (
          !input ||
          (input as { final_execution_status?: unknown })
            .final_execution_status !== "FINAL"
        )
          return blocked("TRANSACTION_NOT_FINAL");
        const tx = z
          .object({
            transaction: z.object({
              hash: z.literal(ref.hash),
              signer_id: z.literal(ref.signer),
            }),
            transaction_outcome: z.object({
              outcome: z.object({ receipt_ids: z.array(Hash).max(10000) }),
            }),
            receipts_outcome: z
              .array(
                z.object({
                  id: Hash,
                  outcome: z.object({
                    executor_id: z.string(),
                    receipt_ids: z.array(Hash).max(10000),
                    logs: z.array(z.string().max(65536)).max(10000),
                  }),
                }),
              )
              .max(10000),
          })
          .parse(input);
        const byId = new Map(tx.receipts_outcome.map((r) => [r.id, r]));
        if (byId.size !== tx.receipts_outcome.length)
          throw new IndexError("RECORD_MISMATCH", "Duplicate receipt outcomes");
        const visited = new Set<string>(),
          pending = [...tx.transaction_outcome.outcome.receipt_ids];
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          const receipt = byId.get(id);
          if (!receipt) return blocked("RECEIPTS_INCOMPLETE");
          visited.add(id);
          pending.push(...receipt.outcome.receipt_ids);
        }
        if (visited.size !== byId.size) return blocked("RECEIPTS_INCOMPLETE");
        const relevant = tx.receipts_outcome.some(
          (r) =>
            r.outcome.executor_id === this.store.policy.registry &&
            r.outcome.logs.some((l) => {
              if (!l.startsWith("EVENT_JSON:")) return false;
              try {
                const e = JSON.parse(l.slice(11));
                return (
                  e.standard === "core_shared" &&
                  e.version ===
                    (this.store.policy.tokenId ? "3.0.0" : "2.0.0") &&
                  Array.isArray(e.data) &&
                  e.data.some(
                    (v: unknown) =>
                      !!v && typeof v === "object" && Object.hasOwn(v, "index"),
                  )
                );
              } catch {
                return false;
              }
            }),
        );
        persist(
          {
            ...state,
            current: { ...state.current!, offset: i + 1 },
            scannedTransactions: state.scannedTransactions + 1,
            candidatesFound: state.candidatesFound + (relevant ? 1 : 0),
            blocked: null,
            updatedAt: new Date().toISOString(),
          },
          relevant ? [ref] : [],
        );
        processed++;
      }
      if (state.current!.offset === scan.transactions.length) {
        persist({
          ...state,
          lastComplete: scan.block,
          current: null,
          blocked: null,
          updatedAt: new Date().toISOString(),
        });
        completed++;
      }
    }
    return { processed, completed, state };
  }
}
