import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { SharedPolicySchema, type SharedPolicy } from '../sdk/shared.js';
import { operationCatalog, groupCapacity, recipientReadiness, RecipientReadinessInput, prepareFtDeposit, PrepareDepositInput, preflightFt, observeSettlement, PreflightInput, SettlementReference, OperationsError, type OperationsSource } from '../sdk/operations.js';
import { VerifyTransactionInput, verifyTransaction } from '../sdk/transactions.js';
import { ActivityQuery, IndexError } from '../sdk/indexer/types.js';
import type { ActivityReader } from '../sdk/indexer/store.js';
import { canonical } from '../sdk/client/crypto.js';
import {InvoiceProofInput,InvoiceStatusInput,verifyInvoiceMerchant,indexedInvoiceStatus} from '../sdk/invoices.js';
import { ApiLimits, HttpError, PeerRateLimiter, RpcBudget, routeBudgets, type ApiLimitOptions } from './guards.js';
import { provingContext, ProvingContextInput } from '../sdk/operations.js';
import { readiness, ReadinessOptions, type ReadinessSettings } from './readiness.js';

function readIndex<T>(read:()=>T):T{try{return read();}catch(error){if(error instanceof IndexError)throw error;throw new HttpError(503,'INDEX_READ_FAILED');}}
async function readIndexAsync<T>(read:()=>Promise<T>):Promise<T>{try{return await read();}catch(error){if(error instanceof IndexError)throw error;throw new HttpError(503,'INDEX_READ_FAILED');}}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new HttpError(400,'INVALID_INPUT'); return parsed.data;
}
function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw new HttpError(415,'JSON_REQUIRED');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415,'ENCODING_UNSUPPORTED');
  return new Promise((resolve,reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false;
    const cleanup = () => { signal.removeEventListener('abort', abort); req.off('data', data); req.off('end', end); req.off('aborted', aborted); };
    const error = (e: unknown) => { if (failed) return; failed = true; cleanup(); req.once('close', () => req.off('error', error)); req.resume(); reject(e); };
    const abort = () => error(signal.reason);
    const aborted = () => error(new HttpError(400,'REQUEST_ABORTED'));
    const data = (chunk: Buffer) => {
      if (failed) return; size += chunk.length;
      if (size > 8192) { error(new HttpError(413,'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    };
    const end = () => { if (failed) return; cleanup(); req.off('error', error); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400,'INVALID_JSON')); } };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
export function createReadOnlyApi(options: { source: OperationsSource; sourceFactory?: (signal: AbortSignal) => OperationsSource; policy: SharedPolicy; allowedOrigins?: string[]; maxConcurrent?: number; index?:ActivityReader; limits?: ApiLimitOptions; readiness?: ReadinessSettings }) {
  const policy = SharedPolicySchema.parse(options.policy);
  if (options.source.network !== policy.network || options.source.factory !== policy.registry) throw new Error('API source does not match policy');
  if(options.index&&canonical(options.index.policy)!==canonical(policy))throw new Error('API index does not match policy');
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(origin => {
    const parsed = new URL(origin); if (!['http:','https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Use exact HTTP(S) CORS origins'); return origin;
  }));
  const maxConcurrent = z.number().int().min(1).max(16).parse(options.maxConcurrent ?? 2);
  const limits = ApiLimits.parse(options.limits ?? {}), limiter = new PeerRateLimiter(limits), readinessSettings = ReadinessOptions.parse(options.readiness ?? {});
  let active = 0;
  const server = createServer(async (req,res) => {
    res.setHeader('vary','Origin');
    let isReadiness = false;
    // This service performs public reads and prepares public calls. It has no signing keys or broadcast route.
    try {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403,'ORIGIN_DENIED');
      if (origin) { res.setHeader('access-control-allow-origin',origin); res.setHeader('access-control-expose-headers','Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset'); }
      if (!req.url || req.url.length > 2048) throw new HttpError(414,'URI_TOO_LONG');
      const url = new URL(req.url,'http://core.local');
      isReadiness = req.method === 'GET' && url.pathname === '/readyz';
      if (req.method === 'GET' && url.pathname === '/healthz') {
        if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
        json(res,200,{service:'core',readOnly:true,configured:true,network:policy.network,registry:policy.registry,chainReadinessChecked:false}); return;
      }
      const route = routeBudgets[`${req.method} ${url.pathname}`] ?? { points: 1, reads: 0 };
      const rate = limiter.take(req.socket.remoteAddress ?? 'unknown', route.points);
      res.setHeader('ratelimit-limit', rate.limit); res.setHeader('ratelimit-remaining', rate.remaining); res.setHeader('ratelimit-reset', rate.reset);
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods','GET, POST, OPTIONS'); res.setHeader('access-control-allow-headers','Content-Type'); res.writeHead(204); res.end(); return;
      }
      if (!['GET','POST'].includes(req.method ?? '')) { res.setHeader('allow','GET, POST, OPTIONS'); throw new HttpError(405,'METHOD_NOT_ALLOWED'); }
      if (url.pathname === '/v1/config' && req.method === 'GET') { if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED'); json(res,200,{policy,readOnly:true,signing:'client-wallet',secretsAccepted:false}); return; }
      if (active >= maxConcurrent) throw new HttpError(429,'TOO_MANY_REQUESTS',1);
      active++;
      const controller = new AbortController(), budget = new RpcBudget(Math.min(route.reads, limits.maxRpcReads), controller.signal);
      const timeout = setTimeout(() => controller.abort(new HttpError(504,'REQUEST_TIMEOUT')), limits.timeoutMs); timeout.unref();
      const closed = () => { if (!res.writableFinished) controller.abort(new HttpError(499,'REQUEST_ABORTED')); };
      res.once('close', closed);
      let aborted!: () => void;
      const cancelled = new Promise<never>((_resolve,reject) => { aborted = () => reject(controller.signal.reason); controller.signal.addEventListener('abort',aborted,{once:true}); });
      const work = (async () => {
        const rawSource = options.sourceFactory ? options.sourceFactory(controller.signal) : options.source;
        if (rawSource.network !== policy.network || rawSource.factory !== policy.registry) throw new Error('Request source does not match policy');
        const source = budget.bind(rawSource);
        // Async invoice hashing must not resume database reads after a deadline
        // or after the HTTP server has closed its read-only database handle.
        const guardedRead = <T>(read: () => T): T => { controller.signal.throwIfAborted(); return read(); };
        const index: ActivityReader | undefined = options.index ? {
          policy: options.index.policy, status: () => guardedRead(() => options.index!.status()),
          activity: query => guardedRead(() => options.index!.activity(query)),
          ...(options.index.invoiceActivity ? { invoiceActivity: (query: Parameters<NonNullable<ActivityReader['invoiceActivity']>>[0]) => guardedRead(() => options.index!.invoiceActivity!(query)) } : {}),
        } : undefined;
        const respond = (value: unknown) => { controller.signal.throwIfAborted(); json(res,200,value); };
        if (isReadiness) {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED'); respond(await readiness(source,policy,index,readinessSettings));
        } else
        if(url.pathname==='/v1/invoices/verify'&&req.method==='POST'){
          if(url.search)throw new HttpError(400,'QUERY_NOT_ALLOWED');respond(await verifyInvoiceMerchant(source,policy,input(InvoiceProofInput,await body(req,controller.signal))));
        }else if(url.pathname==='/v1/invoices/status'&&req.method==='POST'){
          if(url.search)throw new HttpError(400,'QUERY_NOT_ALLOWED');if(!index)throw new HttpError(503,'INDEX_DISABLED');const request=input(InvoiceStatusInput,await body(req,controller.signal));respond(await readIndexAsync(()=>indexedInvoiceStatus(index,policy,request)));
        }else if (url.pathname === '/v1/proofs/context' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await provingContext(source,policy,input(ProvingContextInput,await body(req,controller.signal))));
        }else if (url.pathname === '/v1/deposits/prepare' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await prepareFtDeposit(source,policy,input(PrepareDepositInput,await body(req,controller.signal))));
        }else if (url.pathname === '/v1/recipients/readiness' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await recipientReadiness(source,policy,input(RecipientReadinessInput,await body(req,controller.signal))));
        }else if (url.pathname === '/v1/group/capacity' && req.method === 'GET') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await groupCapacity(source,policy));
        }else if ((url.pathname === '/v1/activity'||url.pathname === '/v1/index/status') && req.method === 'GET') {
          if(!index)throw new HttpError(503,'INDEX_DISABLED');
          if(new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)throw new HttpError(400,'DUPLICATE_QUERY');
          if(url.pathname==='/v1/index/status'){if(url.search)throw new HttpError(400,'QUERY_NOT_ALLOWED');respond(readIndex(()=>index.status()));}
          else{const query=input(ActivityQuery,Object.fromEntries(url.searchParams));respond(readIndex(()=>index.activity(query)));}
        } else if (url.pathname === '/v1/vaults' && req.method === 'GET') {
          if(new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)throw new HttpError(400,'DUPLICATE_QUERY');
          const params = input(z.object({ fromIndex: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), maxRecords: z.coerce.number().int().min(1).max(50).optional() }).strict(), Object.fromEntries(url.searchParams));
          respond(await operationCatalog(source,policy,{fromIndex:params.fromIndex,maxRecords:params.maxRecords??20}));
        } else if (url.pathname === '/v1/ft/preflight' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await preflightFt(source,policy,input(PreflightInput,await body(req,controller.signal))));
        } else if (url.pathname === '/v1/transactions/verify' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          const request=input(VerifyTransactionInput,await body(req,controller.signal));
          respond(await verifyTransaction(source,policy,request.transaction,request.call));
        } else if (url.pathname === '/v1/settlements/status' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          respond(await observeSettlement(source,policy,input(SettlementReference,await body(req,controller.signal))));
        } else throw new HttpError(404,'NOT_FOUND');
      })();
      try {
        await Promise.race([work,cancelled]);
      } finally {
        clearTimeout(timeout); res.off('close',closed); controller.signal.removeEventListener('abort',aborted);
        controller.abort(new HttpError(499,'REQUEST_FINISHED'));
        // A non-cancellable adapter keeps its slot until its actual reads settle.
        // Returning 504 must not create room for unbounded orphaned RPC work.
        void work.catch(() => {}).then(() => budget.drain()).then(() => { active--; });
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!req.complete) { res.setHeader('connection','close'); req.resume(); }
      if (error instanceof HttpError) { if (error.status === 413) res.setHeader('connection','close'); if(error.retryAfter)res.setHeader('retry-after',error.retryAfter); json(res,error.status,{error:error.code,...(isReadiness?{ready:false}:{})}); }
      else if (error instanceof OperationsError) json(res,409,{error:error.code,message:error.message});
      else if (error instanceof IndexError) json(res,error.code==='INVALID_CURSOR'?400:error.code==='INDEX_NOT_READY'?503:409,{error:error.code});
      else json(res,isReadiness?503:502,{error:'CHAIN_READ_FAILED',...(isReadiness?{ready:false}:{})});
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return server;
}
