import { canonical, sha256, shaField } from './crypto.js';
import { account, feeQuote, object, parsePolicy, preparedPayment, scalar } from './payment.js';
import { noteDomain, noteHash, validatePrivateNote, type PrivateNote } from './notes.js';
import type { Call, Policy } from './types.js';

export type ProvingContext = { version: 1; policy: Policy; checkedAtBlock: { hash: string; height: number }; root: string; commitments: string[]; vault: string };
export type ProvingAction = { recipient: string; disclosureRoot: string };
export type ProvingAssets = { manifest: Blob; wasm: Blob; zkey: Blob; verificationKey: Blob; manifestSha256: string };
export type ProvingRequest = { policy: Policy; note: PrivateNote; context: ProvingContext; action: ProvingAction };
export type SpendProof = { proof: string; public_inputs: string[] };
export type ProofBundle = { format: 'core-browser-proof'; version: 1; policy: Policy; action: ProvingAction & { vault: string }; checkedAtBlock: ProvingContext['checkedAtBlock']; artifactManifestSha256: string; setup: string; spend: SpendProof; plan: { tokenCall: Call; checkedAtBlock: string }; digest: string };
export type ProverStage = 'assets' | 'tree' | 'witness' | 'proving' | 'verifying';
export type ProverResult = { bundle: ProofBundle; metrics: { elapsedMs: number; witnessMs: number; provingMs: number; verificationMs: number } };
const HASH = /^[a-f0-9]{64}$/;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
function exact(o: Record<string, unknown>, keys: string[]) {
  if (Object.keys(o).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Unexpected proving fields');
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid proving digest');
  return value;
}
function block(input: unknown): ProvingContext['checkedAtBlock'] {
  const b = object(input); exact(b, ['hash', 'height']);
  if (typeof b.hash !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(b.hash) || !Number.isSafeInteger(b.height) || Number(b.height) < 0) throw new Error('Invalid finalized snapshot');
  return { hash: b.hash, height: b.height as number };
}
function ft(input: Policy): Policy {
  const policy = parsePolicy(input); feeQuote(policy);
  if (!policy.tokenId) throw new Error('Browser proving requires a trusted FT group');
  return policy;
}
function vaultFor(policy: Policy, value: unknown) {
  const vault = account(value);
  if (!new RegExp(`^v[a-f0-9]{32}\\.${policy.registry.replaceAll('.', '\\.')}$`).test(vault)) throw new Error('Vault must be a direct protocol child in the original group');
  return vault;
}
export function parseProvingAction(input: unknown, policy: Policy): ProvingAction {
  const a = object(input); exact(a, ['recipient', 'disclosureRoot']);
  const recipient = account(a.recipient);
  if (recipient === policy.registry || recipient.endsWith('.' + policy.registry)) throw new Error('Choose an external recipient');
  return { recipient, disclosureRoot: hash(a.disclosureRoot) };
}
export function parseProvingContext(input: unknown, expected: Policy): ProvingContext {
  const c = object(input); exact(c, ['version', 'policy', 'checkedAtBlock', 'root', 'commitments', 'vault']);
  const policy = ft(c.policy as Policy);
  if (c.version !== 1 || canonical(policy) !== canonical(ft(expected))) throw new Error('Proving context differs from the trusted policy');
  if (!Array.isArray(c.commitments) || c.commitments.length < 1 || c.commitments.length > 256) throw new Error('Expected 1–256 ordered commitments');
  const commitments = c.commitments.map(scalar);
  if (commitments.includes('0') || new Set(commitments).size !== commitments.length) throw new Error('Empty or duplicate commitment');
  return { version: 1, policy, root: scalar(c.root), commitments, vault: vaultFor(policy, c.vault), checkedAtBlock: block(c.checkedAtBlock) };
}
/** Rebuild all eight levels locally; neither the API nor an imported path supplies a witness. */
export async function spendWitness(request: ProvingRequest) {
  const policy = ft(request.policy), note = await validatePrivateNote(policy, request.note);
  const context = parseProvingContext(request.context, policy), action = parseProvingAction(request.action, policy);
  let index = context.commitments.indexOf(note.commitment);
  if (index < 0) throw new Error('Note is absent from the original group snapshot');
  let level = [...context.commitments, ...Array<string>(256 - context.commitments.length).fill('0')];
  const siblings: string[] = [], pathIndices: number[] = [];
  for (let depth = 0; depth < 8; depth++) {
    siblings.push(level[index ^ 1]); pathIndices.push(index & 1); index >>= 1;
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(noteHash([level[i], level[i + 1]]));
    level = next;
  }
  if (level[0] !== context.root) throw new Error('Ordered commitments do not match the group root');
  const contextHash = await withdrawalContext(policy, context.vault, action), domain = note.domain;
  return { input: { root: context.root, contextHash, domain, secret: note.secret, nullifier: note.nullifier, siblings, pathIndices },
    publicInputs: [noteHash([note.nullifier, domain]), noteHash([note.nullifier, contextHash]), context.root, contextHash, domain] };
}
async function withdrawalContext(policy: Policy, vault: string, action: ProvingAction) {
  return shaField(`core:action:ft:v3|${await noteDomain(policy)}|withdraw|${vault}|${action.recipient}|${action.disclosureRoot}`);
}
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function read(blob: Blob, max: number) {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > max) throw new Error('Proving asset size is outside the supported limit');
  return new Uint8Array(await blob.arrayBuffer());
}
export async function verifyProvingAssets(assets: ProvingAssets, expected: Policy) {
  const manifestBytes = await read(assets.manifest, 8192);
  if (await digest(manifestBytes) !== hash(assets.manifestSha256)) throw new Error('Artifact manifest hash mismatch');
  const manifest = object(JSON.parse(new TextDecoder().decode(manifestBytes)));
  exact(manifest, ['protocol', 'depth', 'setup', 'hashes']);
  if (manifest.protocol !== 'core-v1' || manifest.depth !== 8 || typeof manifest.setup !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(manifest.setup)) throw new Error('Unsupported proving manifest');
  const hashes = object(manifest.hashes); exact(hashes, ['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json']);
  Object.values(hashes).forEach(hash);
  const wasm = await read(assets.wasm, 8 * 1024 * 1024), zkey = await read(assets.zkey, 16 * 1024 * 1024), key = await read(assets.verificationKey, 16384);
  if (await digest(wasm) !== hashes['spend_js/spend.wasm'] || await digest(zkey) !== hashes['spend.zkey'] || await digest(key) !== hashes['verification_key.json']) throw new Error('Proving asset hash mismatch');
  const verificationKey = object(JSON.parse(new TextDecoder().decode(key)));
  if (await digest(encodeVerificationKeyBytes(verificationKey)) !== ft(expected).verifierSha256) throw new Error('Verification key differs from the trusted policy');
  return { wasm, zkey, verificationKey, setup: manifest.setup };
}
function limb(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 77 || BigInt(value) >= Q) throw new Error('Invalid BN254 coordinate');
  let n = BigInt(value); return Uint8Array.from({ length: 32 }, () => { const byte = Number(n & 255n); n >>= 8n; return byte; });
}
function g1(p: unknown): Uint8Array[] {
  if (!Array.isArray(p) || p.length !== 3 || p[2] !== '1') throw new Error('Invalid affine G1 point');
  return [limb(p[0]), limb(p[1])];
}
function g2(p: unknown): Uint8Array[] {
  if (!Array.isArray(p) || p.length !== 3 || !Array.isArray(p[0]) || p[0].length !== 2 || !Array.isArray(p[1]) || p[1].length !== 2 || canonical(p[2]) !== '["1","0"]') throw new Error('Invalid affine G2 point');
  return [limb(p[0][0]), limb(p[0][1]), limb(p[1][0]), limb(p[1][1])];
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; } return out;
}
export function encodeVerificationKeyBytes(key: Record<string, unknown>) {
  if (key.protocol !== 'groth16' || key.curve !== 'bn128' || key.nPublic !== 5 || !Array.isArray(key.IC) || key.IC.length !== 6) throw new Error('Wrong circuit verification key');
  return concat([...g1(key.vk_alpha_1), ...g2(key.vk_beta_2), ...g2(key.vk_gamma_2), ...g2(key.vk_delta_2), ...key.IC.flatMap(g1)]);
}
export function encodeBrowserProof(input: unknown): string {
  const p = object(input);
  if (p.protocol !== 'groth16' || p.curve !== 'bn128') throw new Error('Wrong proof protocol');
  return btoa(String.fromCharCode(...concat([...g1(p.pi_a), ...g2(p.pi_b), ...g1(p.pi_c)])));
}
function parseSpend(input: unknown): SpendProof {
  const p = object(input); exact(p, ['proof', 'public_inputs']);
  if (typeof p.proof !== 'string' || !/^[A-Za-z0-9+/]{342}==$/.test(p.proof) || atob(p.proof).length !== 256 || btoa(atob(p.proof)) !== p.proof || !Array.isArray(p.public_inputs) || p.public_inputs.length !== 5) throw new Error('Invalid spend proof');
  return { proof: p.proof, public_inputs: p.public_inputs.map(scalar) };
}
export function decodeBrowserProof(spend: SpendProof) {
  const bytes = Uint8Array.from(atob(parseSpend(spend).proof), c => c.charCodeAt(0));
  const limbs = Array.from({length: 8}, (_, i) => {
    const value = BigInt('0x' + [...bytes.slice(i * 32, (i + 1) * 32)].reverse().map(b => b.toString(16).padStart(2, '0')).join('')).toString();
    limb(value); return value;
  });
  return { protocol: 'groth16', curve: 'bn128', pi_a: [...limbs.slice(0, 2), '1'], pi_b: [limbs.slice(2, 4), limbs.slice(4, 6), ['1', '0']], pi_c: [...limbs.slice(6), '1'] };
}
async function publicPlan(policy: Policy, action: ProofBundle['action'], spend: SpendProof, checkedAtBlock: string) {
  const q = feeQuote(policy);
  const tokenCall: Call = { contract: policy.tokenId!, method: 'ft_transfer_call', args: { receiver_id: policy.registry, amount: q.feeTokens,
    msg: JSON.stringify({ vault: action.vault, recipient: action.recipient, disclosure_root: action.disclosureRoot, ...spend }) }, attachedYoctoNear: '1', gas: '300000000000000' };
  // Withdrawal call validation is payer-independent; no wallet identity is chosen here.
  await preparedPayment({ tokenCall, checkedAtBlock }, policy, action.recipient);
  return { tokenCall, checkedAtBlock };
}
export async function createProofBundle(request: ProvingRequest, assets: { manifestSha256: string; setup: string }, raw: SpendProof): Promise<ProofBundle> {
  const policy = ft(request.policy), context = parseProvingContext(request.context, policy), action = { ...parseProvingAction(request.action, policy), vault: context.vault }, spend = parseSpend(raw);
  const payload = { format: 'core-browser-proof' as const, version: 1 as const, policy, action, checkedAtBlock: context.checkedAtBlock,
    artifactManifestSha256: hash(assets.manifestSha256), setup: assets.setup, spend, plan: await publicPlan(policy, action, spend, context.checkedAtBlock.hash) };
  return { ...payload, digest: await sha256(canonical(payload)) };
}
/** A checksum detects file edits; Groth16 verification remains mandatory in the worker. */
export async function parseProofBundle(raw: unknown, expected: Policy): Promise<ProofBundle> {
  const b = object(raw); exact(b, ['format', 'version', 'policy', 'action', 'checkedAtBlock', 'artifactManifestSha256', 'setup', 'spend', 'plan', 'digest']);
  const { digest: checksum, ...payload } = b;
  if (b.format !== 'core-browser-proof' || b.version !== 1 || await sha256(canonical(payload)) !== hash(checksum) || canonical(ft(b.policy as Policy)) !== canonical(ft(expected))) throw new Error('Proof file integrity or policy mismatch');
  const policy = ft(expected), a = object(b.action); exact(a, ['vault', 'recipient', 'disclosureRoot']);
  const action = { ...parseProvingAction({ recipient: a.recipient, disclosureRoot: a.disclosureRoot }, policy), vault: vaultFor(policy, a.vault) }, spend = parseSpend(b.spend), checkedAtBlock = block(b.checkedAtBlock);
  if (spend.public_inputs[4] !== await noteDomain(policy) || spend.public_inputs[3] !== await withdrawalContext(policy, action.vault, action)) throw new Error('Proof file does not bind this withdrawal');
  if (canonical(b.plan) !== canonical(await publicPlan(policy, action, spend, checkedAtBlock.hash)) || typeof b.setup !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(b.setup)) throw new Error('Proof plan or setup metadata mismatch');
  hash(b.artifactManifestSha256);
  return b as unknown as ProofBundle;
}

