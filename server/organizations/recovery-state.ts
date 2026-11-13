import type { DatabaseSync } from 'node:sqlite';

export const recoverySchema = `CREATE TABLE IF NOT EXISTS organization_recovery(
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','quarantined')),
  recovery_id TEXT, created INTEGER NOT NULL, review_sha256 TEXT)`;

/** Legacy live databases remain readable. Maintenance snapshots always have this gate. */
export function assertOrganizationReady(db: DatabaseSync) {
  if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='organization_recovery'").get()) return;
  const row = db.prepare('SELECT * FROM organization_recovery WHERE id=1').get();
  if (!row || row.version !== 1 || row.state !== 'ready') throw new Error('Organization recovery requires an independently approved access review before service startup');
}
