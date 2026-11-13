import { z } from 'zod';
import { operationCatalog, type OperationsSource } from '../sdk/operations.js';
import type { SharedPolicy } from '../sdk/shared.js';
import type { ActivityReader } from '../sdk/indexer/store.js';
import { CheckpointSchema } from '../sdk/indexer/types.js';
import { Count } from '../sdk/validation.js';
import { HttpError } from './guards.js';

export const ReadinessOptions = z.object({
  requireIndex: z.boolean().default(false),
  maxIndexAgeMs: z.number().int().min(1000).max(3600000).default(60000),
  maxIndexLagBlocks: z.number().int().min(0).max(10000).default(100),
}).strict();
export type ReadinessSettings = z.input<typeof ReadinessOptions>;
const statusSchema = z.object({ enabled: z.literal(true), checkpoint: CheckpointSchema.nullable(), indexedRecords: Count, remainingRecords: Count.nullable() });

export async function readiness(source: OperationsSource, policy: SharedPolicy, index: ActivityReader | undefined, settings: z.output<typeof ReadinessOptions>) {
  // One page checks the pinned registry and, when present, its first ready member.
  // It does not claim all vaults are healthy or guarantee capacity/liquidity.
  const { checkedAtBlock, catalog } = await operationCatalog(source, policy, { maxRecords: 1 });
  if (!index) {
    if (settings.requireIndex) throw new HttpError(503, 'INDEX_DISABLED');
    return { ready: true, readOnly: true, checkedAtBlock, deploymentVerified: true, checkedVaults: catalog.vaults.length, index: { enabled: false }, chainFreshnessChecked: false };
  }
  let status: z.infer<typeof statusSchema>;
  try { status = statusSchema.parse(index.status()); }
  catch { throw new HttpError(503, 'INDEX_READ_FAILED'); }
  const checkpoint = status.checkpoint;
  if (!checkpoint) throw new HttpError(503, 'INDEX_NOT_READY');
  const ageMs = Date.now() - Date.parse(checkpoint.updatedAt), lagBlocks = checkedAtBlock.height - checkpoint.block.height;
  // A concurrent worker can legitimately advance after this request pinned its
  // block. Report a retryable snapshot mismatch, not a finality violation.
  if (lagBlocks < 0) throw new HttpError(503, 'INDEX_AHEAD');
  if (lagBlocks === 0 && checkpoint.block.hash !== checkedAtBlock.hash) throw new HttpError(503, 'INDEX_FINALITY_CONFLICT');
  if (ageMs < -5000 || ageMs > settings.maxIndexAgeMs || lagBlocks > settings.maxIndexLagBlocks) throw new HttpError(503, 'INDEX_STALE');
  // Compare against the journal count at the same verified final block, rather
  // than accepting a complete-but-old checkpoint that missed new payouts.
  const count = z.object({ record_count: Count }).parse(await source.config(checkedAtBlock.hash)).record_count;
  if (checkpoint.nextIndex !== count || status.indexedRecords !== count || status.remainingRecords !== 0 || checkpoint.sourceRecordCount !== count) throw new HttpError(503, 'INDEX_BEHIND');
  return { ready: true, readOnly: true, checkedAtBlock, deploymentVerified: true, checkedVaults: catalog.vaults.length, index: { enabled: true, ageMs: Math.max(0, ageMs), lagBlocks, indexedRecords: count, provenanceChecked: false }, chainFreshnessChecked: false };
}
