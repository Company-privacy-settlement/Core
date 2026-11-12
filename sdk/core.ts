import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildPoseidon } from 'circomlibjs';
import { groth16 } from 'snarkjs';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DEPTH = 8;
export const CAPACITY = 1 << DEPTH;
export const STORAGE_FEE = 2n * 10n ** 22n; // 0.02 NEAR, including payout callback storage.
export const DEPOSIT_FEE_BPS = 15;
export const WITHDRAWAL_FEE_BPS = 15;
export function quoteFees(amount: string | bigint) {
  if (typeof amount === 'string' && !/^[1-9][0-9]*$/.test(amount)) throw new Error('Invalid amount');
  const n = BigInt(amount);
  if (n <= 0n || n > ((1n << 128n) - 1n) / 256n) throw new Error('Amount outside pool denomination range');
  const deposit = n * BigInt(DEPOSIT_FEE_BPS) / 10_000n;
  const withdrawal = n * BigInt(WITHDRAWAL_FEE_BPS) / 10_000n;
  return { amount: n.toString(), depositFeeBps: DEPOSIT_FEE_BPS, withdrawalFeeBps: WITHDRAWAL_FEE_BPS,
    depositProtocolFee: deposit.toString(), withdrawalProtocolFee: withdrawal.toString(), storageFee: STORAGE_FEE.toString(),
    depositAttached: (n + deposit + STORAGE_FEE).toString(), withdrawalAttached: (withdrawal + STORAGE_FEE).toString(), withdrawalReceived: n.toString() };
}
export type Pool = { network: 'testnet' | 'sandbox'; contract: string; denomination: string; version?: 1 | 2 };
export type Note = { version: 1; domain: string; secret: string; nullifier: string; commitment: string };
export type Action = { kind: 'transfer' | 'withdraw'; target: string; disclosureRoot: string; vault?: string };
export type Spend = { proof: string; public_inputs: string[] };

let poseidonPromise: Promise<any> | undefined;
// snarkjs verification keeps a worker pool alive; CLI/test hosts close it on exit.
export async function shutdownProver(): Promise<void> {
  await (globalThis as unknown as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
}
export function field(value: string | bigint): bigint {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Non-canonical field');
  const n = BigInt(value);
  if (n < 0n || n >= FIELD) throw new Error('Field out of range');
  return n;
}
export async function hash(inputs: (string | bigint)[]): Promise<string> {
  const poseidon = await (poseidonPromise ??= buildPoseidon());
  return poseidon.F.toObject(poseidon(inputs.map(field))).toString();
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function shaField(value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  bytes[0] &= 0x1f; // 253 bits, strictly below BN254 Fr modulus.
  return BigInt(`0x${bytes.toString('hex')}`).toString();
}
export function domain(pool: Pool): string {
  if (pool.version !== undefined && pool.version !== 1 && pool.version !== 2) throw new Error('Unknown pool version');
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(pool.contract) || pool.contract.length < 2 || pool.contract.length > 64) throw new Error('Invalid NEAR account');
  if (!/^[1-9][0-9]*$/.test(pool.denomination) || BigInt(pool.denomination) > (1n << 128n) - 1n) throw new Error('Invalid denomination');
  return shaField(`core:v${pool.version ?? 1}|${pool.network}|${pool.contract}|${pool.denomination}`);
}
export function contextHash(pool: Pool, action: Action): string {
  if (action.kind !== 'transfer' && action.kind !== 'withdraw') throw new Error('Invalid action');
  if (!/^[0-9a-f]{64}$/.test(action.disclosureRoot)) throw new Error('Invalid disclosure root');
  if (action.kind === 'transfer') {
    if (field(action.target) === 0n) throw new Error('Empty commitment');
  } else if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(action.target) || action.target.length < 2 || action.target.length > 64) throw new Error('Invalid recipient');
  if (pool.version === 2) {
    if (action.kind === 'withdraw') {
      if (!action.vault) throw new Error('Choose a verified destination vault for a shared withdrawal');
      domain({ ...pool, contract: action.vault });
    } else if (action.vault !== undefined) throw new Error('Shared note transfers have no destination vault');
    return shaField(`core:action:v2|${domain(pool)}|${action.kind}|${action.vault ?? ''}|${action.target}|${action.disclosureRoot}`);
  }
  if (action.vault !== undefined) throw new Error('Destination vault is only valid for a shared pool');
  return shaField(`core:action:v1|${domain(pool)}|${action.kind}|${action.target}|${action.disclosureRoot}`);
}
function randomField(): string {
  const b = randomBytes(32); b[0] &= 0x1f;
  return BigInt(`0x${b.toString('hex')}`).toString();
}
export async function createNote(pool: Pool): Promise<Note> {
  const d = domain(pool), secret = randomField(), nullifier = randomField();
  return { version: 1, domain: d, secret, nullifier, commitment: await hash([secret, nullifier, d]) };
}
export async function validateNote(pool: Pool, note: Note): Promise<void> {
  if (note.version !== 1 || note.domain !== domain(pool) || note.commitment !== await hash([note.secret, note.nullifier, note.domain])) throw new Error('Invalid note or wrong pool');
}

