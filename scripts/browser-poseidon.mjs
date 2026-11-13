import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = readFileSync('node_modules/circomlibjs/src/poseidon_constants.json');
if (createHash('sha256').update(bytes).digest('hex') !== '354f31bbed9d9a8b884d8f2181e339cb425b6e3e4cc7240bd3dd22f0070f3f2c') throw new Error('Unexpected circomlibjs 0.1.7 Poseidon constants');
const { C, M } = JSON.parse(bytes), parameters = { 2: { C: C[1], M: M[1] }, 3: { C: C[2], M: M[2] } };
const text = '// SPDX-License-Identifier: GPL-3.0-only\n// Generated from circomlibjs 0.1.7 (iden3), src/poseidon_constants.json.\n// Source SHA-256: 354f31bbed9d9a8b884d8f2181e339cb425b6e3e4cc7240bd3dd22f0070f3f2c\n// See docs/licenses/circomlibjs-GPL-3.0.txt. Regenerate: node scripts/browser-poseidon.mjs\nexport const parameters: Record<2 | 3, { C: string[]; M: string[][] }> = ' + JSON.stringify(parameters, null, 2) + ';\n';
const target = 'sdk/client/poseidon-constants.ts';
if (process.argv.includes('--check')) { if (readFileSync(target, 'utf8') !== text) throw new Error('Browser Poseidon constants differ from pinned upstream'); }
else writeFileSync(target, text);
