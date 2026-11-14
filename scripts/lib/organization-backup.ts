import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { organizationOrigin } from '../../sdk/client/organizations.js';
import { Id, OrganizationAccount, Role, Version } from '../../server/organizations/model.js';
import { recoverySchema } from '../../server/organizations/recovery-state.js';
import { fileDigest } from './index-backup.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = Version.max(Number.MAX_SAFE_INTEGER - 1);
const Review = z.object({
  format: z.literal('core-organization-access-review-v1'), network: z.literal('testnet'), audience: z.string(),
  recoveryId: Id, databaseSha256: Hash, reviewedAt: z.string().datetime(),
  organizations: z.array(z.object({
    id: Id, ownerAccount: OrganizationAccount, currentVersion: Revision,
    members: z.array(z.object({ accountId: OrganizationAccount, role: Role, currentVersion: Revision }).strict()).min(1).max(100),
  }).strict()).max(1000),
}).strict();
const columns: Record<string, string[]> = {
  organization_meta: ['id','version','audience','network'], organizations: ['id','name','owner','version','created'],
  organization_members: ['org','account','role','status','version','joined'],
  organization_invitations: ['id','org','account','role','status','version','expires','created','creator','creator_version'],
  organization_audit: ['sequence','org','actor','action','target','detail','occurred'],
  organization_challenges: ['id','body','expires'], organization_sessions: ['hash','account','public_key','origin','expires'],
  organization_recovery: ['id','version','state','recovery_id','created','review_sha256'],
  organization_payments: ['id','org','payload','content_hash','maker','creator_version','state','version','expires','approver','approver_version','approved','created','spend_key'],
  organization_payment_dispatches: ['payment_id','call_hash','kind','actor','created'],
  organization_invoices: ['id','org','sequence','created','key_id','nonce','ciphertext','tag','natural_hash','payload_hash'],
  organization_invoice_requests: ['org','request_hash','invoice_id','payload_hash'],
  organization_invoice_key_checks: ['purpose','key_id','check_value'],
  organization_webhook_endpoints: ['id','org','url_hash','payload_hash','key_id','sealed','state','version','created'],
  organization_webhook_requests: ['org','request_hash','endpoint_id','payload_hash'],
  organization_webhook_events: ['id','org','invoice_id','identity_hash','key_id','sealed','created'],
  organization_webhook_deliveries: ['id','org','sequence','event_id','endpoint_id','state','version','attempts','cycle_attempts','redrives','due','lease','lease_until','last_error','created'],
  organization_webhook_attempts: ['delivery_id','number','lease','started','finished','outcome','http_status','error'],
  organization_payout_intents: ['org','intent_id','creator','payment_id','content_hash','category','created'],
  organization_payout_batches: ['id','org','request_id','creator','payload','content_hash','request_hash','created'],
  organization_verifications: ['id','org','created','version','dirty','revoked','expires','checked','key_id','nonce','ciphertext','tag','external_hash','next_attempt'],
  organization_verification_subjects: ['case_id','applicant_hash'],
  organization_verification_events: ['digest','created'],
  organization_tax_drafts: ['id','org','family_id','creator','creator_version','created','state','version','approver','approver_version','approved','approval_expires','key_id','sealed','payload_hash'],
  organization_tax_draft_heads: ['family_id','org','current_id'],
  organization_tax_draft_requests: ['org','request_hash','payload_hash','creator','state','version','draft_id','created','request_id'],
  organization_payout_rows: ['batch_id','ordinal','intent_id','payment_id'],
};
type Recovery = { state: 'ready' | 'quarantined'; recovery_id: string | null };

