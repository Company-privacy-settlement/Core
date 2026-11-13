import { canonical } from './crypto.js';
import { account } from './payment.js';

export const ORGANIZATION_ROLES = Object.freeze(['owner', 'admin', 'operator', 'viewer', 'auditor'] as const);
export type OrganizationRole = typeof ORGANIZATION_ROLES[number];
export const ORGANIZATION_PERMISSIONS = Object.freeze(['organization.read', 'organization.update', 'members.read', 'members.manage', 'invitations.manage', 'audit.read', 'ownership.transfer', 'payments.read', 'payments.create', 'payments.approve', 'payments.execute'] as const);
export type OrganizationPermission = typeof ORGANIZATION_PERMISSIONS[number];
export const ORGANIZATION_ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, readonly OrganizationPermission[]>> = Object.freeze({
  owner: ORGANIZATION_PERMISSIONS,
  admin: Object.freeze(['organization.read', 'organization.update', 'members.read', 'members.manage', 'invitations.manage', 'audit.read', 'payments.read', 'payments.create', 'payments.approve', 'payments.execute'] as const),
  operator: Object.freeze(['organization.read', 'members.read', 'payments.read', 'payments.create', 'payments.execute'] as const),
  viewer: Object.freeze(['organization.read'] as const),
  auditor: Object.freeze(['organization.read', 'members.read', 'audit.read', 'payments.read'] as const),
});
export type Organization = { id: string; name: string; ownerAccount: string; version: number; membershipVersion: number; createdAt: string; role: OrganizationRole; permissions: OrganizationPermission[]; claims: { kybVerified: false; walletSigningAuthorityGranted: false } };
export type OrganizationMember = { accountId: string; role: OrganizationRole; status: 'active' | 'revoked'; version: number; joinedAt: string };
export type OrganizationInvitation = { id: string; organizationId: string; organizationName: string; accountId: string; role: Exclude<OrganizationRole, 'owner'>; status: 'pending' | 'accepted' | 'revoked' | 'declined' | 'expired'; version: number; expiresAt: string; createdAt: string; createdBy: string };
export type OrganizationAudit = { sequence: number; actor: string; action: string; target: string; detail: Record<string, unknown>; occurredAt: string };
export type OrganizationChallenge = { id: string; accountId: string; network: 'testnet'; audience: string; origin: string; nonce: string; expiresAt: string; recipient: string; message: string };
export type OrganizationSession = { accountId: string; token: string; expiresAt: string };
export function organizationOrigin(value: string): string {
  const u = new URL(value);
  if (u.origin !== value || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('Use an exact HTTPS service origin or loopback HTTP origin');
  return value;
}
export function organizationLoginMessage(c: Pick<OrganizationChallenge, 'accountId' | 'audience' | 'origin' | 'expiresAt'>): string {
  return canonical({ purpose: 'Sign in to Core Organizations', version: 1, network: 'testnet', ...c });
}
export function parseOrganizationChallenge(value: unknown, accountId: string, audience: string, origin: string, now = Date.now()): OrganizationChallenge {
  const c = value as OrganizationChallenge;
  if (!c || typeof c !== 'object' || Object.keys(c).sort().join('|') !== 'accountId|audience|expiresAt|id|message|network|nonce|origin|recipient' ||
    typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/.test(c.id) || c.accountId !== account(accountId) || c.audience !== organizationOrigin(audience) || c.origin !== organizationOrigin(origin) || c.network !== 'testnet' ||
    typeof c.nonce !== 'string' || c.nonce.length !== 64 || !/^[a-f0-9]{64}$/.test(c.nonce) || c.recipient !== new URL(audience).host ||
    !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= now || Date.parse(c.expiresAt) > now + 360_000 ||
    c.message !== organizationLoginMessage({ accountId, audience, origin, expiresAt: c.expiresAt })) throw new Error('Organization login challenge binding mismatch');
  return c;
}
/** NEP-413 payload, without a callback URL. Distinct from invoice signing. */
export async function organizationSigningDigest(c: OrganizationChallenge): Promise<Uint8Array<ArrayBuffer>> {
  const str = (value: string) => { const b = new TextEncoder().encode(value), n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, b.length, true); return [...n, ...b]; };
  const tag = new Uint8Array(4); new DataView(tag.buffer).setUint32(0, 2147484061, true);
  const nonce = Uint8Array.from(c.nonce.match(/../g)!.map(v => parseInt(v, 16)));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from([...tag, ...str(c.message), ...nonce, ...str(c.recipient), 0])));
}
export class OrganizationApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Sessions are supplied explicitly; this client never persists credentials. */
export class OrganizationClient {
  readonly origin: string;
  constructor(origin: string, private token?: string) { this.origin = organizationOrigin(origin); }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, this.origin);
    if (!path.startsWith('/') || url.origin !== this.origin || !/^\/(?:v1\/(?:auth|me|organizations)(?:\/[a-zA-Z0-9_.-]+)*|healthz)$/.test(url.pathname) || url.hash || (url.search && !(url.pathname.endsWith('/audit') && /^\?before=[1-9][0-9]{0,15}$/.test(url.search)))) throw new Error('Invalid organization API path');
    const response = await fetch(this.origin + path, { method, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let value;
    try { value = await response.json(); }
    catch (error) {
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      throw new OrganizationApiError(response.ok ? 502 : response.status, response.ok ? 'INVALID_RESPONSE' : 'ORGANIZATION_REQUEST_FAILED');
    }
    if (!response.ok) throw new OrganizationApiError(response.status, typeof value?.error === 'string' ? value.error : 'ORGANIZATION_REQUEST_FAILED');
    return value as T;
  }
}
