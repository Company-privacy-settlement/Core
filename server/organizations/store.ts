import { OrganizationTaxDrafts,taxDraftSchema } from './tax-drafts.js';
import { OrganizationVerifications, verificationSchema } from './verification.js';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ORGANIZATION_ROLE_PERMISSIONS, organizationLoginMessage, type Organization, type OrganizationAudit, type OrganizationChallenge, type OrganizationInvitation, type OrganizationMember, type OrganizationPermission, type OrganizationRole } from '../../sdk/client/organizations.js';
import { canGrant, OrganizationError, requirePermission, versionMatches } from './model.js';
import { assertOrganizationReady, recoverySchema } from './recovery-state.js';
import { OrganizationPayments, organizationPaymentsSchema } from './payments.js';
import { OrganizationInvoices, organizationInvoicesSchema } from './invoices.js';
import { OrganizationPayoutBatches, payoutBatchesSchema } from './payout-batches.js';
import { OrganizationWebhooks, webhookSchema } from './webhooks.js';
import type { InvoiceKeys } from './invoice-keys.js';

type OrgRow = { id: string; name: string; owner: string; version: number; created: number };
type MemberRow = { org: string; account: string; role: OrganizationRole; status: 'active' | 'revoked'; version: number; joined: number };
type InviteRow = { id: string; org: string; name: string; account: string; role: Exclude<OrganizationRole, 'owner'>; status: OrganizationInvitation['status']; version: number; expires: number; created: number; creator: string; creator_version: number };
export type SessionIdentity = { accountId: string; publicKey: string; origin: string; expires: number };
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const date = (value: number) => new Date(value).toISOString();
const token = () => randomBytes(32).toString('base64url');

