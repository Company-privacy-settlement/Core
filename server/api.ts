import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { SharedPolicySchema, type SharedPolicy } from '../sdk/shared.js';
import { operationCatalog, preflightFt, observeSettlement, PreflightInput, SettlementReference, OperationsError, type OperationsSource } from '../sdk/operations.js';
import { VerifyTransactionInput, verifyTransaction } from '../sdk/transactions.js';

class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new HttpError(400,'INVALID_INPUT'); return parsed.data;
}
function body(req: IncomingMessage): Promise<unknown> {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw new HttpError(415,'JSON_REQUIRED');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415,'ENCODING_UNSUPPORTED');
  return new Promise((resolve,reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return; size += chunk.length;
      if (size > 8192) { failed = true; reject(new HttpError(413,'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (failed) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400,'INVALID_JSON')); } });
    req.on('error',reject); req.on('aborted',() => reject(new HttpError(400,'REQUEST_ABORTED')));
  });
}
export function createReadOnlyApi(options: { source: OperationsSource; policy: SharedPolicy; allowedOrigins?: string[]; maxConcurrent?: number }) {
  const policy = SharedPolicySchema.parse(options.policy);
  if (options.source.network !== policy.network || options.source.factory !== policy.registry) throw new Error('API source does not match policy');
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(origin => {
    const parsed = new URL(origin); if (!['http:','https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Use exact HTTP(S) CORS origins'); return origin;
  }));
  const maxConcurrent = z.number().int().min(1).max(16).parse(options.maxConcurrent ?? 2);
  let active = 0;
  const server = createServer(async (req,res) => {
    res.setHeader('vary','Origin');
    // This service performs public reads and prepares public calls. It has no signing keys or broadcast route.
    try {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403,'ORIGIN_DENIED');
      if (origin) res.setHeader('access-control-allow-origin',origin);
      if (!req.url || req.url.length > 2048) throw new HttpError(414,'URI_TOO_LONG');
      const url = new URL(req.url,'http://core.local');
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods','GET, POST, OPTIONS'); res.setHeader('access-control-allow-headers','Content-Type'); res.writeHead(204); res.end(); return;
      }
      if (!['GET','POST'].includes(req.method ?? '')) { res.setHeader('allow','GET, POST, OPTIONS'); throw new HttpError(405,'METHOD_NOT_ALLOWED'); }
      if (url.pathname === '/healthz' && req.method === 'GET') { json(res,200,{service:'core',readOnly:true,configured:true,network:policy.network,registry:policy.registry,chainReadinessChecked:false}); return; }
      if (url.pathname === '/v1/config' && req.method === 'GET') { json(res,200,{policy,readOnly:true,signing:'client-wallet',secretsAccepted:false}); return; }
      if (active >= maxConcurrent) throw new HttpError(429,'TOO_MANY_REQUESTS');
      active++;
      try {
        if (url.pathname === '/v1/vaults' && req.method === 'GET') {
          const params = input(z.object({ fromIndex: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), maxRecords: z.coerce.number().int().min(1).max(50).optional() }).strict(), Object.fromEntries(url.searchParams));
          json(res,200,await operationCatalog(options.source,policy,{fromIndex:params.fromIndex,maxRecords:params.maxRecords??20}));
        } else if (url.pathname === '/v1/ft/preflight' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          json(res,200,await preflightFt(options.source,policy,input(PreflightInput,await body(req))));
        } else if (url.pathname === '/v1/transactions/verify' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          const request=input(VerifyTransactionInput,await body(req));
          json(res,200,await verifyTransaction(options.source,policy,request.transaction,request.call));
        } else if (url.pathname === '/v1/settlements/status' && req.method === 'POST') {
          if (url.search) throw new HttpError(400,'QUERY_NOT_ALLOWED');
          json(res,200,await observeSettlement(options.source,policy,input(SettlementReference,await body(req))));
        } else throw new HttpError(404,'NOT_FOUND');
      } finally { active--; }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof HttpError) { if (error.status === 413) res.setHeader('connection','close'); json(res,error.status,{error:error.code}); }
      else if (error instanceof OperationsError) json(res,409,{error:error.code,message:error.message});
      else json(res,502,{error:'CHAIN_READ_FAILED'});
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  return server;
}
