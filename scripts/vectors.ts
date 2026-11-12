import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createNote, domain, encodeVerificationKey, NoteTree, proveSpend, shutdownProver, type Pool } from '../sdk/core.js';
const pool: Pool = { network: 'sandbox', contract: 'pool.test.near', denomination: '1000000000000000000000000' };
const input = await createNote(pool), output = await createNote(pool);
const disclosureRoot = 'ab'.repeat(32);
const tree = await NoteTree.from([input.commitment]);
const transfer = await proveSpend(pool, input, tree, { kind: 'transfer', target: output.commitment, disclosureRoot });
const nextTree = await NoteTree.from([input.commitment, output.commitment]);
const withdrawal = await proveSpend(pool, output, nextTree, { kind: 'withdraw', target: 'receiver.test.near', disclosureRoot });
const vkey = JSON.parse(await readFile('artifacts/verification_key.json', 'utf8'));
await mkdir('test-vectors', { recursive: true });
await writeFile('test-vectors/spend.json', JSON.stringify({
  warning: 'Public test vectors only; no note secrets or proving key included.',
  pool, domain: domain(pool), disclosureRoot, inputCommitment: input.commitment, outputCommitment: output.commitment,
  root: tree.root, nextRoot: nextTree.root, verificationKey: encodeVerificationKey(vkey), vkey,
  transfer: { ...transfer.args, snarkjsProof: transfer.proof },
  withdrawal: { ...withdrawal.args, snarkjsProof: withdrawal.proof },
}, null, 2));
console.log('Public test vectors generated; private note secrets discarded.');
await shutdownProver();