// Reconstruct from the contract's ordered commitment list. Never trust an indexer root alone.
export class NoteTree {
  private constructor(readonly leaves: string[], readonly levels: string[][]) {}
  static async from(leaves: string[]): Promise<NoteTree> {
    if (leaves.length > CAPACITY || new Set(leaves).size !== leaves.length) throw new Error('Tree full or duplicate commitment');
    leaves.forEach(x => { if (field(x) === 0n) throw new Error('Empty leaf'); });
    const levels = [[...leaves, ...Array<string>(CAPACITY - leaves.length).fill('0')]];
    for (let level = 0; level < DEPTH; level++) {
      const next: string[] = [];
      for (let i = 0; i < levels[level].length; i += 2) next.push(await hash([levels[level][i], levels[level][i + 1]]));
      levels.push(next);
    }
    return new NoteTree([...leaves], levels);
  }
  get root(): string { return this.levels[DEPTH][0]; }
  path(commitment: string): { siblings: string[]; pathIndices: number[] } {
    let index = this.leaves.indexOf(commitment);
    if (index < 0) throw new Error('Note not found');
    const siblings: string[] = [], pathIndices: number[] = [];
    for (let i = 0; i < DEPTH; i++) { siblings.push(this.levels[i][index ^ 1]); pathIndices.push(index & 1); index >>= 1; }
    return { siblings, pathIndices };
  }
}

// NEAR alt_bn128 uses raw LE Fq limbs; G2 is c0,c1 (snarkjs order).
function le32(value: string): Buffer {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error('Invalid limb');
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
}
function g1(p: string[]): Buffer { return Buffer.concat([le32(p[0]), le32(p[1])]); }
function g2(p: string[][]): Buffer { return Buffer.concat([le32(p[0][0]), le32(p[0][1]), le32(p[1][0]), le32(p[1][1])]); }
export function encodeProof(proof: any): string { return Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]).toString('base64'); }
export function encodeVerificationKey(vk: any): string {
  if (vk.protocol !== 'groth16' || vk.curve !== 'bn128' || vk.nPublic !== 5 || vk.IC.length !== 6) throw new Error('Wrong circuit key');
  return Buffer.concat([g1(vk.vk_alpha_1), g2(vk.vk_beta_2), g2(vk.vk_gamma_2), g2(vk.vk_delta_2), ...vk.IC.map(g1)]).toString('base64');
}
export async function proveSpend(pool: Pool, note: Note, tree: NoteTree, action: Action, artifacts = 'artifacts') {
  await validateNote(pool, note);
  const manifest = JSON.parse(await readFile(`${artifacts}/manifest.json`, 'utf8'));
  if (manifest.protocol !== 'core-v1' || manifest.depth !== DEPTH) throw new Error('Wrong artifact manifest');
  for (const file of ['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json']) {
    if (sha256(await readFile(`${artifacts}/${file}`)) !== manifest.hashes?.[file]) throw new Error(`Artifact hash mismatch: ${file}`);
  }
  const input = { root: tree.root, contextHash: contextHash(pool, action), domain: note.domain, secret: note.secret, nullifier: note.nullifier, ...tree.path(note.commitment) };
  const { proof, publicSignals } = await groth16.fullProve(input, `${artifacts}/spend_js/spend.wasm`, `${artifacts}/spend.zkey`, undefined, undefined, { singleThread: true });
  const vk = JSON.parse(await readFile(`${artifacts}/verification_key.json`, 'utf8'));
  if (!await groth16.verify(vk, publicSignals, proof)) throw new Error('Generated proof failed verification');
  return { proof, publicSignals, args: { proof: encodeProof(proof), public_inputs: publicSignals } satisfies Spend };
}