export class OrganizationStore {
  private db: DatabaseSync;
  readonly payments: OrganizationPayments;
  readonly invoices: OrganizationInvoices;
  readonly webhooks: OrganizationWebhooks;
  readonly payoutBatches: OrganizationPayoutBatches;
  readonly verifications: OrganizationVerifications;
  readonly taxDrafts: OrganizationTaxDrafts;
  constructor(filename: string, readonly audience: string, readonly now: () => number = Date.now, invoiceKeys?: InvoiceKeys, webhookOrigins: readonly string[] = []) {
    if (filename !== ':memory:') {
      filename = resolve(filename); mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(filename, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      if (!lstatSync(filename).isFile() || (lstatSync(filename).mode & 0o077)) throw new Error('Organization database must be an owner-only regular file');
    }
    this.db = new DatabaseSync(filename);
    try {
      const tables = this.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      if (tables.length) {
        if (!tables.some(t => t.name === 'organization_meta')) throw new Error('Unrelated organization database');
        const meta = this.get<{ version: number; audience: string; network: string }>('SELECT * FROM organization_meta WHERE id=1');
        assertOrganizationReady(this.db);
        if (!meta || meta.version !== 1 || meta.audience !== audience || meta.network !== 'testnet') throw new Error('Organization database schema or audience mismatch');
      }
      this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS organization_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,audience TEXT NOT NULL,network TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS organization_members(org TEXT NOT NULL REFERENCES organizations(id),account TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','viewer','auditor')),status TEXT NOT NULL CHECK(status IN ('active','revoked')),version INTEGER NOT NULL,joined INTEGER NOT NULL,PRIMARY KEY(org,account));
        CREATE UNIQUE INDEX IF NOT EXISTS organization_one_owner ON organization_members(org) WHERE role='owner' AND status='active';
        CREATE INDEX IF NOT EXISTS organization_member_account ON organization_members(account,status);
        CREATE TABLE IF NOT EXISTS organization_invitations(id TEXT PRIMARY KEY,org TEXT NOT NULL REFERENCES organizations(id),account TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer','auditor')),status TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL,creator TEXT NOT NULL,creator_version INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS organization_pending_invite ON organization_invitations(org,account) WHERE status='pending';
        CREATE INDEX IF NOT EXISTS organization_invitation_account ON organization_invitations(account,status);
        CREATE TABLE IF NOT EXISTS organization_audit(sequence INTEGER NOT NULL,org TEXT NOT NULL REFERENCES organizations(id),actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,occurred INTEGER NOT NULL,PRIMARY KEY(org,sequence));
        CREATE INDEX IF NOT EXISTS organization_audit_org ON organization_audit(org,sequence);
        CREATE TABLE IF NOT EXISTS organization_challenges(id TEXT PRIMARY KEY,body TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS organization_sessions(hash TEXT PRIMARY KEY,account TEXT NOT NULL,public_key TEXT NOT NULL,origin TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS organization_sessions_account ON organization_sessions(account,expires);`);
      this.run('INSERT OR IGNORE INTO organization_meta VALUES(1,1,?,?)', audience, 'testnet');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(recoverySchema);
      this.db.exec(organizationPaymentsSchema);
      this.db.exec(organizationInvoicesSchema);
      this.db.exec(webhookSchema);
      this.db.exec(payoutBatchesSchema);
      this.db.exec(verificationSchema);
      this.db.exec(taxDraftSchema);
      this.run("INSERT OR IGNORE INTO organization_recovery VALUES(1,1,'ready',NULL,?,NULL)", this.now());
      this.db.exec('COMMIT');
      this.payments = new OrganizationPayments({db:this.db,now:this.now,atomic:action=>this.atomic(action),authorize:(...args)=>this.authorize(...args),member:(...args)=>this.member(...args),audit:(...args)=>this.audit(...args)});
      this.invoices = new OrganizationInvoices({db:this.db,audience,now:this.now,keys:invoiceKeys,atomic:action=>this.atomic(action),authorize:(...args)=>this.authorize(...args),audit:(...args)=>this.audit(...args)});
      this.webhooks = new OrganizationWebhooks({db:this.db,audience,keys:invoiceKeys,now:this.now,allowed:new Set(webhookOrigins),atomic:action=>this.atomic(action),authorize:(...args)=>this.authorize(...args),audit:(...args)=>this.audit(...args)});
      this.taxDrafts = new OrganizationTaxDrafts({db:this.db,audience,now:this.now,keys:invoiceKeys,authorize:(...args)=>this.authorize(...args),member:(...args)=>this.member(...args),atomic:action=>this.atomic(action),audit:(...args)=>this.audit(...args)});
      this.verifications = new OrganizationVerifications({db:this.db,audience,now:this.now,keys:invoiceKeys,authorize:(...args)=>this.authorize(...args),atomic:action=>this.atomic(action),audit:(...args)=>this.audit(...args)});
      this.payoutBatches = new OrganizationPayoutBatches({db:this.db,now:this.now,payments:this.payments,authorize:(...args)=>this.authorize(...args),member:(...args)=>this.member(...args),atomic:action=>this.atomic(action),audit:(...args)=>this.audit(...args)});
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  private get<T>(sql: string, ...args: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  private all<T>(sql: string, ...args: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: (string | number | null)[]) { return this.db.prepare(sql).run(...args); }
  private atomic<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private audit(org: string, actor: string, action: string, target: string, detail: Record<string, unknown> = {}) {
    this.run('INSERT INTO organization_audit(sequence,org,actor,action,target,detail,occurred) VALUES((SELECT COALESCE(MAX(sequence),0)+1 FROM organization_audit WHERE org=?),?,?,?,?,?,?)', org, org, actor, action, target, JSON.stringify(detail), this.now());
  }
  /** Called within a write transaction; membership revision is the grant boundary. */
  private revokeInvalidInvitations(org: string, actor: string) {
    const rows = this.all<InviteRow>("SELECT * FROM organization_invitations WHERE org=? AND status='pending' AND expires>?", org, this.now());
    for (const row of rows) {
      const creator = this.member(org, row.creator);
      if (creator?.status === 'active' && creator.version === row.creator_version && canGrant(creator.role, row.role)) continue;
      this.run("UPDATE organization_invitations SET status='revoked',version=version+1 WHERE id=?", row.id);
      this.audit(org, actor, 'invitation.revoked', row.account, { invitationId: row.id, reason: 'INVITER_MEMBERSHIP_CHANGED' });
    }
  }
  private org(id: string): OrgRow {
    const row = this.get<OrgRow>('SELECT * FROM organizations WHERE id=?', id);
    if (!row) throw new OrganizationError(404, 'ORGANIZATION_NOT_FOUND'); return row;
  }
  private member(org: string, account: string): MemberRow | undefined { return this.get<MemberRow>('SELECT * FROM organization_members WHERE org=? AND account=?', org, account); }
  authorize(org: string, account: string, permission: OrganizationPermission): OrganizationRole {
    const row = this.member(org, account);
    // Hide both absent and foreign organization IDs from nonmembers.
    if (!row || row.status !== 'active') throw new OrganizationError(404, 'ORGANIZATION_NOT_FOUND');
    requirePermission(row.role, permission); return row.role;
  }
  private orgView(row: OrgRow, role: OrganizationRole, membershipVersion: number): Organization {
    return { id: row.id, name: row.name, ownerAccount: row.owner, version: row.version, membershipVersion, createdAt: date(row.created), role, permissions: [...ORGANIZATION_ROLE_PERMISSIONS[role]], claims: { kybVerified: false, walletSigningAuthorityGranted: false } };
  }
  list(account: string): Organization[] {
    return this.all<OrgRow & { role: OrganizationRole; membershipVersion: number }>("SELECT o.*,m.role,m.version AS membershipVersion FROM organizations o JOIN organization_members m ON o.id=m.org WHERE m.account=? AND m.status='active' ORDER BY o.created,o.id LIMIT 100", account).map(row => this.orgView(row, row.role, row.membershipVersion));
  }
  detail(id: string, actor: string): Organization { const role = this.authorize(id, actor, 'organization.read'); return this.orgView(this.org(id), role, this.member(id, actor)!.version); }
  create(actor: string, name: string): Organization {
    return this.atomic(() => {
      const owned = this.get<{ n: number }>('SELECT COUNT(*) n FROM organizations WHERE owner=?', actor)!.n;
      if (owned >= 10 || this.activeMemberships(actor) >= 100) throw new OrganizationError(409, 'ORGANIZATION_LIMIT');
      const id = randomUUID(), now = this.now();
      this.run('INSERT INTO organizations VALUES(?,?,?,1,?)', id, name, actor, now);
      this.run("INSERT INTO organization_members VALUES(?,?,?,'active',1,?)", id, actor, 'owner', now);
      this.audit(id, actor, 'organization.created', id, { name }); return this.detail(id, actor);
    });
  }
  rename(id: string, actor: string, name: string, version: number) {
    return this.atomic(() => { this.authorize(id, actor, 'organization.update'); const row = this.org(id); versionMatches(row.version, version);
      this.run('UPDATE organizations SET name=?,version=version+1 WHERE id=?', name, id); this.audit(id, actor, 'organization.renamed', id, { previousName: row.name, name }); return this.detail(id, actor); });
  }
  members(id: string, actor: string): OrganizationMember[] {
    this.authorize(id, actor, 'members.read');
    return this.all<MemberRow>("SELECT * FROM organization_members WHERE org=? AND status='active' ORDER BY joined,account LIMIT 100", id).map(r => ({ accountId: r.account, role: r.role, status: r.status, version: r.version, joinedAt: date(r.joined) }));
  }
  changeRole(id: string, actor: string, target: string, role: Exclude<OrganizationRole, 'owner'>, version: number) {
    return this.atomic(() => {
      const acting = this.authorize(id, actor, 'members.manage'), member = this.member(id, target);
      if (!member || member.status !== 'active') throw new OrganizationError(404, 'MEMBER_NOT_FOUND');
      if (!canGrant(acting, member.role) || !canGrant(acting, role)) throw new OrganizationError(403, 'ROLE_GRANT_DENIED');
      versionMatches(member.version, version);
      this.run('UPDATE organization_members SET role=?,version=version+1 WHERE org=? AND account=?', role, id, target);
      this.audit(id, actor, 'member.role_changed', target, { previousRole: member.role, role });
      this.revokeInvalidInvitations(id, actor);
    });
  }
  remove(id: string, actor: string, target: string, version: number) {
    this.atomic(() => {
      const acting = this.authorize(id, actor, 'organization.read'), member = this.member(id, target);
      if (!member || member.status !== 'active') throw new OrganizationError(404, 'MEMBER_NOT_FOUND');
      if (member.role === 'owner') throw new OrganizationError(409, 'TRANSFER_OWNERSHIP_FIRST');
      if (target !== actor) { requirePermission(acting, 'members.manage'); if (!canGrant(acting, member.role)) throw new OrganizationError(403, 'ROLE_GRANT_DENIED'); }
      versionMatches(member.version, version);
      this.run("UPDATE organization_members SET status='revoked',version=version+1 WHERE org=? AND account=?", id, target);
      this.audit(id, actor, target === actor ? 'member.left' : 'member.removed', target, { previousRole: member.role });
      this.revokeInvalidInvitations(id, actor);
    });
  }
  transfer(id: string, actor: string, target: string, version: number) {
    return this.atomic(() => {
      this.authorize(id, actor, 'ownership.transfer'); const org = this.org(id); versionMatches(org.version, version);
      const member = this.member(id, target);
      if (target === actor || !member || member.status !== 'active') throw new OrganizationError(409, 'ACTIVE_SUCCESSOR_REQUIRED');
      if (this.get<{ n: number }>('SELECT COUNT(*) n FROM organizations WHERE owner=?', target)!.n >= 10) throw new OrganizationError(409, 'ORGANIZATION_LIMIT');
      this.run("UPDATE organization_members SET role='admin',version=version+1 WHERE org=? AND account=?", id, actor);
      this.run("UPDATE organization_members SET role='owner',version=version+1 WHERE org=? AND account=?", id, target);
      this.run('UPDATE organizations SET owner=?,version=version+1 WHERE id=?', target, id);
      this.audit(id, actor, 'ownership.transferred', target, { previousOwner: actor }); this.revokeInvalidInvitations(id, actor); return this.detail(id, actor);
    });
  }
  private activeMemberships(account: string) { return this.get<{ n: number }>("SELECT COUNT(*) n FROM organization_members WHERE account=? AND status='active'", account)!.n; }
  private inviteView(row: InviteRow): OrganizationInvitation {
    return { id: row.id, organizationId: row.org, organizationName: row.name, accountId: row.account, role: row.role, status: row.status === 'pending' && row.expires <= this.now() ? 'expired' : row.status, version: row.version, expiresAt: date(row.expires), createdAt: date(row.created), createdBy: row.creator };
  }
  invitations(id: string, actor: string): OrganizationInvitation[] {
    this.authorize(id, actor, 'invitations.manage');
    return this.all<InviteRow>("SELECT i.*,o.name FROM organization_invitations i JOIN organizations o ON o.id=i.org WHERE i.org=? AND i.status='pending' AND i.expires>? ORDER BY i.created,i.id LIMIT 100", id, this.now()).map(r => this.inviteView(r));
  }
  inbox(account: string): OrganizationInvitation[] {
    return this.all<InviteRow>("SELECT i.*,o.name FROM organization_invitations i JOIN organizations o ON o.id=i.org JOIN organization_members m ON m.org=i.org AND m.account=i.creator WHERE i.account=? AND i.status='pending' AND i.expires>? AND m.status='active' AND m.version=i.creator_version AND (m.role='owner' OR (m.role='admin' AND i.role!='admin')) ORDER BY i.created,i.id LIMIT 100", account, this.now()).map(r => this.inviteView(r));
  }
  invite(id: string, actor: string, target: string, role: Exclude<OrganizationRole, 'owner'>): OrganizationInvitation {
    return this.atomic(() => {
      const acting = this.authorize(id, actor, 'invitations.manage');
      if (!canGrant(acting, role)) throw new OrganizationError(403, 'ROLE_GRANT_DENIED');
      if (this.member(id, target)?.status === 'active') throw new OrganizationError(409, 'ALREADY_A_MEMBER');
      this.revokeInvalidInvitations(id, actor);
      this.run("UPDATE organization_invitations SET status='expired',version=version+1 WHERE org=? AND account=? AND status='pending' AND expires<=?", id, target, this.now());
      if (this.get("SELECT id FROM organization_invitations WHERE org=? AND account=? AND status='pending'", id, target)) throw new OrganizationError(409, 'INVITATION_EXISTS');
      const count = this.get<{ n: number }>("SELECT COUNT(*) n FROM organization_invitations WHERE org=? AND status='pending' AND expires>?", id, this.now())!.n;
      if (count >= 100 || this.inbox(target).length >= 100) throw new OrganizationError(409, 'INVITATION_LIMIT');
      const key = randomUUID(), now = this.now(), expires = now + 7 * 86400_000;
      const creatorVersion = this.member(id, actor)!.version;
      this.run("INSERT INTO organization_invitations VALUES(?,?,?,?,'pending',1,?,?,?,?)", key, id, target, role, expires, now, actor, creatorVersion);
      this.audit(id, actor, 'invitation.created', target, { invitationId: key, role, expiresAt: date(expires) });
      return this.inviteView({ id: key, org: id, name: this.org(id).name, account: target, role, status: 'pending', version: 1, expires, created: now, creator: actor, creator_version: creatorVersion });
    });
  }
  revokeInvite(id: string, actor: string, inviteId: string, version: number) {
    this.atomic(() => {
      const acting = this.authorize(id, actor, 'invitations.manage');
      const row = this.get<InviteRow>('SELECT * FROM organization_invitations WHERE org=? AND id=?', id, inviteId);
      if (!row) throw new OrganizationError(404, 'INVITATION_NOT_FOUND');
      if (!canGrant(acting, row.role)) throw new OrganizationError(403, 'ROLE_GRANT_DENIED');
      versionMatches(row.version, version);
      if (row.status !== 'pending') throw new OrganizationError(409, 'INVITATION_NOT_PENDING');
      this.run("UPDATE organization_invitations SET status='revoked',version=version+1 WHERE id=?", inviteId);
      this.audit(id, actor, 'invitation.revoked', row.account, { invitationId: inviteId });
    });
  }
  respondInvite(inviteId: string, actor: string, accept: boolean, version: number) {
    return this.atomic(() => {
      const row = this.get<InviteRow>('SELECT * FROM organization_invitations WHERE id=? AND account=?', inviteId, actor);
      if (!row) throw new OrganizationError(404, 'INVITATION_NOT_FOUND');
      versionMatches(row.version, version);
      if (row.status !== 'pending' || row.expires <= this.now()) throw new OrganizationError(409, 'INVITATION_NOT_PENDING');
      if (accept) {
        const inviter = this.member(row.org, row.creator);
        if (!inviter || inviter.status !== 'active' || inviter.version !== row.creator_version || !canGrant(inviter.role, row.role)) throw new OrganizationError(409, 'INVITATION_AUTHORITY_REVOKED');
        if (this.member(row.org, actor)?.status === 'active') throw new OrganizationError(409, 'ALREADY_A_MEMBER');
        const count = this.get<{ n: number }>("SELECT COUNT(*) n FROM organization_members WHERE org=? AND status='active'", row.org)!.n;
        if (count >= 100 || this.activeMemberships(actor) >= 100) throw new OrganizationError(409, 'MEMBER_LIMIT');
        this.run("INSERT INTO organization_members VALUES(?,?,?,'active',1,?) ON CONFLICT(org,account) DO UPDATE SET role=excluded.role,status='active',version=organization_members.version+1,joined=excluded.joined", row.org, actor, row.role, this.now());
      }
      this.run('UPDATE organization_invitations SET status=?,version=version+1 WHERE id=?', accept ? 'accepted' : 'declined', inviteId);
      this.audit(row.org, actor, accept ? 'invitation.accepted' : 'invitation.declined', actor, { invitationId: inviteId, role: row.role });
      return accept ? this.detail(row.org, actor) : null;
    });
  }
  auditPage(id: string, actor: string, before?: number): { items: OrganizationAudit[]; nextCursor: number | null } {
    this.authorize(id, actor, 'audit.read');
    const rows = this.all<{ sequence: number; actor: string; action: string; target: string; detail: string; occurred: number }>('SELECT * FROM organization_audit WHERE org=? AND sequence<? ORDER BY sequence DESC LIMIT 51', id, before ?? Number.MAX_SAFE_INTEGER);
    const page = rows.slice(0, 50); return { items: page.map(r => ({ sequence: r.sequence, actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail), occurredAt: date(r.occurred) })), nextCursor: rows.length > 50 ? page.at(-1)!.sequence : null };
  }
  challenge(accountId: string, origin: string): OrganizationChallenge {
    return this.atomic(() => {
      this.run('DELETE FROM organization_challenges WHERE expires<=?', this.now());
      if (this.get<{ n: number }>('SELECT COUNT(*) n FROM organization_challenges')!.n >= 1024) throw new OrganizationError(503, 'CHALLENGE_CAPACITY');
      const fields = { accountId, audience: this.audience, origin, expiresAt: date(this.now() + 300_000) };
      const value: OrganizationChallenge = { ...fields, id: randomUUID(), network: 'testnet', nonce: randomBytes(32).toString('hex'), recipient: new URL(this.audience).host, message: organizationLoginMessage(fields) };
      this.run('INSERT INTO organization_challenges VALUES(?,?,?)', value.id, JSON.stringify(value), Date.parse(value.expiresAt)); return value;
    });
  }
  getChallenge(id: string, origin: string): OrganizationChallenge {
    const row = this.get<{ body: string; expires: number }>('SELECT * FROM organization_challenges WHERE id=?', id);
    if (!row || row.expires <= this.now()) throw new OrganizationError(401, 'CHALLENGE_INVALID');
    const challenge = JSON.parse(row.body) as OrganizationChallenge;
    if (challenge.origin !== origin) throw new OrganizationError(401, 'CHALLENGE_INVALID'); return challenge;
  }
  issueSession(challengeId: string, origin: string, publicKey: string) {
    return this.atomic(() => {
      const c = this.getChallenge(challengeId, origin);
      this.run('DELETE FROM organization_challenges WHERE id=?', challengeId);
      this.run('DELETE FROM organization_sessions WHERE expires<=?', this.now());
      const sessions = this.all<{ hash: string }>('SELECT hash FROM organization_sessions WHERE account=? ORDER BY expires DESC', c.accountId);
      for (const row of sessions.slice(9)) this.run('DELETE FROM organization_sessions WHERE hash=?', row.hash);
      const value = token(), expires = this.now() + 3600_000;
      this.run('INSERT INTO organization_sessions VALUES(?,?,?,?,?)', tokenHash(value), c.accountId, publicKey, origin, expires);
      return { accountId: c.accountId, token: value, expiresAt: date(expires) };
    });
  }
  session(value: string, origin: string): SessionIdentity {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || value.length !== 43) throw new OrganizationError(401, 'SESSION_INVALID');
    const row = this.get<{ account: string; public_key: string; origin: string; expires: number }>('SELECT * FROM organization_sessions WHERE hash=?', tokenHash(value));
    if (!row || row.expires <= this.now() || row.origin !== origin) throw new OrganizationError(401, 'SESSION_INVALID');
    return { accountId: row.account, publicKey: row.public_key, origin: row.origin, expires: row.expires };
  }
  logout(value: string) { this.run('DELETE FROM organization_sessions WHERE hash=?', tokenHash(value)); }
}
