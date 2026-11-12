import { z } from 'zod';

export const AccountId = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/);
export const Atomic = z.string().max(39).regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 1n << 128n, 'Amount exceeds u128');
export const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
