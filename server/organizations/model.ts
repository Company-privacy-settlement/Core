import { z } from 'zod';
import { AccountId } from '../../sdk/validation.js';
import { ORGANIZATION_ROLES, ORGANIZATION_ROLE_PERMISSIONS, type OrganizationRole, type OrganizationPermission } from '../../sdk/client/organizations.js';

export class OrganizationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const Id = z.string().uuid();
export const OrganizationAccount = AccountId.refine(v => !/\s/.test(v));
export const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const Role = z.enum(ORGANIZATION_ROLES);
export const GrantRole = z.enum(['admin', 'operator', 'viewer', 'auditor']);
export const Name = z.string().trim().min(2).max(120).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
export const OrganizationInputs = {
  create: z.object({ name: Name }).strict(),
  rename: z.object({ name: Name, version: Version }).strict(),
  invite: z.object({ accountId: OrganizationAccount, role: GrantRole }).strict(),
  changeRole: z.object({ role: GrantRole, version: Version }).strict(),
  version: z.object({ version: Version }).strict(),
  transfer: z.object({ accountId: OrganizationAccount, version: Version }).strict(),
};
export function requirePermission(role: OrganizationRole, permission: OrganizationPermission) {
  if (!Object.hasOwn(ORGANIZATION_ROLE_PERMISSIONS, role) || !ORGANIZATION_ROLE_PERMISSIONS[role].includes(permission)) throw new OrganizationError(403, 'PERMISSION_DENIED');
}
export function canGrant(actor: OrganizationRole, role: OrganizationRole): boolean {
  return actor === 'owner' ? role !== 'owner' : actor === 'admin' && ['operator', 'viewer', 'auditor'].includes(role);
}
export function versionMatches(actual: number, expected: number) { if (actual !== expected) throw new OrganizationError(409, 'VERSION_CONFLICT'); }
