import type { DraftServices } from './tax-drafts.js';
import type { SumsubProvider } from './sumsub.js';
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { ORGANIZATION_ROLE_PERMISSIONS, organizationOrigin } from '../../sdk/client/organizations.js';
import { ApiLimits, HttpError, PeerRateLimiter } from '../guards.js';
import { OrganizationAuth, OrganizationLogin, type OrganizationIdentitySource } from './auth.js';
import { Id, OrganizationAccount, OrganizationError, OrganizationInputs as Input } from './model.js';
import { OrganizationStore } from './store.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> { const result = schema.safeParse(value); if (!result.success) throw new OrganizationError(400, 'INVALID_INPUT'); return result.data; }
async function rawBody(req: IncomingMessage, signal: AbortSignal, maximum=8192): Promise<Buffer> {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json' || req.headers['content-encoding']) throw new OrganizationError(415, 'JSON_REQUIRED');
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); signal.removeEventListener('abort', aborted); };
    const fail = (error: unknown) => { if (done) return; done = true; cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(new OrganizationError(408, 'REQUEST_ABORTED'));
    const data = (chunk: Buffer) => { size += chunk.length; if (size > maximum) return fail(new OrganizationError(413, 'BODY_TOO_LARGE')); chunks.push(chunk); };
    const end = () => { if (done) return; done = true; cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
}
async function body(req:IncomingMessage,signal:AbortSignal,maximum=8192):Promise<unknown>{const bytes=await rawBody(req,signal,maximum);try{return JSON.parse(bytes.toString('utf8'));}catch{throw new OrganizationError(400,'INVALID_JSON');}}
export function createOrganizationApi(options: { store: OrganizationStore; identity: OrganizationIdentitySource; allowedOrigins: string[]; timeoutMs?: number; maxConcurrent?: number; ratePoints?: number; verificationProvider?:SumsubProvider; draftServices?:DraftServices; demoKyb?:boolean }) {
  if(options.demoKyb&&options.verificationProvider)throw new Error('Hackathon KYB and a real verification provider cannot be enabled together');
  const origins = new Set(options.allowedOrigins.map(organizationOrigin));
  if (!origins.size) throw new Error('Organization API needs an exact frontend origin allowlist');
  organizationOrigin(options.store.audience);
  const auth = new OrganizationAuth(options.store, options.identity), store = options.store;
  const timeoutMs = z.number().int().min(100).max(30_000).parse(options.timeoutMs ?? 10_000);
  const maximum = z.number().int().min(1).max(32).parse(options.maxConcurrent ?? 8);
  const limiter = new PeerRateLimiter(ApiLimits.parse({ ratePoints: options.ratePoints ?? 120, maxClients: 1024 }));
  let active = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { if (!res.destroyed && !res.writableEnded) {
      if (status === 413 || (status >= 400 && !req.complete)) { res.setHeader('connection', 'close'); req.resume(); }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(value));
    } };
    let controller: AbortController | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      res.setHeader('vary', 'Origin');
      if (req.url === '/healthz' && req.method === 'GET') { send(200, { live: true, service: 'core-organizations' }); return; }
      const isReadiness = req.method === 'GET' && req.url === '/readyz';
      const isVerificationHook=req.method==='POST'&&req.url==='/v1/providers/sumsub/webhook';
      const origin = req.headers.origin ?? '';
      if (!isVerificationHook&&!(isReadiness&&!origin)&&(!origin || !origins.has(origin))) throw new OrganizationError(403, 'ORIGIN_DENIED');
      if(!isVerificationHook&&origin)res.setHeader('access-control-allow-origin', origin);
      if (req.method === 'OPTIONS') {
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.headers['access-control-request-method'] ?? '')) throw new OrganizationError(403, 'METHOD_DENIED');
        const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (headers.some(h => !['content-type', 'authorization'].includes(h))) throw new OrganizationError(403, 'HEADER_DENIED');
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PATCH, DELETE', 'access-control-allow-headers': 'content-type, authorization', 'cache-control': 'no-store' }); res.end(); return;
      }
      limiter.take(req.socket.remoteAddress ?? 'unknown', isReadiness||req.url?.startsWith('/v1/auth/')||req.method==='POST'&&req.url?.includes('/tax-drafts') ? 5 : 1);
      if (active >= maximum) throw new OrganizationError(503, 'SERVICE_BUSY');
      active++; controller = new AbortController(); const current = controller;
      timeout = setTimeout(() => { current.abort(); send(504, { error: 'REQUEST_TIMEOUT' }); }, req.url?.includes('/tax-drafts')?Math.max(timeoutMs,25000):timeoutMs);
      const closed = () => { if (!res.writableEnded) current.abort(); }; res.once('close', closed);
      try {
        const url = new URL(req.url ?? '/', 'http://organization.invalid');
        const signal = current.signal;
        if(isReadiness){
          if(!options.identity.readiness)throw new OrganizationError(503,'IDENTITY_READINESS_UNAVAILABLE');
          const chain=await options.identity.readiness(signal);signal.throwIfAborted();
          send(200,{ready:true,service:'core-organizations',...chain,...store.readiness(),checkedAt:new Date().toISOString(),identityClaimsVerified:false,...(options.demoKyb?{demoKybEnabled:true}:{})});return;
        }
        if(isVerificationHook){if(!options.verificationProvider)throw new OrganizationError(503,'VERIFICATION_PROVIDER_DISABLED');const bytes=await rawBody(req,signal,65536);signal.throwIfAborted();send(200,store.verifications.receive(options.verificationProvider,bytes,req.headers['x-payload-digest'],req.headers['x-payload-digest-alg']));return;}
        let validatedToken: string | undefined;
        const input = async <S extends z.ZodType>(schema: S,maximum=8192) => { const value = parse(schema, await body(req, signal,maximum)); signal.throwIfAborted(); if (validatedToken) store.session(validatedToken, origin); return value; };
        if (url.search && !(req.method === 'GET' && /^\/v1\/organizations\/[a-f0-9-]+\/(audit|invoices|webhooks\/deliveries)$/.test(url.pathname))) throw new OrganizationError(400, 'QUERY_DENIED');
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
        const draft=/^\/v1\/organizations\/([^/]+)\/tax-drafts(?:\/([^/]+)(?:\/([^/]+)(?:\/(abandon))?)?)?$/.exec(url.pathname);
        if(draft){if(draft[4]&&draft[2]!=='requests')throw new OrganizationError(404,'NOT_FOUND');const org=parse(Id,draft[1]),id=draft[2],action=draft[3],services=options.draftServices??{},check=()=>{signal.throwIfAborted();store.session(token,origin);};
          if(!id&&req.method==='GET'){send(200,await store.taxDrafts.list(org,actor,services,signal,check));return;}
          if(!id&&req.method==='POST'){store.taxDrafts.authorizeCreate(org,actor);const v=await input(z.unknown(),131072);send(200,await store.taxDrafts.create(org,actor,v,services,signal,check));return;}
          if(id==='requests'&&action){if(!draft[4]&&req.method==='GET'){send(200,store.taxDrafts.generation(org,actor,parse(Id,action)));return;}if(draft[4]&&req.method==='POST'){const v=await input(Input.version);send(200,store.taxDrafts.abandon(org,actor,parse(Id,action),v.version));return;}}
          if(id&&!action&&req.method==='GET'){send(200,await store.taxDrafts.get(org,actor,parse(Id,id),services,signal,check));return;}
          if(id&&action==='revise'&&req.method==='POST'){store.taxDrafts.authorizeCreate(org,actor);const v=await input(z.unknown(),131072);send(200,await store.taxDrafts.create(org,actor,v,services,signal,check,parse(Id,id)));return;}
          if(id&&['submit','approve','changes_requested','reject','withdraw'].includes(action??'')&&req.method==='POST'){const v=await input(z.unknown());send(200,await store.taxDrafts.decide(org,actor,parse(Id,id),action as 'submit'|'approve'|'changes_requested'|'reject'|'withdraw',v,services,signal,check));return;}
          throw new OrganizationError(404,'NOT_FOUND');}
        const verification=/^\/v1\/organizations\/([^/]+)\/verification(?:\/(refresh|link|revoke))?$/.exec(url.pathname);
        if(verification){const org=parse(Id,verification[1]),action=verification[2],provider=options.verificationProvider;
          if(!action&&req.method==='GET'){
            const result=store.verifications.get(org,actor,provider);
            // A separate presentation-only approval never overwrites a provider case
            // or changes legal identity, organization permissions or signing claims.
            if(options.demoKyb&&!result.case)result.demo={mode:'hackathon',state:'approved',identityChecksPerformed:false,credentialIssued:false};
            send(200,result);return;
          }
          if(!action&&req.method==='POST'){const v=await input(z.unknown());send(200,store.verifications.create(org,actor,v,provider));return;}
          if(action&&req.method==='POST'){const v=await input(Input.version),check=()=>{signal.throwIfAborted();store.session(token,origin);};
            if(action==='revoke'){send(200,store.verifications.revoke(org,actor,v.version,provider));return;}
            send(200,action==='refresh'?await store.verifications.refresh(org,actor,v.version,provider,signal,check):await store.verifications.link(org,actor,v.version,provider,signal,check));return;}
          throw new OrganizationError(404,'NOT_FOUND');}
        const batch = /^\/v1\/organizations\/([^/]+)\/payout-batches(?:\/([^/]+))?$/.exec(url.pathname);
        if(batch){
          const org=parse(Id,batch[1]),id=batch[2];
          if(!id&&req.method==='GET'){send(200,{items:store.payoutBatches.list(org,actor)});return;}
          if(!id&&req.method==='POST'){const value=await input(z.unknown());send(200,store.payoutBatches.create(org,actor,value));return;}
          if(id==='stage'&&req.method==='POST'){const value=await input(z.unknown());const result=await store.payoutBatches.stage(org,actor,value,()=>{signal.throwIfAborted();store.session(token,origin);});signal.throwIfAborted();send(200,result);return;}
          if(id&&id!=='stage'&&req.method==='GET'){send(200,store.payoutBatches.get(org,actor,parse(Id,id)));return;}
          throw new OrganizationError(404,'NOT_FOUND');
        }
        const webhook = /^\/v1\/organizations\/([^/]+)\/webhooks(?:\/([^/]+)(?:\/([^/]+)(?:\/(retry))?)?)?$/.exec(url.pathname);
        if(webhook){
          const org=parse(Id,webhook[1]),resource=webhook[2],target=webhook[3],action=webhook[4];
          if(!resource&&req.method==='GET'){send(200,{items:store.webhooks.endpoints(org,actor)});return;}
          if(!resource&&req.method==='POST'){const value=await input(z.unknown());const result=store.webhooks.create(org,actor,value);send(result.replayed?200:201,result);return;}
          if(resource==='deliveries'){
            if(!target&&req.method==='GET'){
              const cursor=url.searchParams.get('before');if([...url.searchParams.keys()].some(k=>k!=='before')||url.searchParams.getAll('before').length>1||(cursor!==null&&(!/^[1-9][0-9]{0,15}$/.test(cursor)||!Number.isSafeInteger(Number(cursor)))))throw new OrganizationError(400,'INVALID_CURSOR');
              send(200,store.webhooks.deliveries(org,actor,cursor===null?undefined:Number(cursor)));return;
            }
            if(target&&!action&&req.method==='GET'){send(200,store.webhooks.detail(org,actor,parse(Id,target)));return;}
            if(target&&action==='retry'&&req.method==='POST'){const value=await input(Input.version);send(200,store.webhooks.retry(org,actor,parse(Id,target),value.version));return;}
          }else if(resource&&['pause','resume','rotate'].includes(target??'')&&req.method==='POST'){const value=await input(z.unknown());send(200,store.webhooks.update(org,actor,parse(Id,resource),target as 'pause'|'resume'|'rotate',value));return;}
          throw new OrganizationError(404,'NOT_FOUND');
        }
        const invoice = /^\/v1\/organizations\/([^/]+)\/invoices(?:\/([^/]+))?$/.exec(url.pathname);
        if (invoice) {
          const org = parse(Id, invoice[1]), id = invoice[2] ? parse(Id, invoice[2]) : undefined;
          if (!id && req.method === 'GET') {
            const cursor = url.searchParams.get('before');
            if ([...url.searchParams.keys()].some(k => k !== 'before') || url.searchParams.getAll('before').length > 1 || (cursor !== null && (!/^[1-9][0-9]{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))) throw new OrganizationError(400, 'INVALID_CURSOR');
            send(200, store.invoices.list(org, actor, cursor === null ? undefined : Number(cursor))); return;
          }
          if (!id && req.method === 'POST') {
            const value = await input(z.unknown());
            const result = await store.invoices.create(org, actor, value, options.identity, signal, () => { signal.throwIfAborted(); store.session(token, origin); });
            signal.throwIfAborted(); send(result.replayed ? 200 : 201, result); return;
          }
          if (id && req.method === 'GET') { send(200, store.invoices.get(org, actor, id)); return; }
          throw new OrganizationError(404, 'NOT_FOUND');
        }
        const payment = /^\/v1\/organizations\/([^/]+)\/payments(?:\/([^/]+)(?:\/(approve|reject|cancel|authorize))?)?$/.exec(url.pathname);
        if (payment) {
          const org = parse(Id,payment[1]), id = payment[2] ? parse(Id,payment[2]) : undefined, action = payment[3];
          if (!id && req.method === 'GET') { send(200,{items:store.payments.list(org,actor)});return; }
          if (!id && req.method === 'POST') { const content=await input(z.unknown());const result=await store.payments.create(org,actor,content,()=>{signal.throwIfAborted();store.session(token,origin);});signal.throwIfAborted();send(201,result);return; }
          if (id && !action && req.method === 'GET') { send(200,store.payments.get(org,actor,id));return; }
          if (id && action && req.method === 'POST') {
            if (action==='authorize') {
              const value=await input(z.object({contentHash:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['payment','prerequisite']),call:z.unknown()}).strict());
              send(200,store.payments.authorize(org,actor,id,value.contentHash,value.kind,value.call));return;
            }
            const value=await input(z.object({contentHash:z.string().regex(/^[a-f0-9]{64}$/),version:z.number().int().positive().safe()}).strict());
            send(200,store.payments.decide(org,actor,id,action as 'approve'|'reject'|'cancel',value.version,value.contentHash));return;
          }
          throw new OrganizationError(404,'NOT_FOUND');
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
