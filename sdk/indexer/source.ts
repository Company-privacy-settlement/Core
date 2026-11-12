import { NearRpcOperationsSource } from "../operations.js";
import { Count } from "../validation.js";
import { FinalBlockSchema, type IndexSource } from "./types.js";
import { Hash, IndexTxRef, IndexError } from "./types.js";
import { z } from "zod";
import { NearRpcError } from "../factory.js";
import type { DiscoverySource, ScanBlock } from "./discovery.js";
export class NearRpcIndexSource
  extends NearRpcOperationsSource
  implements IndexSource, DiscoverySource
{
  async blockAt(height: number) {
    Count.parse(height);
    const { hash, height: actual } = (
      await this.rpc("block", { block_id: height })
    ).header;
    return FinalBlockSchema.parse({ hash, height: actual });
  }
  async scanBlock(height: number): Promise<ScanBlock | null> {
    Count.parse(height);
    let input: unknown;
    try {
      input = await this.rpc("block", { block_id: height });
    } catch (error) {
      if (error instanceof NearRpcError && error.causeName === "UNKNOWN_BLOCK")
        return null;
      throw error;
    }
    const raw = z
      .object({
        header: z.object({ hash: Hash, height: Count, prev_hash: Hash }),
        chunks: z
          .array(
            z.object({
              chunk_hash: Hash,
              shard_id: Count,
              height_included: Count,
            }),
          )
          .max(64),
      })
      .parse(input);
    if (
      raw.header.height !== height ||
      raw.chunks.some((c) => c.height_included > height) ||
      new Set(raw.chunks.map((c) => c.shard_id)).size !== raw.chunks.length
    )
      throw new IndexError(
        "RECORD_MISMATCH",
        "Invalid finalized block shard headers",
      );
    const transactions: IndexTxRef[] = [];
    for (const c of raw.chunks
      .filter((c) => c.height_included === height)
      .sort((a, b) => a.shard_id - b.shard_id)) {
      const chunk = z
        .object({
          header: z.object({ chunk_hash: z.literal(c.chunk_hash) }),
          transactions: z
            .array(z.object({ hash: Hash, signer_id: z.string() }))
            .max(10000),
        })
        .parse(await this.rpc("chunk", { chunk_id: c.chunk_hash }));
      transactions.push(
        ...chunk.transactions.map((t) =>
          IndexTxRef.parse({ hash: t.hash, signer: t.signer_id }),
        ),
      );
      if (transactions.length > 10000)
        throw new Error("Block transaction budget exceeded");
    }
    if (new Set(transactions.map((t) => t.hash)).size !== transactions.length)
      throw new IndexError(
        "RECORD_MISMATCH",
        "Duplicate transaction across shard chunks",
      );
    return {
      block: { hash: raw.header.hash, height },
      previousHash: raw.header.prev_hash,
      transactions,
    };
  }
}
