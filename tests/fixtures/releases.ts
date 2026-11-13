import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { encodeVerificationKey } from '../../sdk/core.js';
import { assembleRelease, digest, type ReleaseMetadata } from '../../scripts/lib/release.js';

export function releaseFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = resolve(dir, 'release'), payload = new Map<string, Buffer>();
  const add = (p: string, value: unknown) => payload.set(p, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const corePackage = { name: '@company-privacy-settlement/core', version: '0.1.0', dependencies: { zod: '^4.6.7' } };
  const clientSource = 'export const localOnly = true;', clientFiles = { 'index.js': digest('export const fixture = true;'), 'index.d.ts': digest('export declare const fixture: true;') };
  const client = { format: 'core-browser-client-v1', files: clientFiles, sources: { 'index.ts': digest(clientSource) } };
  add('sdk/client/manifest.json', client); add('sdk/client/index.js', 'export const fixture = true;'); add('sdk/client/index.d.ts', 'export declare const fixture: true;');
  for (const stem of ['core', 'client/index']) { add(`sdk/node/${stem}.js`, 'export {};'); add(`sdk/node/${stem}.d.ts`, 'export {};'); }
  const sources = {} as ReleaseMetadata['sources'];
  for (const name of ['Core', 'Contract', 'Front'] as const) {
    const pkg = name === 'Core' ? corePackage : { name: name.toLowerCase(), version: '0.1.0' };
    add(`sources/${name}/package.json`, pkg); add(`sources/${name}/package-lock.json`, { name: pkg.name, lockfileVersion: 3 });
    if (name === 'Core') { add('sources/Core/sdk/core.ts', 'export {};'); add('sources/Core/sdk/client/index.ts', clientSource); }
    if (name === 'Front') {
      add('sources/Front/src/vendor/core-client/manifest.json', client);
      for (const file of Object.keys(clientFiles)) payload.set(`sources/Front/src/vendor/core-client/${file}`, payload.get(`sdk/client/${file}`)!);
    }
    const inputs = Object.fromEntries([...payload].filter(([path]) => path.startsWith(`sources/${name}/`)).map(([path, bytes]) => [path.slice(`sources/${name}/`.length), digest(bytes)]));
    sources[name] = { commit: 'a'.repeat(40), packageVersion: '0.1.0', inputs };
  }
  add('sdk/package.json', corePackage); payload.set('sdk/package-lock.json', payload.get('sources/Core/package-lock.json')!);
  const contracts: Record<string, { wasm: string; bytes: number; sha256: string }> = {};
  for (const name of ['pool', 'factory', 'shared_vault', 'forest']) {
    const bytes = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from(name)]);
    payload.set(`artifacts/core_${name}.wasm`, bytes);
    contracts[name] = { wasm: `core_${name}.wasm`, bytes: bytes.length, sha256: digest(bytes) };
  }
  add('artifacts/build-manifest.json', { protocol: 'core-build-v1', contracts, factoryEmbeddedVaultSha256: contracts.pool.sha256, forestEmbeddedVaultSha256: contracts.shared_vault.sha256 });
  const vk = { protocol: 'groth16', curve: 'bn128', nPublic: 5, vk_alpha_1: ['1', '2'], vk_beta_2: [['1', '2'], ['3', '4']], vk_gamma_2: [['1', '2'], ['3', '4']], vk_delta_2: [['1', '2'], ['3', '4']], IC: Array.from({ length: 6 }, () => ['1', '2']) };
  add('artifacts/verification_key.json', vk); add('artifacts/spend.r1cs', 'public r1cs fixture'); add('artifacts/spend_js/spend.wasm', 'public witness fixture'); add('artifacts/spend.zkey', 'public proving fixture');
  const hashes = Object.fromEntries(['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json'].map(file => [file, digest(payload.get(`artifacts/${file}`)!)]));
  add('artifacts/manifest.json', { protocol: 'core-v1', depth: 8, setup: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', hashes });
  const policy = { network: 'testnet', registry: 'forest.testnet', denomination: '1000000', tokenId: 'usdc.testnet', feeRecipient: 'treasury.testnet', registryWasmSha256: contracts.forest.sha256, vaultWasmSha256: contracts.shared_vault.sha256, verifierSha256: digest(Buffer.from(encodeVerificationKey(vk), 'base64')) };
  add('policies/usdc.json', policy); add('README.md', 'Development fixture, not a valid circuit/contract or deployed group.');
  const metadata: ReleaseMetadata = { version: '0.1.0-demo.1', network: 'testnet', sourceDateEpoch: 1234, sources,
    tools: { node: 'test', rustc: 'test', platform: 'test' }, groups: [{ id: 'usdc', policy: 'policies/usdc.json', apiOrigin: 'https://api.example', depositsEnabled: true }] };
  return { dir, output, payload, metadata, policy, add, build: () => assembleRelease(output, metadata, payload) };
}

