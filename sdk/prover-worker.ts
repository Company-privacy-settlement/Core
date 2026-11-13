/** Isolated browser entrypoint. Dependencies are bundled locally; no URL reaches snarkjs. */
import { curves, groth16, wtns } from 'snarkjs';
import { canonical } from './client/crypto.js';
import { createProofBundle, decodeBrowserProof, encodeBrowserProof, parseProofBundle, spendWitness, verifyProvingAssets,
  type ProvingAssets, type ProvingRequest, type ProofBundle, type ProverStage } from './client/prover.js';
import type { Policy } from './client/types.js';

type Request = { id: string; operation: 'prove' | 'verify'; policy: Policy; request?: ProvingRequest; bundle?: ProofBundle; assets: ProvingAssets };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(value: unknown): void; curve_bn128?: unknown };
let started = false;
scope.onmessage = event => {
  if (started) return;
  started = true;
  void execute(event.data);
};
async function execute(message: Request) {
  let code = 'ASSET_INVALID';
  const progress = (stage: ProverStage) => scope.postMessage({ type: 'progress', id: message.id, stage });
  const start = performance.now();
  try {
    progress('assets');
    const assets = await verifyProvingAssets(message.assets, message.policy);
    let witnessMs = 0, provingMs = 0;
    let bundle: ProofBundle;
    // snarkjs' exported curve builder uses this cache. Prewarm it with one thread
    // so both proving and verification reuse the same engine without subworkers.
    scope.curve_bn128 = await curves.getCurveFromName('bn128', { singleThread: true });
    if (message.operation === 'prove' && message.request) {
      code = 'INPUT_INVALID'; progress('tree');
      const witness = await spendWitness(message.request);
      code = 'PROVING_FAILED'; progress('witness');
      const wtnsFile = { type: 'mem' };
      let clock = performance.now();
      await wtns.calculate(witness.input, assets.wasm, wtnsFile, { memorySize: 256 });
      witnessMs = performance.now() - clock;
      progress('proving'); clock = performance.now();
      const result = await groth16.prove(assets.zkey, wtnsFile);
      provingMs = performance.now() - clock;
      code = 'PROOF_INVALID';
      if (canonical(result.publicSignals) !== canonical(witness.publicInputs)) throw new Error('Input mismatch');
      bundle = await createProofBundle(message.request, { manifestSha256: message.assets.manifestSha256, setup: assets.setup }, { proof: encodeBrowserProof(result.proof), public_inputs: result.publicSignals });
    } else if (message.operation === 'verify' && message.bundle) {
      code = 'PROOF_INVALID';
      bundle = await parseProofBundle(message.bundle, message.policy);
      if (bundle.artifactManifestSha256 !== message.assets.manifestSha256 || bundle.setup !== assets.setup) throw new Error('Artifact mismatch');
    } else throw new Error('Unsupported operation');
    code = 'PROOF_INVALID'; progress('verifying');
    const clock = performance.now();
    if (!await groth16.verify(assets.verificationKey, bundle.spend.public_inputs, decodeBrowserProof(bundle.spend))) throw new Error('Verification failed');
    const verificationMs = performance.now() - clock;
    scope.postMessage({ type: 'result', id: message.id, bundle, metrics: { elapsedMs: performance.now() - start, witnessMs, provingMs, verificationMs } });
  } catch {
    // Never forward third-party errors, witness strings, stack traces or logger output.
    scope.postMessage({ type: 'error', id: message.id, code });
  }
}
