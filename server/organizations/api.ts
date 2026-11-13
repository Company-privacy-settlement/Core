import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { ORGANIZATION_ROLE_PERMISSIONS, organizationOrigin } from '../../sdk/client/organizations.js';
import { ApiLimits, HttpError, PeerRateLimiter } from '../guards.js';
import { OrganizationAuth, OrganizationLogin, type OrganizationIdentitySource } from './auth.js';
import { Id, OrganizationAccount, OrganizationError, OrganizationInputs as Input } from './model.js';
import { OrganizationStore } from './store.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> { const result = schema.safeParse(value); if (!result.success) throw new OrganizationError(400, 'INVALID_INPUT'); return result.data; }
async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json' || req.headers['content-encoding']) throw new OrganizationError(415, 'JSON_REQUIRED');
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); signal.removeEventListener('abort', aborted); };
    const fail = (error: unknown) => { if (done) return; done = true; cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(new OrganizationError(408, 'REQUEST_ABORTED'));
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 8192) return fail(new OrganizationError(413, 'BODY_TOO_LARGE')); chunks.push(chunk); };
    const end = () => { if (done) return; done = true; cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new OrganizationError(400, 'INVALID_JSON')); } };
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
}
export function createOrganizationApi(options: { store: OrganizationStore; identity: OrganizationIdentitySource; allowedOrigins: string[]; timeoutMs?: number; maxConcurrent?: number; ratePoints?: number }) {
  const origins = new Set(options.allowedOrigins.map(organizationOrigin));
  if (!origins.size) throw new Error('Organization API needs an exact frontend origin allowlist');
  organizationOrigin(options.store.audience);
  const auth = new OrganizationAuth(options.store, options.identity), store = options.store;
  const timeoutMs = z.number().int().min(100).max(30_000).parse(options.timeoutMs ?? 10_000);
  const maximum = z.number().int().min(1).max(32).parse(options.maxConcurrent ?? 8);
  const limiter = new PeerRateLimiter(ApiLimits.parse({ ratePoints: options.ratePoints ?? 120, maxClients: 1024 }));
  let active = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(value)); } };
    let controller: AbortController | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      res.setHeader('vary', 'Origin');
      if (req.url === '/healthz' && req.method === 'GET') { send(200, { live: true, service: 'core-organizations' }); return; }
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin)) throw new OrganizationError(403, 'ORIGIN_DENIED');
      res.setHeader('access-control-allow-origin', origin);
      if (req.method === 'OPTIONS') {
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.headers['access-control-request-method'] ?? '')) throw new OrganizationError(403, 'METHOD_DENIED');
        const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (headers.some(h => !['content-type', 'authorization'].includes(h))) throw new OrganizationError(403, 'HEADER_DENIED');
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PATCH, DELETE', 'access-control-allow-headers': 'content-type, authorization', 'cache-control': 'no-store' }); res.end(); return;
      }
      limiter.take(req.socket.remoteAddress ?? 'unknown', req.url?.startsWith('/v1/auth/') ? 5 : 1);
      if (active >= maximum) throw new OrganizationError(503, 'SERVICE_BUSY');
      active++; controller = new AbortController(); const current = controller;
      timeout = setTimeout(() => { current.abort(); send(504, { error: 'REQUEST_TIMEOUT' }); }, timeoutMs);
      const closed = () => { if (!res.writableEnded) current.abort(); }; res.once('close', closed);
      try {
        const url = new URL(req.url ?? '/', 'http://organization.invalid');
        const signal = current.signal;
        let validatedToken: string | undefined;
        const input = async <S extends z.ZodType>(schema: S) => { const value = parse(schema, await body(req, signal)); signal.throwIfAborted(); if (validatedToken) store.session(validatedToken, origin); return value; };
        if (url.search && !(req.method === 'GET' && /^\/v1\/organizations\/[a-f0-9-]+\/audit$/.test(url.pathname))) throw new OrganizationError(400, 'QUERY_DENIED');
        if (req.method === 'POST' && url.pathname === '/v1/auth/challenge') {
          const value = await input(z.object({ accountId: OrganizationAccount }).strict()); send(200, store.challenge(value.accountId, origin)); return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/auth/login') { send(200, await auth.login(origin, await input(OrganizationLogin), signal)); return; }
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ') || header.length !== 50) throw new OrganizationError(401, 'SESSION_REQUIRED');
        const token = header.slice(7);
        validatedToken = token;
        if (req.method === 'POST' && url.pathname === '/v1/auth/logout') { store.session(token, origin); await input(z.object({}).strict()); store.logout(token); send(200, { loggedOut: true }); return; }
        const identity = await auth.identity(token, origin, signal), actor = identity.accountId;
        signal.throwIfAborted();
        if (req.method === 'GET' && url.pathname === '/v1/me') { send(200, { accountId: actor, network: 'testnet', expiresAt: new Date(identity.expires).toISOString(), claims: { legalIdentityVerified: false, kybVerified: false } }); return; }
        if (req.method === 'GET' && url.pathname === '/v1/me/invitations') { send(200, { items: store.inbox(actor) }); return; }
        const inbox = /^\/v1\/me\/invitations\/([^/]+)\/(accept|decline)$/.exec(url.pathname);
        if (inbox && req.method === 'POST') { const { version } = await input(Input.version); send(200, { organization: store.respondInvite(parse(Id, inbox[1]), actor, inbox[2] === 'accept', version) }); return; }
        if (url.pathname === '/v1/organizations') {
          if (req.method === 'GET') { send(200, { items: store.list(actor) }); return; }
          if (req.method === 'POST') { const value = await input(Input.create); send(201, store.create(actor, value.name)); return; }
        }
        const route = /^\/v1\/organizations\/([^/]+)(?:\/(members|invitations|roles|audit|ownership)(?:\/([^/]+))?)?$/.exec(url.pathname);
        if (!route) throw new OrganizationError(404, 'NOT_FOUND');
        const id = parse(Id, route[1]), resource = route[2], target = route[3];
        if (!resource) {
          if (req.method === 'GET') { send(200, store.detail(id, actor)); return; }
          if (req.method === 'PATCH') { const value = await input(Input.rename); send(200, store.rename(id, actor, value.name, value.version)); return; }
        }
        if (resource === 'roles' && !target && req.method === 'GET') { store.authorize(id, actor, 'organization.read'); send(200, { roles: ORGANIZATION_ROLE_PERMISSIONS }); return; }
        if (resource === 'ownership' && !target && req.method === 'POST') { const value = await input(Input.transfer); send(200, store.transfer(id, actor, value.accountId, value.version)); return; }
        if (resource === 'members') {
          if (!target && req.method === 'GET') { send(200, { items: store.members(id, actor) }); return; }
          if (target && req.method === 'PATCH') { const value = await input(Input.changeRole); store.changeRole(id, actor, parse(OrganizationAccount, target), value.role, value.version); send(200, { updated: true }); return; }
          if (target && req.method === 'DELETE') { const value = await input(Input.version); store.remove(id, actor, parse(OrganizationAccount, target), value.version); send(200, { removed: true }); return; }
        }
        if (resource === 'invitations') {
          if (!target && req.method === 'GET') { send(200, { items: store.invitations(id, actor) }); return; }
          if (!target && req.method === 'POST') { const value = await input(Input.invite); send(201, store.invite(id, actor, value.accountId, value.role)); return; }
          if (target && req.method === 'DELETE') { const value = await input(Input.version); store.revokeInvite(id, actor, parse(Id, target), value.version); send(200, { revoked: true }); return; }
        }
        if (resource === 'audit' && !target && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(k => k !== 'before') || url.searchParams.getAll('before').length > 1) throw new OrganizationError(400, 'INVALID_CURSOR');
          const cursor = url.searchParams.get('before');
          if (cursor !== null && (!/^[1-9][0-9]{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new OrganizationError(400, 'INVALID_CURSOR');
          send(200, store.auditPage(id, actor, cursor === null ? undefined : Number(cursor))); return;
        }
        throw new OrganizationError(404, 'NOT_FOUND');
      } finally { active--; if (timeout) clearTimeout(timeout); res.off('close', closed); }
    } catch (error) {
      if (controller?.signal.aborted) { send(504, { error: 'REQUEST_TIMEOUT' }); return; }
      if (error instanceof OrganizationError || error instanceof HttpError) { if (error instanceof HttpError && error.retryAfter) res.setHeader('retry-after', error.retryAfter); send(error.status, { error: error.code }); }
      else send(500, { error: 'ORGANIZATION_REQUEST_FAILED' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  return server;
}
