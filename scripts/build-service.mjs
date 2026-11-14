import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
rmSync('dist/service', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.service.json'], { stdio: 'inherit' });
console.log('API, indexer, supervisor and optional proof relay compiled; relay runtime needs its pinned verification key, not proving WASM/zkey');
