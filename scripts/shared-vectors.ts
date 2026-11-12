import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNote, domain, encodeVerificationKey, NoteTree, proveSpend, shutdownProver, type Pool } from '../sdk/core.js';
const pool: Pool = { version: 2, network: 'sandbox', contract: 'forest.test.near', denomination: '1000000000000000000000000' };
try {
  const a = await createNote(pool), b = await createNote(pool), output = await createNote(pool);
  const initialTree = await NoteTree.from([a.commitment, b.commitment]);
  const nextTree = await NoteTree.from([a.commitment, b.commitment, output.commitment]);
  const vaultA = 'a.forest.test.near', vaultB = 'b.forest.test.near', recipient = 'receiver.test.near';
  const root = 'd4'.repeat(32), transferRoot = 'c3'.repeat(32);
  const proofs: Record<string, unknown> = {};
  for (const [name, note, tree, action] of [
    ['aFromA', a, initialTree, { kind: 'withdraw', vault: vaultA, target: recipient, disclosureRoot: root }],
    ['aFromB', a, initialTree, { kind: 'withdraw', vault: vaultB, target: recipient, disclosureRoot: root }],
    ['transferA', a, initialTree, { kind: 'transfer', target: output.commitment, disclosureRoot: transferRoot }],
    ['outputFromB', output, nextTree, { kind: 'withdraw', vault: vaultB, target: recipient, disclosureRoot: root }],
  ] as const) {
    const result = await proveSpend(pool, note, tree, action); proofs[name] = result.args;
  }
  const vkey = JSON.parse(await readFile('artifacts/verification_key.json', 'utf8'));
  const value = JSON.stringify({ warning: 'Public test vectors. Private note secrets discarded.', pool, domain: domain(pool),
    vaultA, vaultB, recipient, a: a.commitment, b: b.commitment, output: output.commitment,
    root: initialTree.root, nextRoot: nextTree.root, disclosureRoot: root, transferRoot, verificationKey: encodeVerificationKey(vkey), proofs }, null, 2);
  await mkdir('test-vectors', { recursive: true });
  await writeFile('test-vectors/shared.json', value);
  const contract = resolve(process.env.CORE_CONTRACT_REPO || '../Contract');
  await writeFile(resolve(contract, 'test-vectors/shared.json'), value);
  console.log('Shared-domain real Groth16 vectors written to both repositories.');
} finally { await shutdownProver(); }
