import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { sha256 } from './core.js';

export const CredentialSchema = z.object({
  version: z.literal(1),
  issuer: z.string().min(1).max(128),
  subjectCommitment: z.string().regex(/^[1-9][0-9]*$/),
  businessIdHash: z.string().regex(/^[0-9a-f]{64}$/),
  jurisdiction: z.enum(['US', 'AE']),
  checks: z.array(z.enum(['registration', 'beneficial_owners', 'sanctions'])).min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type KybClaims = z.infer<typeof CredentialSchema>;
export type KybCredential = { claims: KybClaims; signature: string };
export function credentialMessage(claims: KybClaims): string {
  const c = CredentialSchema.parse(claims);
  return JSON.stringify(['core:kyb:v1', c.version, c.issuer, c.subjectCommitment, c.businessIdHash, c.jurisdiction, [...new Set(c.checks)].sort(), c.issuedAt, c.expiresAt, c.nonce]);
}
export function credentialHash(credential: KybCredential): string {
  return sha256(JSON.stringify([credentialMessage(credential.claims), credential.signature]));
}
// Trust and current revocations are supplied by the relying enterprise.
// This validates an attestation, and does not perform a real-world KYB check.
export function verifyKyb(credential: KybCredential, options: {
  trustedIssuers: Record<string, string>;
  revokedHashes: ReadonlySet<string>;
  expectedSubject: string;
  now: Date;
  requiredChecks?: KybClaims['checks'];
}): boolean {
  try {
    const claims = CredentialSchema.parse(credential.claims);
    const key = options.trustedIssuers[claims.issuer];
    if (!key || claims.subjectCommitment !== options.expectedSubject || options.revokedHashes.has(credentialHash(credential))) return false;
    if (!(options.requiredChecks ?? ['registration', 'beneficial_owners', 'sanctions']).every(check => claims.checks.includes(check))) return false;
    if (Date.parse(claims.issuedAt) > options.now.getTime() || Date.parse(claims.expiresAt) <= options.now.getTime() || Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt)) return false;
    const publicKey = createPublicKey(key);
    return publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(credentialMessage(claims)), publicKey, Buffer.from(credential.signature, 'base64'));
  } catch { return false; }
}
