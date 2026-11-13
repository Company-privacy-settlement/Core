import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { z } from 'zod';
import { organizationOrigin, organizationSigningDigest } from '../../sdk/client/organizations.js';
import { Id, OrganizationAccount, OrganizationError } from './model.js';
import { OrganizationStore } from './store.js';

export interface OrganizationIdentitySource {
  currentFullAccessKey(accountId: string, publicKey: string, signal: AbortSignal): Promise<boolean>;
}
export const OrganizationLogin = z.object({ challengeId: Id, accountId: OrganizationAccount, publicKey: z.string().max(52).regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/), signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export class OrganizationAuth {
  constructor(private store: OrganizationStore, private source: OrganizationIdentitySource) {}
  async login(origin: string, input: z.infer<typeof OrganizationLogin>, signal: AbortSignal) {
    const c = this.store.getChallenge(input.challengeId, origin);
    if (c.accountId !== input.accountId) throw new OrganizationError(401, 'SIGNATURE_INVALID');
    let valid = false;
    try {
      const raw = bs58.decode(input.publicKey.slice(8));
      if (raw.length !== 32) throw new Error('Invalid key');
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
      valid = verify(null, await organizationSigningDigest(c), key, Buffer.from(input.signature, 'base64'));
    } catch { valid = false; }
    if (!valid) throw new OrganizationError(401, 'SIGNATURE_INVALID');
    if (!await this.source.currentFullAccessKey(input.accountId, input.publicKey, signal)) throw new OrganizationError(401, 'FULL_ACCESS_KEY_REVOKED');
    signal.throwIfAborted();
    // Re-read and consume inside one write transaction after asynchronous chain checks.
    return this.store.issueSession(c.id, origin, input.publicKey);
  }
  async identity(token: string, origin: string, signal: AbortSignal) {
    const session = this.store.session(token, origin);
    if (!await this.source.currentFullAccessKey(session.accountId, session.publicKey, signal)) {
      this.store.logout(token); throw new OrganizationError(401, 'FULL_ACCESS_KEY_REVOKED');
    }
    signal.throwIfAborted();
    // Revocation/logout or expiry during RPC must win over the old snapshot.
    return this.store.session(token, origin);
  }
}

/** Read-only transport. No registry, signing key or transaction submission is involved. */
export class NearOrganizationIdentity implements OrganizationIdentitySource {
  readonly rpcUrl: string;
  constructor(rpcUrl: string) {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS_VERIFICATION_MUST_STAY_ENABLED');
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Organization identity requires an HTTPS testnet RPC');
    this.rpcUrl = url.href;
  }
  private async rpc(method: string, params: unknown, signal: AbortSignal) {
    const response = await fetch(this.rpcUrl, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'core-organization-identity', method, params }) });
    if (!response.ok) throw new OrganizationError(503, 'IDENTITY_CHAIN_UNAVAILABLE');
    if (!response.body) throw new OrganizationError(503, 'IDENTITY_CHAIN_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length;
        if (total > 128_000) { await reader.cancel(); throw new OrganizationError(503, 'IDENTITY_CHAIN_UNAVAILABLE'); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8');
    const value = JSON.parse(text);
    if (value.error) {
      const name = value.error?.cause?.name ?? value.error?.data?.name;
      if (method === 'query' && ['UNKNOWN_ACCOUNT', 'UNKNOWN_ACCESS_KEY'].includes(name)) return null;
      throw new OrganizationError(503, 'IDENTITY_CHAIN_UNAVAILABLE');
    }
    return value.result;
  }
  async currentFullAccessKey(accountId: string, publicKey: string, signal: AbortSignal): Promise<boolean> {
    try {
      const status = z.object({ chain_id: z.literal('testnet'), sync_info: z.object({ syncing: z.literal(false), latest_block_time: z.string() }) }).parse(await this.rpc('status', [], signal));
      const latest = Date.parse(status.sync_info.latest_block_time), now = Date.now();
      if (!Number.isFinite(latest) || now - latest > 120_000 || latest - now > 30_000) throw new Error('Stale chain');
      const block = z.object({ header: z.object({ height: z.number().int().nonnegative().safe(), hash: z.string().min(32).max(64), timestamp_nanosec: z.string().regex(/^[0-9]{1,20}$/) }) }).parse(await this.rpc('block', { finality: 'final' }, signal));
      const time = Number(BigInt(block.header.timestamp_nanosec) / 1000000n);
      if (now - time > 120_000 || time - now > 30_000) throw new Error('Stale finalized block');
      const key = await this.rpc('query', { request_type: 'view_access_key', account_id: accountId, public_key: publicKey, block_id: block.header.hash }, signal);
      if (key === null) return false;
      const snapshot = z.object({ block_hash: z.literal(block.header.hash), block_height: z.literal(block.header.height), permission: z.unknown() }).parse(key);
      return snapshot.permission === 'FullAccess';
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof OrganizationError) throw e;
      throw new OrganizationError(503, 'IDENTITY_CHAIN_UNAVAILABLE');
    }
  }
}
export { organizationOrigin };
