import { generateKeyPairSync, randomInt } from 'node:crypto';
import bs58 from 'bs58';
import { encryptPrivate } from './disclosure.js';
import { domain, type Pool } from './core.js';

// Run on the recipient's device. Never generate or custody this secret in a contract.
export function createFreshRecipient(password: string): { accountId: string; publicKey: string; encryptedBackup: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const accountId = pub.toString('hex');
  const nearPublicKey = `ed25519:${bs58.encode(pub)}`;
  const nearSecretKey = `ed25519:${bs58.encode(Buffer.concat([seed, pub]))}`;
  return { accountId, publicKey: nearPublicKey, encryptedBackup: encryptPrivate({ version: 1, accountId, publicKey: nearPublicKey, secretKey: nearSecretKey }, password) };
}

// Distribute deposits among separately deployed, caller-approved pools.
// No shared vault, custody router, cross-pool note spend or global anonymity set.
export function chooseIndependentVault(pools: readonly Pool[]): Pool {
  if (pools.length === 0) throw new Error('No approved vaults');
  const first = pools[0];
  const domains = pools.map(p => {
    if (p.network !== first.network || p.denomination !== first.denomination) throw new Error('Incompatible vault denominations or networks');
    return domain(p);
  });
  if (new Set(domains).size !== pools.length) throw new Error('Duplicate vault');
  return { ...pools[randomInt(pools.length)] };
}
