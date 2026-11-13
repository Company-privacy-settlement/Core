import { canonical, seal, unseal, shaField } from './crypto.js';
import { object, parsePolicy, scalar, feeQuote } from './payment.js';
import { parameters } from './poseidon-constants.js';
import type { Policy } from './types.js';

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FORMAT = 'core-private-note';
export type PrivateNote = { version: 1; domain: string; secret: string; nullifier: string; commitment: string };
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) throw new Error('Unexpected private note fields');
}
const constants = Object.fromEntries(([2, 3] as const).map(n => [n, { C: parameters[n].C.map(BigInt), M: parameters[n].M.map(row => row.map(BigInt)) }])) as Record<2 | 3, { C: bigint[]; M: bigint[][] }>;
/** BN254 Poseidon, zero initial state, matching circomlibjs 0.1.7 / the existing circuits. */
export function noteHash(inputs: string[]): string {
  if (inputs.length !== 2 && inputs.length !== 3) throw new Error('Poseidon supports two or three inputs');
  const n = inputs.length, { C, M } = constants[n], partial = n === 2 ? 57 : 56;
  let state = [0n, ...inputs.map(value => BigInt(scalar(value)))];
  const pow5 = (x: bigint) => { const square = x * x % FIELD; return square * square % FIELD * x % FIELD; };
  for (let round = 0; round < 8 + partial; round++) {
    state = state.map((value, i) => (value + C[round * (n + 1) + i]) % FIELD);
    state = state.map((value, i) => round < 4 || round >= partial + 4 || i === 0 ? pow5(value) : value);
    state = M.map(row => row.reduce((sum, coefficient, i) => (sum + coefficient * state[i]) % FIELD, 0n));
  }
  return state[0].toString();
}
export async function noteDomain(input: Policy): Promise<string> {
  const policy = parsePolicy(input); feeQuote(policy);
  return shaField(`core:ft:v3|${policy.network}|${policy.registry}|${policy.tokenId}|${policy.denomination}`);
}
function randomField(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); bytes[0] &= 0x1f;
  return BigInt('0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')).toString();
}
export async function createPrivateNote(policy: Policy): Promise<PrivateNote> {
  const domain = await noteDomain(policy), secret = randomField(), nullifier = randomField();
  return { version: 1, domain, secret, nullifier, commitment: noteHash([secret, nullifier, domain]) };
}
export async function validatePrivateNote(policy: Policy, raw: unknown): Promise<PrivateNote> {
  const note = object(raw); exact(note, ['version', 'domain', 'secret', 'nullifier', 'commitment']);
  const domain = scalar(note.domain), secret = scalar(note.secret), nullifier = scalar(note.nullifier), commitment = scalar(note.commitment);
  if (note.version !== 1 || commitment === '0' || domain !== await noteDomain(policy) || commitment !== noteHash([secret, nullifier, domain])) throw new Error('Invalid note or different settlement group');
  return { version: 1, domain, secret, nullifier, commitment };
}
export async function encryptNoteBackup(input: Policy, raw: PrivateNote, password: string): Promise<string> {
  const policy = parsePolicy(input), note = await validatePrivateNote(policy, raw);
  return seal({ version: 1, policy, note }, password, FORMAT);
}
export async function openNoteBackup(envelope: string, password: string, expectedPolicy?: Policy): Promise<{ policy: Policy; note: PrivateNote }> {
  if (envelope.length > 16000) throw new Error('Private note backup exceeds 16 KB');
  let decoded: unknown;
  try { decoded = await unseal(envelope, password, FORMAT); }
  catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'OperationError') throw new Error('Could not decrypt private note. Check the passphrase and backup integrity.');
    throw error;
  }
  const payload = object(decoded); exact(payload, ['version', 'policy', 'note']);
  const policy = parsePolicy(payload.policy);
  if (payload.version !== 1 || (expectedPolicy && canonical(policy) !== canonical(parsePolicy(expectedPolicy)))) throw new Error('Backup differs from the trusted policy');
  return { policy, note: await validatePrivateNote(policy, payload.note) };
}
