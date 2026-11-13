import { z } from 'zod';
import { ApiLimits } from './guards.js';
import { ReadinessOptions } from './readiness.js';

const integer = z.string().regex(/^[0-9]+$/).transform(Number).optional();
const environment = z.object({
  CORE_API_MAX_CONCURRENT: integer,
  CORE_API_RATE_POINTS: integer,
  CORE_API_RATE_WINDOW_MS: integer,
  CORE_API_MAX_CLIENTS: integer,
  CORE_API_TIMEOUT_MS: integer,
  CORE_API_MAX_RPC_READS: integer,
  CORE_API_REQUIRE_INDEX: z.enum(['true', 'false']).optional(),
  CORE_API_INDEX_MAX_AGE_MS: integer,
  CORE_API_INDEX_MAX_LAG_BLOCKS: integer,
});
export function serverSettings(env: Record<string, string | undefined>) {
  const parsed = environment.parse(env);
  return {
    maxConcurrent: z.number().int().min(1).max(16).parse(parsed.CORE_API_MAX_CONCURRENT ?? 2),
    limits: ApiLimits.parse({ ratePoints: parsed.CORE_API_RATE_POINTS, rateWindowMs: parsed.CORE_API_RATE_WINDOW_MS,
      maxClients: parsed.CORE_API_MAX_CLIENTS, timeoutMs: parsed.CORE_API_TIMEOUT_MS, maxRpcReads: parsed.CORE_API_MAX_RPC_READS }),
    readiness: ReadinessOptions.parse({ requireIndex: parsed.CORE_API_REQUIRE_INDEX === 'true',
      maxIndexAgeMs: parsed.CORE_API_INDEX_MAX_AGE_MS, maxIndexLagBlocks: parsed.CORE_API_INDEX_MAX_LAG_BLOCKS }),
  };
}
