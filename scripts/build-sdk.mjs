import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

rmSync('dist/node', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.sdk.json'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/build-client.mjs'], { stdio: 'inherit' });
console.log('Node SDK and browser client built');