const stages: ProverStage[] = ['assets', 'tree', 'witness', 'proving', 'verifying'];
const errors: Record<string, string> = { ASSET_INVALID: 'Proving files failed integrity or policy verification.', INPUT_INVALID: 'The note, group snapshot or withdrawal details are invalid.', PROOF_INVALID: 'Proof verification failed.', PROVING_FAILED: 'Local proving failed. Check device memory and the proving files.' };
export class BrowserProver {
  constructor(private readonly worker: () => Worker) {}
  prove(request: ProvingRequest, assets: ProvingAssets, options: { signal?: AbortSignal; onProgress?: (stage: ProverStage) => void; timeoutMs?: number } = {}): Promise<ProverResult> {
    return this.run({ operation: 'prove', request, assets }, request.policy, options);
  }
  verify(bundle: ProofBundle, policy: Policy, assets: ProvingAssets, options: { signal?: AbortSignal; onProgress?: (stage: ProverStage) => void; timeoutMs?: number } = {}): Promise<ProverResult> {
    return this.run({ operation: 'verify', bundle, assets }, policy, options);
  }
  private run(message: Record<string, unknown>, policy: Policy, options: { signal?: AbortSignal; onProgress?: (stage: ProverStage) => void; timeoutMs?: number }): Promise<ProverResult> {
    const timeout = options.timeoutMs ?? 180000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) return Promise.reject(new Error('Invalid prover deadline'));
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new DOMException('Proving cancelled', 'AbortError')); return; }
      let worker: Worker;
      try { worker = this.worker(); } catch { reject(new Error('This browser could not start a local prover worker.')); return; }
      const id = crypto.randomUUID(); let settled = false;
      const finish = (error?: unknown, result?: ProverResult) => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        worker.removeEventListener('message', receive); worker.removeEventListener('error', failed); worker.removeEventListener('messageerror', failed); worker.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(new DOMException('Proving cancelled', 'AbortError'));
      const failed = () => finish(new Error('The local prover worker stopped unexpectedly.'));
      const receive = (event: MessageEvent) => {
        const data = event.data;
        if (settled || !data || data.id !== id) return;
        if (data.type === 'progress' && stages.includes(data.stage)) {
          try { options.onProgress?.(data.stage); } catch { finish(new Error('Local proving was interrupted.')); } return;
        }
        if (data.type === 'error') { finish(new Error(errors[data.code] ?? errors.PROVING_FAILED)); return; }
        if (data.type === 'result') void (async () => {
          try {
            const bundle = await parseProofBundle(data.bundle, policy), metrics = object(data.metrics);
            if (Object.keys(metrics).sort().join('|') !== 'elapsedMs|provingMs|verificationMs|witnessMs' || Object.values(metrics).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 300000)) throw new Error('Invalid prover metrics');
            if (message.operation === 'prove') {
              const request = message.request as ProvingRequest, note = await validatePrivateNote(policy, request.note), context = parseProvingContext(request.context, policy);
              const inputs = [noteHash([note.nullifier, note.domain]), noteHash([note.nullifier, bundle.spend.public_inputs[3]]), context.root];
              if (canonical(bundle.action) !== canonical({ ...parseProvingAction(request.action, policy), vault: context.vault }) || canonical(bundle.checkedAtBlock) !== canonical(context.checkedAtBlock) || canonical(inputs) !== canonical(bundle.spend.public_inputs.slice(0, 3))) throw new Error('Prover result differs from the requested note or destination');
            } else if (canonical(bundle) !== canonical(message.bundle)) throw new Error('Verification result differs from the selected proof file');
            if (bundle.artifactManifestSha256 !== (message.assets as ProvingAssets).manifestSha256) throw new Error('Prover result uses different proving files');
            finish(undefined, { bundle, metrics: metrics as ProverResult['metrics'] });
          } catch { finish(new Error('The prover returned an invalid or substituted result.')); }
        })();
      };
      const timer = setTimeout(() => finish(new DOMException('Local proving exceeded its deadline. Try a supported device.', 'TimeoutError')), timeout);
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', receive); worker.addEventListener('error', failed); worker.addEventListener('messageerror', failed);
      if (options.signal?.aborted) { abort(); return; }
      try { worker.postMessage({ id, ...message, policy }); } catch { failed(); }
    });
  }
}
