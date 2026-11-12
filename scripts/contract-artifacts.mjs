import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const contractRepo = resolve(core, process.env.CORE_CONTRACT_REPO || '../Contract');
export function runContractScript(name, args = []) {
  const pkg = JSON.parse(readFileSync(resolve(contractRepo, 'package.json'), 'utf8'));
  if (pkg.name !== '@company-privacy-settlement/contracts') throw new Error('CORE_CONTRACT_REPO must point to the Contract checkout');
  const result = spawnSync('npm', ['run', name, ...(args.length ? ['--', ...args] : [])], { cwd: contractRepo, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Contract ${name} failed`);
}
function copyChecked(file, expected) {
  const bytes = readFileSync(resolve(contractRepo, 'artifacts', file));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Contract artifact mismatch: ${file}`);
  const target = resolve(core, 'artifacts', file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
export function syncContractArtifacts() {
  const manifest = JSON.parse(readFileSync(resolve(contractRepo, 'artifacts/build-manifest.json'), 'utf8'));
  if (manifest.protocol !== 'core-build-v1') throw new Error('Unknown build manifest');
  for (const entry of Object.values(manifest.contracts)) {
    if (!/^[a-z_]+\.wasm$/.test(entry.wasm)) throw new Error('Invalid artifact filename');
    copyChecked(entry.wasm, entry.sha256);
  }
  mkdirSync(resolve(core, 'artifacts'), { recursive: true });
  writeFileSync(resolve(core, 'artifacts/build-manifest.json'), JSON.stringify(manifest, null, 2));
}
export function syncProvingArtifacts() {
  const manifest = JSON.parse(readFileSync(resolve(contractRepo, 'artifacts/manifest.json'), 'utf8'));
  if (manifest.protocol !== 'core-v1' || manifest.depth !== 8) throw new Error('Unknown circuit manifest');
  for (const file of ['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json']) copyChecked(file, manifest.hashes?.[file]);
  writeFileSync(resolve(core, 'artifacts/manifest.json'), JSON.stringify(manifest, null, 2));
}
