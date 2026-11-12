import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
mkdirSync('artifacts', { recursive: true });
rmSync('artifacts/build-manifest.json', { force: true });
const contracts = {};
// Factory embeds the finalized pool bytes, so the order is part of the build.
for (const name of ['pool', 'factory']) {
  run('cargo', ['build', '--locked', '--manifest-path', `contracts/${name}/Cargo.toml`, '--target', 'wasm32-unknown-unknown', '--release', '--target-dir', 'contracts/pool/target']);
  const output = `artifacts/core_${name}.wasm`;
  run('node_modules/.bin/wasm-opt', [
    `contracts/pool/target/wasm32-unknown-unknown/release/core_${name}.wasm`,
    '-o', output, '-Oz', '--enable-bulk-memory', '--enable-reference-types',
    '--enable-multivalue', '--enable-nontrapping-float-to-int',
    '--llvm-memory-copy-fill-lowering', '--llvm-nontrapping-fptoint-lowering', '--signext-lowering', '--strip-debug', '--strip-producers',
  ]);
  const size = statSync(output).size;
  if (size > 1_400_000) throw new Error(`Contract too large for normal deploy transaction: ${size}`);
  contracts[name] = { wasm: `core_${name}.wasm`, bytes: size, sha256: createHash('sha256').update(readFileSync(output)).digest('hex') };
  console.log(`NEAR-compatible optimized contract: ${output} (${size} bytes)`);
}
writeFileSync('artifacts/build-manifest.json', JSON.stringify({ protocol: 'core-build-v1', contracts, factoryEmbeddedVaultSha256: contracts.pool.sha256 }, null, 2));
