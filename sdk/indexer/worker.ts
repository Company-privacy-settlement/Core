import { z } from "zod";
import { canonical } from "../client/crypto.js";
import { Count } from "../validation.js";
import { discoverSharedVaults, type SharedChainSource } from "../shared.js";
import { recordFingerprint } from "../evidence.js";
import { IndexStore } from "./store.js";
import {
  FinalBlockSchema,
  Hash,
  IndexError,
  IndexTxRef,
  sharedRecord,
  type Checkpoint,
  type IndexSource,
  type Provenance,
} from "./types.js";

export class SettlementIndexer {
  constructor(
    readonly source: IndexSource,
    readonly store: IndexStore,
  ) {
    if (
      source.network !== store.policy.network ||
      source.factory !== store.policy.registry
    )
      throw new Error("Index source and policy differ");
  }
  async sync(options: { maxPages?: number; signal?: AbortSignal } = {}) {
    const maxPages = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(options.maxPages ?? 10),
      signal = options.signal,
      policy = this.store.policy;
    signal?.throwIfAborted();
    const block = FinalBlockSchema.parse(await this.source.finalBlock());
    let checkpoint = this.store.checkpoint();
    if (checkpoint) {
      if (block.height < checkpoint.block.height)
        throw new IndexError(
          "STALE_FINALITY",
          "RPC final head is behind the durable checkpoint",
        );
      const canonical = FinalBlockSchema.parse(
        await this.source.blockAt(checkpoint.block.height),
      );
      if (
        canonical.height !== checkpoint.block.height ||
        canonical.hash !== checkpoint.block.hash ||
        (block.height === checkpoint.block.height &&
          block.hash !== checkpoint.block.hash)
      )
        throw new IndexError(
          "FINALITY_CONFLICT",
          "Previously finalized checkpoint changed; preserve the database and investigate",
        );
    }
    const pinned: SharedChainSource = {
      network: this.source.network,
      factory: this.source.factory,
      finalizedBlock: async () => block.hash,
      config: (b) => this.source.config(b),
      records: (f, l, b) => this.source.records(f, l, b),
      vaultConfig: (a, b) => this.source.vaultConfig(a, b),
      codeSha256: (a, b) => this.source.codeSha256(a, b),
      accessKeys: (a, b) => this.source.accessKeys(a, b),
      commitments: (b) => this.source.commitments(b),
    };
    await discoverSharedVaults(pinned, policy, { maxRecords: 1 });
    const config = z
      .object({ record_count: Count })
      .parse(await this.source.config(block.hash));
    if (
      checkpoint &&
      block.hash === checkpoint.block.hash &&
      (block.height !== checkpoint.block.height ||
        config.record_count !== checkpoint.sourceRecordCount)
    )
      throw new IndexError(
        "FINALITY_CONFLICT",
        "The same finalized block returned different journal metadata",
      );
    if (checkpoint && config.record_count < checkpoint.sourceRecordCount)
      throw new IndexError(
        "FINALITY_CONFLICT",
        "The immutable journal record count decreased",
      );
    if (checkpoint && checkpoint.nextIndex > 0) {
      const tail = z
        .array(z.unknown())
        .length(1)
        .parse(
          await this.source.contractView(
            policy.registry,
            "get_records",
            { from_index: checkpoint.nextIndex - 1, limit: 1 },
            block.hash,
          ),
        );
      if (
        recordFingerprint(
          sharedRecord(tail[0], policy.tokenId, policy.denomination),
        ) !==
        recordFingerprint(this.store.record(checkpoint.nextIndex - 1)!.record)
      )
        throw new IndexError(
          "FINALITY_CONFLICT",
          "Previously indexed journal tail changed",
        );
    }
    const checkedVaults = new Set<string>();
    let added = 0;
    for (let page = 0; page < maxPages; page++) {
      signal?.throwIfAborted();
      const start = checkpoint?.nextIndex ?? 0,
        limit = Math.min(50, config.record_count - start);
      const raw =
        limit === 0
          ? []
          : z
              .array(z.unknown())
              .length(limit)
              .parse(
                await this.source.contractView(
                  policy.registry,
                  "get_records",
                  { from_index: start, limit },
                  block.hash,
                ),
              );
      const records = raw.map((r, i) => {
        const parsed = sharedRecord(r, policy.tokenId, policy.denomination);
        if (parsed.index !== start + i || parsed.block_height > block.height)
          throw new IndexError(
            "RECORD_MISMATCH",
            "Incomplete, reordered or unfinalized record page",
          );
        return parsed;
      });
      for (const vault of new Set(
        records
          .map((r) => r.vault)
          .filter((v): v is string => v !== null && v !== undefined),
      )) {
        if (checkedVaults.has(vault)) continue;
        const member = z
          .object({ index: Count, account_id: z.literal(vault) })
          .parse(
            await this.source.contractView(
              policy.registry,
              "get_vault",
              { account_id: vault },
              block.hash,
            ),
          );
        const group = await discoverSharedVaults(pinned, policy, {
          fromIndex: member.index,
          maxRecords: 1,
        });
        if (!group.vaults.some((v) => v.accountId === vault))
          throw new IndexError(
            "RECORD_MISMATCH",
            "Journal names an unverified payout vault",
          );
        checkedVaults.add(vault);
      }
      signal?.throwIfAborted();
      const next: Checkpoint = {
        block,
        nextIndex: start + records.length,
        sourceRecordCount: config.record_count,
        updatedAt: new Date().toISOString(),
      };
      checkpoint = this.store.commit(checkpoint, next, records);
      added += records.length;
      if (checkpoint.nextIndex === config.record_count) break;
    }
    return { added, ...this.store.status() };
  }
  async linkPending(options: { limit?: number; signal?: AbortSignal } = {}) {
    const limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(options.limit ?? 20),
      result = {
        linked: 0,
        pending: 0,
        unrelated: 0,
        invalid: 0,
        readErrors: 0,
      };
    const candidates = this.store.pending(limit),
      checkpoint = this.store.checkpoint();
    if (candidates.length && checkpoint) {
      options.signal?.throwIfAborted();
      const head = FinalBlockSchema.parse(await this.source.finalBlock());
      if (head.height < checkpoint.block.height)
        throw new IndexError(
          "STALE_FINALITY",
          "RPC final head is behind the durable checkpoint",
        );
      const previous = FinalBlockSchema.parse(
        await this.source.blockAt(checkpoint.block.height),
      );
      if (
        previous.height !== checkpoint.block.height ||
        previous.hash !== checkpoint.block.hash ||
        (head.height === checkpoint.block.height &&
          head.hash !== checkpoint.block.hash)
      )
        throw new IndexError(
          "FINALITY_CONFLICT",
          "Cannot link provenance against a changed finalized checkpoint",
        );
    }
    for (const ref of candidates) {
      options.signal?.throwIfAborted();
      let raw: unknown;
      try {
        if (!this.source.transaction)
          throw new Error("Transaction reads unavailable");
        raw = await this.source.transaction(ref.hash, ref.signer);
      } catch {
        this.store.finishCandidate(ref, "pending", "TRANSACTION_READ_FAILED");
        result.pending++;
        result.readErrors++;
        continue;
      }
      options.signal?.throwIfAborted();
      if (
        raw === null ||
        (raw as { final_execution_status?: unknown })
          ?.final_execution_status !== "FINAL"
      ) {
        this.store.finishCandidate(ref, "pending", "NOT_FINAL");
        result.pending++;
        continue;
      }
      try {
        const checked = await this.anchors(ref, raw);
        options.signal?.throwIfAborted();
        if (checked.deferred) {
          this.store.finishCandidate(ref, "pending", "RECORDS_NOT_INDEXED");
          result.pending++;
          continue;
        }
        this.store.finishCandidate(
          ref,
          checked.links.length ? "linked" : "unrelated",
          null,
          checked.links,
        );
        result[checked.links.length ? "linked" : "unrelated"]++;
      } catch (error) {
        options.signal?.throwIfAborted();
        // RPC/provider failures stay retryable. A proven mismatch never becomes a linked payment.
        if (error instanceof IndexError || error instanceof z.ZodError) {
          this.store.finishCandidate(ref, "invalid", "PROVENANCE_MISMATCH");
          result.invalid++;
        } else {
          this.store.finishCandidate(ref, "pending", "PROVENANCE_READ_FAILED");
          result.pending++;
          result.readErrors++;
        }
      }
    }
    return result;
  }
  private async anchors(ref: IndexTxRef, input: unknown) {
    const policy = this.store.policy,
      checkpoint = this.store.checkpoint();
    if (!checkpoint) return { deferred: true, links: [] };
    const tx = z
      .object({
        transaction: z.object({
          hash: z.literal(ref.hash),
          signer_id: z.literal(ref.signer),
        }),
        status: z.union([
          z.object({ SuccessValue: z.string() }).strict(),
          z.object({ Failure: z.unknown() }).strict(),
        ]),
        receipts_outcome: z
          .array(
            z.object({
              id: Hash,
              block_hash: Hash,
              outcome: z.object({
                executor_id: z.string(),
                status: z.unknown(),
                logs: z.array(z.string().max(65536)).max(10000),
              }),
            }),
          )
          .max(10000),
      })
      .parse(input);
    const links = new Map<
        number,
        { index: number; fingerprint: string; provenance: Provenance }
      >(),
      blocks = new Map<number, string>();
    let deferred = false;
    for (const receipt of tx.receipts_outcome) {
      const outcome = receipt.outcome,
        status = outcome.status;
      if (
        outcome.executor_id !== policy.registry ||
        !z
          .union([
            z.object({ SuccessValue: z.string() }).strict(),
            z.object({ SuccessReceiptId: Hash }).strict(),
          ])
          .safeParse(status).success
      )
        continue;
      for (const log of outcome.logs) {
        if (!log.startsWith("EVENT_JSON:")) continue;
        let e: unknown;
        try {
          e = JSON.parse(log.slice(11));
        } catch {
          continue;
        }
        const event = z
          .object({
            standard: z.string(),
            version: z.string(),
            event: z.string(),
            data: z.array(z.unknown()).max(50),
          })
          .safeParse(e);
        if (
          !event.success ||
          event.data.standard !== "core_shared" ||
          event.data.version !== (policy.tokenId ? "3.0.0" : "2.0.0")
        )
          continue;
        for (const raw of event.data.data) {
          // Factory/status-only events do not contain journal indices.
          if (!raw || typeof raw !== "object" || !Object.hasOwn(raw, "index"))
            continue;
          const record = sharedRecord(raw, policy.tokenId, policy.denomination);
          if (record.kind !== event.data.event)
            throw new IndexError(
              "RECORD_MISMATCH",
              "Event kind differs from its journal record",
            );
          if (
            record.index >= checkpoint.nextIndex ||
            record.block_height > checkpoint.block.height
          ) {
            deferred = true;
            continue;
          }
          const stored = this.store.record(record.index);
          if (
            !stored ||
            recordFingerprint(stored.record) !== recordFingerprint(record)
          )
            throw new IndexError(
              "RECORD_MISMATCH",
              "Receipt does not anchor the authoritative journal record",
            );
          if (!blocks.has(record.block_height)) {
            const block = FinalBlockSchema.parse(
              await this.source.blockAt(record.block_height),
            );
            if (block.height !== record.block_height)
              throw new IndexError(
                "RECORD_MISMATCH",
                "Wrong receipt execution height",
              );
            blocks.set(block.height, block.hash);
          }
          if (blocks.get(record.block_height) !== receipt.block_hash)
            throw new IndexError(
              "RECORD_MISMATCH",
              "Receipt is outside the finalized execution block",
            );
          const existing = links.get(record.index),
            part = { id: receipt.id, blockHash: receipt.block_hash };
          if (existing) {
            if (
              !existing.provenance.receipts.some(
                (r) => canonical(r) === canonical(part),
              )
            )
              existing.provenance.receipts.push(part);
          } else
            links.set(record.index, {
              index: record.index,
              fingerprint: recordFingerprint(record),
              provenance: {
                transaction: ref,
                outerOutcome: Object.hasOwn(tx.status, "Failure")
                  ? "failed"
                  : "succeeded",
                receipts: [part],
                verifiedAt: checkpoint.block,
              },
            });
        }
      }
    }
    return { deferred, links: [...links.values()] };
  }
}
