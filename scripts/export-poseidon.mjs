import { readFileSync, writeFileSync } from 'node:fs';
// Mathematical BN254 Poseidon t=3 constants, matching circomlib's Poseidon(2).
// Keep only this width; linking every width exceeds NEAR's deployment limit.
const p = JSON.parse(readFileSync('node_modules/circomlibjs/src/poseidon_constants.json', 'utf8'));
const values = [...p.C[1], ...p.M[1].flat()];
if (values.length !== 204) throw new Error('Unexpected t=3 parameter count');
const bytes = Buffer.concat(values.map(x => Buffer.from(BigInt(x).toString(16).padStart(64, '0'), 'hex').reverse()));
writeFileSync('contracts/pool/src/poseidon-t3.bin', bytes);
console.log('Exported 204 canonical Poseidon t=3 constants.');
