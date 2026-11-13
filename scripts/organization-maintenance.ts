import { resolve } from 'node:path';
import { organizationOrigin } from '../sdk/client/organizations.js';
import { activateOrganizations, backupOrganizations, organizationReviewTemplate, restoreOrganizations } from './lib/organization-backup.js';

const [mode, ...args] = process.argv.slice(2);
try {
  const audience = organizationOrigin(process.env.CORE_ORGANIZATION_ORIGIN ?? '');
  if (!process.env.CORE_ORGANIZATION_DB) throw new Error('Set CORE_ORGANIZATION_DB');
  const db = resolve(process.env.CORE_ORGANIZATION_DB);
  let result;
  if (mode === 'backup' && args.length === 1) result = await backupOrganizations(db, resolve(args[0]), audience);
  else if (mode === 'restore' && args.length === 2) result = await restoreOrganizations(resolve(args[0]), args[1], db, audience);
  else if (mode === 'review-template' && args.length === 1) result = await organizationReviewTemplate(db, resolve(args[0]), audience);
  else if (mode === 'activate' && args.length === 3) result = await activateOrganizations(resolve(args[0]), resolve(args[1]), args[2], db, audience);
  else throw new Error('Invalid arguments');
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error('Organization maintenance failed. Check audience, owner-only files, independent digests, current access review and unused destinations.');
  console.error('Usage: organizations:backup -- <new.sqlite> | organizations:restore -- <backup.sqlite> <sha256> | organizations:review-template -- <new-review.json> | organizations:activate -- <quarantined.sqlite> <review.json> <review-sha256>');
  process.exitCode = 1;
}
