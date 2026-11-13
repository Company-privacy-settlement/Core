import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
rmSync('dist/service', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.service.json'], { stdio: 'inherit' });
console.log('API, indexer and supervised service compiled; runtime needs no tsx, Rust or proving artifacts');