function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Expected an owner-only regular organization file');
}
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function clean(path: string) { for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true }); }
function emptyTarget(destination: string) {
  const target = resolve(destination);
  if (['', '-wal', '-shm', '-journal'].some(s => existsSync(target + s))) throw new Error('Organization maintenance requires a new destination; never overwrite a live database');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); return target;
}
function portable(path: string) {
  regular(path);
  if (['-wal', '-shm', '-journal'].some(s => existsSync(path + s))) throw new Error('Portable organization files must not depend on SQLite sidecars');
}
function inspect(path: string, audience: string) {
  regular(path); organizationOrigin(audience);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; BEGIN');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Organization SQLite integrity check failed');
    const objects = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    const tables = objects.filter(o => o.type === 'table').map(o => String(o.name));
    if (objects.some(o => ['trigger','view'].includes(String(o.type))) || tables.some(n => !Object.hasOwn(columns, n)) || Object.keys(columns).filter(n => !['organization_recovery','organization_payments','organization_payment_dispatches','organization_invoices','organization_invoice_requests','organization_invoice_key_checks','organization_webhook_endpoints','organization_webhook_requests','organization_webhook_events','organization_webhook_deliveries','organization_webhook_attempts','organization_payout_intents','organization_payout_batches','organization_payout_rows','organization_verifications','organization_verification_subjects','organization_verification_events','organization_tax_drafts','organization_tax_draft_heads','organization_tax_draft_requests'].includes(n)).some(n => !tables.includes(n)) || tables.includes('organization_payments') !== tables.includes('organization_payment_dispatches')) throw new Error('Unexpected organization schema');
    if (["organization_invoices","organization_invoice_requests","organization_invoice_key_checks"].filter(n => tables.includes(n)).length % 3 !== 0) throw new Error('Incomplete invoice schema');
    if (['organization_webhook_endpoints','organization_webhook_requests','organization_webhook_events','organization_webhook_deliveries','organization_webhook_attempts'].filter(n=>tables.includes(n)).length % 5 !== 0) throw new Error('Incomplete webhook schema');
    if(['organization_tax_drafts','organization_tax_draft_heads','organization_tax_draft_requests'].filter(n=>tables.includes(n)).length%3!==0)throw new Error('Incomplete tax draft schema');
    if(['organization_verifications','organization_verification_subjects','organization_verification_events'].filter(n=>tables.includes(n)).length%3!==0)throw new Error('Incomplete verification schema');
    if(['organization_payout_intents','organization_payout_batches','organization_payout_rows'].filter(n=>tables.includes(n)).length%3!==0)throw new Error('Incomplete payout schema');
    for (const name of tables) {
      const actual = db.prepare(`PRAGMA table_info(${name})`).all().map(c => String(c.name)); // name is from the closed inventory above.
      if (JSON.stringify(actual) !== JSON.stringify(columns[name])) throw new Error('Unexpected organization columns');
    }
    const meta = db.prepare('SELECT * FROM organization_meta').all();
    if (meta.length !== 1 || meta[0].id !== 1 || ![1,2].includes(Number(meta[0].version)) || meta[0].network !== 'testnet' || meta[0].audience !== audience) throw new Error('Organization schema, network or audience mismatch');
    const recovery = tables.includes('organization_recovery') ? db.prepare('SELECT * FROM organization_recovery').all() : [];
    if (tables.includes('organization_recovery') && (recovery.length !== 1 || recovery[0].id !== 1 || recovery[0].version !== 1 || !['ready','quarantined'].includes(String(recovery[0].state)))) throw new Error('Invalid organization recovery state');
    if (recovery[0]?.state === 'quarantined') Id.parse(recovery[0].recovery_id);
    if ((meta[0].version === 2) !== (recovery[0]?.state === 'quarantined')) throw new Error('Organization recovery envelope version mismatch');
    if (db.prepare("SELECT o.id FROM organizations o LEFT JOIN organization_members m ON m.org=o.id AND m.status='active' AND m.role='owner' GROUP BY o.id HAVING COUNT(m.account)!=1 OR MAX(m.account)!=o.owner LIMIT 1").get()) throw new Error('Organization owner invariant failed');
    for (const [name, field] of [['organizations','version'],['organization_members','version'],['organization_invitations','version'],['organization_audit','sequence']] as const) {
      if (db.prepare(`SELECT 1 FROM ${name} WHERE typeof(${field})!='integer' OR ${field}<1 OR ${field}>=? LIMIT 1`).get(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid organization revision');
    }
    const count = (name: string) => Number(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get()!.n);
    return { organizations: count('organizations'), members: count('organization_members'), auditEvents: count('organization_audit'),
      sessions: count('organization_sessions'), challenges: count('organization_challenges'),
      schemaVersion: Number(meta[0].version),
      journalMode: String(db.prepare('PRAGMA journal_mode').get()!.journal_mode),
      recovery: (recovery[0] ?? { state: 'ready', recovery_id: null }) as Recovery };
  } finally { db.close(); }
}
/** Every exported snapshot is non-servable, including if copied directly over a data file. */
function quarantine(path: string) {
  const db = new DatabaseSync(path), recoveryId = randomUUID();
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    db.exec(recoverySchema);
    db.exec('DELETE FROM organization_sessions; DELETE FROM organization_challenges; DELETE FROM organization_recovery');
    // Earlier service binaries only accept v1. They must also refuse a snapshot
    // rather than ignoring the newer optional recovery-state table.
    db.exec('UPDATE organization_meta SET version=2 WHERE id=1');
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='organization_payments'").get()) db.exec("UPDATE organization_payments SET state='invalidated',version=version+1 WHERE state IN ('pending','approved','dispatched')");
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='organization_tax_drafts'").get())db.exec("UPDATE organization_tax_drafts SET state='invalidated',version=version+1; UPDATE organization_tax_draft_requests SET state='abandoned',version=version+1 WHERE state='generating'");
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='organization_verifications'").get())db.exec('UPDATE organization_verifications SET revoked=1,dirty=1,version=version+1');
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='organization_webhook_endpoints'").get()){
      db.exec("UPDATE organization_webhook_endpoints SET state='paused',version=version+1; UPDATE organization_webhook_deliveries SET state='held',version=version+1,lease=NULL,lease_until=NULL,last_error='RECOVERY_HOLD' WHERE state IN ('pending','sending')");
      db.prepare("UPDATE organization_webhook_attempts SET outcome='unknown',error='RECOVERY_HOLD',finished=COALESCE(finished,?) WHERE outcome='sending'").run(Date.now());
    }
    db.prepare("INSERT INTO organization_recovery VALUES(1,1,'quarantined',?,?,NULL)").run(recoveryId, Date.now());
    db.exec('COMMIT; VACUUM'); return recoveryId;
  } finally { db.close(); }
}
async function publish(temp: string, target: string, audience: string) {
  const status = inspect(temp, audience); sync(temp);
  const sha256 = await fileDigest(temp); linkSync(temp, target); sync(dirname(target));
  return { file: target, bytes: lstatSync(target).size, sha256, audience, network: 'testnet' as const, status, createdAt: new Date().toISOString() };
}
export async function backupOrganizations(source: string, destination: string, audience: string) {
  inspect(source, audience);
  const target = emptyTarget(destination), temp = target + '.' + randomUUID() + '.tmp';
  closeSync(openSync(temp, 'wx', 0o600));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, temp); inspect(temp, audience); quarantine(temp);
    return { format: 'core-organization-backup-v1' as const, ...await publish(temp, target, audience) };
  } finally { db?.close(); clean(temp); }
}
export async function restoreOrganizations(source: string, expectedSha256: string, destination: string, audience: string) {
  Hash.parse(expectedSha256); portable(source);
  const target = emptyTarget(destination), temp = target + '.' + randomUUID() + '.restore';
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL); chmodSync(temp, 0o600);
    if (await fileDigest(temp) !== expectedSha256) throw new Error('Organization backup differs from the independently trusted digest');
    // WAL-dependent copies are never accepted as portable backups.
    const status = inspect(temp, audience);
    if (status.journalMode !== 'delete' || status.recovery.state !== 'quarantined' || status.sessions || status.challenges) throw new Error('Use a quarantined organization backup, not a raw database copy');
    quarantine(temp);
    return { restored: true, requiresAccessReview: true, sourceSha256: expectedSha256, ...await publish(temp, target, audience) };
  } finally { clean(temp); }
}
export async function organizationReviewTemplate(source: string, destination: string, audience: string) {
  portable(source);
  const status = inspect(source, audience);
  if (status.recovery.state !== 'quarantined' || status.organizations > 1000) throw new Error('Review requires a bounded quarantined database');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const template = { format: 'core-organization-access-review-v1', network: 'testnet', audience,
      recoveryId: status.recovery.recovery_id, databaseSha256: await fileDigest(source), reviewedAt: '',
      organizations: db.prepare('SELECT id FROM organizations ORDER BY id').all().map(o => ({ id: o.id, ownerAccount: '', currentVersion: null, members: [] })) };
    // Historical owners/roles are intentionally absent from the approval template.
    const target = emptyTarget(destination); writeFileSync(target, JSON.stringify(template, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); sync(target); sync(dirname(target));
    return { file: target, requiresIndependentAccessReview: true, organizations: status.organizations };
  } finally { db.close(); }
}
export async function activateOrganizations(source: string, reviewFile: string, expectedReviewSha256: string, destination: string, audience: string) {
  Hash.parse(expectedReviewSha256); regular(reviewFile); portable(source);
  if (lstatSync(reviewFile).size > 8 * 1024 * 1024) throw new Error('Organization access review exceeds 8 MiB');
  const bytes = readFileSync(reviewFile);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedReviewSha256) throw new Error('Access review differs from the independently approved digest');
  const review = Review.parse(JSON.parse(bytes.toString('utf8'))), now = Date.now(), reviewedAt = Date.parse(review.reviewedAt);
  if (review.audience !== audience || reviewedAt > now + 60_000 || now - reviewedAt > 86400_000) throw new Error('Access review audience or review time is invalid');
  const target = emptyTarget(destination), temp = target + '.' + randomUUID() + '.activate';
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL); chmodSync(temp, 0o600);
    if (await fileDigest(temp) !== review.databaseSha256) throw new Error('Access review is for a different database');
    const before = inspect(temp, audience);
    if (before.journalMode !== 'delete' || before.recovery.state !== 'quarantined' || before.recovery.recovery_id !== review.recoveryId || before.sessions || before.challenges) throw new Error('Access review is for a different recovery or an active database');
    const db = new DatabaseSync(temp);
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
      const orgs = db.prepare('SELECT id,version FROM organizations').all(), ids = new Set(review.organizations.map(o => o.id));
      if (ids.size !== review.organizations.length || ids.size !== orgs.length || orgs.some(o => !ids.has(String(o.id)))) throw new Error('Review must explicitly cover every restored organization exactly once');
      // Erase all active grants and pending invitation authority. None is inherited.
      db.exec("UPDATE organization_members SET status='revoked',version=version+1; UPDATE organization_invitations SET status='revoked',version=version+1 WHERE status='pending'; DELETE FROM organization_sessions; DELETE FROM organization_challenges");
      const memberships = new Map<string, number>(), owners = new Map<string, number>();
      for (const org of review.organizations) {
        const accounts = new Set(org.members.map(m => m.accountId)), owner = org.members.filter(m => m.role === 'owner');
        if (accounts.size !== org.members.length || owner.length !== 1 || owner[0].accountId !== org.ownerAccount) throw new Error('Review requires unique members and exactly the explicitly approved owner');
        owners.set(org.ownerAccount, (owners.get(org.ownerAccount) ?? 0) + 1);
        const old = orgs.find(o => o.id === org.id)!;
        if (org.currentVersion < Number(old.version)) throw new Error('Review organization version predates the backup');
        db.prepare('UPDATE organizations SET owner=?,version=? WHERE id=?').run(org.ownerAccount, org.currentVersion + 1, org.id);
        for (const member of org.members) {
          memberships.set(member.accountId, (memberships.get(member.accountId) ?? 0) + 1);
          const previous = db.prepare('SELECT version FROM organization_members WHERE org=? AND account=?').get(org.id, member.accountId);
          if (previous && member.currentVersion < Number(previous.version) - 1) throw new Error('Review membership version predates the backup');
          db.prepare("INSERT INTO organization_members VALUES(?,?,?,'active',?,?) ON CONFLICT(org,account) DO UPDATE SET role=excluded.role,status='active',version=excluded.version,joined=excluded.joined").run(org.id, member.accountId, member.role, member.currentVersion + 1, now);
        }
        db.prepare("INSERT INTO organization_audit SELECT COALESCE(MAX(sequence),0)+1,?,'system:recovery','organization.recovered',?,?,? FROM organization_audit WHERE org=?").run(org.id, org.id, JSON.stringify({ recoveryId: review.recoveryId, reviewSha256: expectedReviewSha256, accessReapproved: true }), now, org.id);
      }
      if ([...owners.values()].some(n => n > 10) || [...memberships.values()].some(n => n > 100)) throw new Error('Reviewed access exceeds organization account limits');
      db.prepare("UPDATE organization_recovery SET state='ready',review_sha256=? WHERE id=1").run(expectedReviewSha256);
      db.exec('UPDATE organization_meta SET version=1 WHERE id=1');
      db.exec('COMMIT');
    } finally { db.close(); }
    inspect(temp, audience);
    // A durable, exclusive activation intent prevents accidental reuse/racing
    // activations of this recovery. A crash leaves it consumed: restore anew.
    const intent = resolve(source) + '.activation.json';
    writeFileSync(intent, JSON.stringify({ format: 'core-organization-activation-intent-v1', recoveryId: review.recoveryId, reviewSha256: expectedReviewSha256, destination: target }) + '\n', { mode: 0o600, flag: 'wx' });
    sync(intent); sync(dirname(intent));
    return { activated: true, reviewSha256: expectedReviewSha256, ...await publish(temp, target, audience) };
  } finally { clean(temp); }
}
