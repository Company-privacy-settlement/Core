import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { OperationsSource } from '../sdk/operations.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); }
}
export const ApiLimits = z.object({
  ratePoints: z.number().int().min(5).max(100000).default(120),
  rateWindowMs: z.number().int().min(100).max(3600000).default(60000),
  maxClients: z.number().int().min(1).max(100000).default(1024),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
  maxRpcReads: z.number().int().min(1).max(1000).default(160),
}).strict();
export type ApiLimitOptions = z.input<typeof ApiLimits>;

/** Fixed windows, bounded peer state, no request-controlled forwarding headers. */
export class PeerRateLimiter {
  private peers = new Map<string, { expires: number; spent: number }>();
  constructor(private limits: z.output<typeof ApiLimits>, private now = () => performance.now()) {}
  take(peer: string, cost: number) {
    const now = this.now();
    let entry = this.peers.get(peer);
    if (!entry || entry.expires <= now) {
      if (!entry && this.peers.size >= this.limits.maxClients) {
        for (const [key, value] of this.peers) if (value.expires <= now) this.peers.delete(key);
        if (this.peers.size >= this.limits.maxClients) throw new HttpError(503, 'RATE_LIMIT_CAPACITY', 1);
      }
      entry = { expires: now + this.limits.rateWindowMs, spent: 0 }; this.peers.set(peer, entry);
    }
    const reset = Math.max(1, Math.ceil((entry.expires - now) / 1000));
    if (entry.spent + cost > this.limits.ratePoints) throw new HttpError(429, 'RATE_LIMITED', reset);
    entry.spent += cost;
    return { limit: this.limits.ratePoints, remaining: this.limits.ratePoints - entry.spent, reset };
  }
}

const reads = new Set(['finalBlock', 'finalizedBlock', 'config', 'records', 'vaultConfig', 'vaultRecord', 'codeSha256', 'accessKeys', 'commitments', 'account', 'contractView', 'transaction']);
/** Track underlying reads even if an adapter does not support cancellation. */
export class RpcBudget {
  private used = 0;
  private pending = new Set<Promise<unknown>>();
  constructor(private limit: number, private signal: AbortSignal) {}
  bind(source: OperationsSource): OperationsSource {
    return new Proxy(source, { get: (target, key) => {
      const value = Reflect.get(target, key, target);
      if (typeof key !== 'string' || !reads.has(key) || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        this.signal.throwIfAborted();
        if (++this.used > this.limit) throw new HttpError(503, 'RPC_BUDGET_EXCEEDED');
        const call = Promise.resolve().then(() => { this.signal.throwIfAborted(); return Reflect.apply(value, target, args); })
          .then(result => { this.signal.throwIfAborted(); return result; });
        this.pending.add(call);
        void call.then(() => this.pending.delete(call), () => this.pending.delete(call));
        return call;
      };
    } });
  }
  async drain() { await Promise.allSettled([...this.pending]); }
}

export const routeBudgets: Readonly<Record<string, { points: number; reads: number }>> = {
  'GET /readyz': { points: 5, reads: 10 },
  'GET /v1/group/capacity': { points: 5, reads: 10 },
  'GET /v1/vaults': { points: 5, reads: 160 },
  'POST /v1/ft/preflight': { points: 3, reads: 40 },
  'POST /v1/recipients/readiness': { points: 3, reads: 16 },
  'POST /v1/deposits/prepare': { points: 5, reads: 80 },
  'POST /v1/settlements/status': { points: 2, reads: 30 },
  'POST /v1/transactions/verify': { points: 2, reads: 1 },
  'POST /v1/invoices/verify': { points: 2, reads: 4 },
};
