import {createHash, randomInt, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {hash, NoteTree, DEPTH} from '../../sdk/core.js';

export const Timing = z.object({
 delayMinSeconds: z.number().int().min(0).max(86400),
 delayMaxSeconds: z.number().int().min(1).max(86400),
 expiresInSeconds: z.number().int().min(31).max(172800),
}).strict().refine(t => t.delayMaxSeconds > t.delayMinSeconds && t.expiresInSeconds >= t.delayMaxSeconds + 30, 'Allow a spread and at least 30 seconds to execute');
export const ControlToken = z.string().regex(/^[a-f0-9]{64}$/);
export const ScheduleCommand = z.object({controlToken: ControlToken, expectedRevision: z.number().int().min(1).max(6)}).strict();
export const schedulingConfig = {maxPending: 256, maxRecords: 10000, maxBatchSize: 8, tickMilliseconds: 1000, maxReschedules: 5} as const;
export type TimingChoice = z.infer<typeof Timing>;
export type Schedule = {requestId:string; revision:number; state:'waiting'|'blocked'|'cancelled'|'expired'|'executing'; createdAt:number; readyAt:number; expiresAt:number; timing:TimingChoice; error:string|null};
export const controlDigest = (token:string) => createHash('sha256').update(ControlToken.parse(token)).digest('hex');
export function sameControl(token:string, digest:string) { return timingSafeEqual(Buffer.from(controlDigest(token),'hex'), Buffer.from(digest,'hex')); }
export function sampleReady(now:number, timing:TimingChoice) {return now + randomInt(timing.delayMinSeconds*1000, timing.delayMaxSeconds*1000+1);}
export function safeRelayError(error:unknown) {return error instanceof Error && /^RELAY_[A-Z_]+$/.test(error.message) ? error.message : 'RELAY_PREFLIGHT_FAILED';}

// The immutable forest remembers every append root. Reconstruct its history from
// the complete list already checked against the FINAL, code-pinned current root.
// Never accept an indexer's assertion that an arbitrary root is known.
export async function hasHistoricalRoot(tree:NoteTree, root:string) {
 if (tree.root === root) return true;
 const empty = await NoteTree.from([]), levels = empty.levels;
 if (empty.root === root) return true;
 for(let index=0;index<tree.leaves.length;index++) {
  levels[0][index]=tree.leaves[index];let node=index;
  for(let level=0;level<DEPTH;level++) {node>>=1;levels[level+1][node]=await hash([levels[level][node*2],levels[level][node*2+1]]);}
  if(levels[DEPTH][0]===root)return true;
 }
 return false;
}
