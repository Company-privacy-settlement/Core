import { mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
run('cargo', ['build', '--locked', '--manifest-path', 'contracts/pool/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release']);
mkdirSync('artifacts', { recursive: true });
run('node_modules/.bin/wasm-opt', [
  'contracts/pool/target/wasm32-unknown-unknown/release/core_pool.wasm',
  '-o', 'artifacts/core_pool.wasm', '-Oz', '--enable-bulk-memory', '--enable-reference-types',
  '--enable-multivalue', '--enable-nontrapping-float-to-int',
  '--llvm-memory-copy-fill-lowering', '--llvm-nontrapping-fptoint-lowering', '--signext-lowering', '--strip-debug', '--strip-producers',
]);
const size = statSync('artifacts/core_pool.wasm').size;
if (size > 1_400_000) throw new Error(`Contract too large for normal deploy transaction: ${size}`);
console.log(`NEAR-compatible optimized contract: artifacts/core_pool.wasm (${size} bytes)`);
