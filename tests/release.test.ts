import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeVerificationKey } from '../sdk/core.js';
import { assembleRelease, committedFile, digest, ReleaseInput, verifyRelease, type ReleaseMetadata } from '../scripts/lib/release.js';

function fixture(t: { after(fn: () => void): void }) {
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

test('release packages verify offline against an independent digest, including native and FT policies', t => {
  const f = fixture(t); const result = f.build();
  const m = verifyRelease(result.directory, result.manifestSha256);
  assert.equal(m.version, '0.1.0-demo.1'); assert.equal(m.chainVerification, 'not_performed'); assert.equal(m.safety, 'UNSAFE_LOCAL_DEVELOPMENT_ONLY');
  assert.ok(m.files['sdk/node/core.js']); assert.ok(m.files['artifacts/spend.zkey']);
  const native = { ...f.policy }; delete (native as Partial<typeof f.policy>).tokenId;
  f.add('policies/usdc.json', native);
  const other = assembleRelease(resolve(f.dir, 'native'), f.metadata, f.payload);
  assert.equal(verifyRelease(other.directory, other.manifestSha256).network, 'testnet');
  assert.throws(() => f.build(), /already exists/);
});

test('release verification refuses substituted manifests, altered files and incomplete inventories', t => {
  const f = fixture(t), result = f.build(), file = resolve(f.output, 'sdk/client/index.js'), original = readFileSync(file);
  assert.throws(() => verifyRelease(f.output, '0'.repeat(64)), /trusted digest/);
  writeFileSync(file, 'modified'); assert.throws(() => verifyRelease(f.output, result.manifestSha256), /checksum/);
  writeFileSync(file, original);
  writeFileSync(resolve(f.output, 'private-note.json'), '{}'); assert.throws(() => verifyRelease(f.output, result.manifestSha256), /inventory/);
  rmSync(resolve(f.output, 'private-note.json')); rmSync(file);
  assert.throws(() => verifyRelease(f.output, result.manifestSha256), /inventory/);
});

test('release assembly rejects traversal, reserved paths and undeclared private files without creating output', t => {
  for (const path of ['../escaped', '/absolute', 'sdk//bad', 'sdk/./bad', 'release.json', 'private-note.json']) {
    const f = fixture(t); f.add(path, 'must not be packaged');
    assert.throws(() => f.build()); assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(resolve(f.dir, 'escaped')), false);
  }
});

test('release verification rejects symbolic files, symbolic directories and symbolic roots', t => {
  const f = fixture(t), result = f.build(), file = resolve(f.output, 'sdk/client/index.js');
  rmSync(file); symlinkSync(resolve(f.output, 'README.md'), file);
  assert.throws(() => verifyRelease(f.output, result.manifestSha256), /symlink/);
  rmSync(file); writeFileSync(file, f.payload.get('sdk/client/index.js')!);
  symlinkSync(f.output, resolve(f.dir, 'linked-root'));
  assert.throws(() => verifyRelease(resolve(f.dir, 'linked-root'), result.manifestSha256), /directory/);
  symlinkSync(f.dir, resolve(f.output, 'extra-directory'));
  assert.throws(() => verifyRelease(f.output, result.manifestSha256), /symlink/);
});

test('release policy validation binds raw verifier bytes and reviewed contract hashes', t => {
  for (const field of ['registryWasmSha256', 'vaultWasmSha256', 'verifierSha256'] as const) {
    const f = fixture(t);
    f.policy[field] = field === 'verifierSha256' ? digest(f.payload.get('artifacts/verification_key.json')!) : 'f'.repeat(64);
    f.add('policies/usdc.json', f.policy);
    assert.throws(() => f.build(), /released contract\/verifier/);
  }
});

test('release policy validation rejects mixed networks, zero token fees, duplicate registries and group IDs', t => {
  for (const change of ['network', 'fee', 'registry', 'id']) {
    const f = fixture(t);
    if (change === 'network') f.add('policies/usdc.json', { ...f.policy, network: 'sandbox' });
    if (change === 'fee') f.add('policies/usdc.json', { ...f.policy, denomination: '1' });
    if (change === 'registry' || change === 'id') {
      f.metadata.groups.push({ ...f.metadata.groups[0], id: change === 'id' ? 'usdc' : 'other', policy: change === 'id' ? 'policies/usdc.json' : 'policies/other.json' });
      if (change === 'registry') f.add('policies/other.json', f.policy);
    }
    assert.throws(() => f.build()); assert.equal(existsSync(f.output), false);
  }
});

test('release rejects stale browser source hashes and a different Front vendored SDK', t => {
  const f = fixture(t);
  const client = JSON.parse(f.payload.get('sdk/client/manifest.json')!.toString());
  client.sources['index.ts'] = 'f'.repeat(64); f.add('sdk/client/manifest.json', client);
  assert.throws(() => f.build(), /Stale browser SDK/);
  const other = fixture(t);
  other.add('sources/Front/src/vendor/core-client/manifest.json', { format: 'different-sdk' });
  assert.throws(() => other.build(), /Front vendored SDK/);
});

test('release rejects mismatched embedded children, proving artifacts, source inputs and Node outputs', t => {
  for (const change of ['embedded', 'proving', 'source', 'node']) {
    const f = fixture(t);
    if (change === 'embedded') { const m = JSON.parse(f.payload.get('artifacts/build-manifest.json')!.toString()); m.forestEmbeddedVaultSha256 = '0'.repeat(64); f.add('artifacts/build-manifest.json', m); }
    if (change === 'proving') f.add('artifacts/spend.zkey', 'different proving artifact');
    if (change === 'source') f.metadata.sources.Core.inputs['package.json'] = '0'.repeat(64);
    if (change === 'node') f.payload.delete('sdk/node/core.js');
    assert.throws(() => f.build()); assert.equal(existsSync(f.output), false);
  }
});

test('release inputs require explicit supported scope, exact API origins and canonical versions', () => {
  const valid = { format: 'core-release-input-v1', version: '1.2.3-test.4+build.5', network: 'testnet', groups: [{ id: 'group', policyFile: './policy.json', apiOrigin: 'https://api.example', depositsEnabled: false }] };
  assert.ok(ReleaseInput.parse(valid));
  for (const version of ['../bad', '01.0.0', '1.0', '1.0.0-01']) assert.equal(ReleaseInput.safeParse({ ...valid, version }).success, false);
  for (const apiOrigin of ['http://public.example', 'https://user:password@api.example', 'https://api.example/path', 'https://api.example?key=secret', 'https://api.example/#x']) assert.equal(ReleaseInput.safeParse({ ...valid, groups: [{ ...valid.groups[0], apiOrigin }] }).success, false);
  assert.ok(ReleaseInput.parse({ ...valid, groups: [{ ...valid.groups[0], apiOrigin: 'http://127.0.0.1:3001' }] }));
  assert.equal(ReleaseInput.safeParse({ ...valid, network: 'mainnet' }).success, false);
  assert.equal(ReleaseInput.safeParse({ ...valid, privateKey: 'must never be accepted' }).success, false);
});

test('release CLI requires the independent digest and does not imply chain readiness', t => {
  const f = fixture(t), result = f.build();
  const cli = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release.ts', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => cli('verify', f.output));
  const checked = JSON.parse(cli('verify', f.output, result.manifestSha256));
  assert.equal(checked.verified, true); assert.equal(checked.chainVerification, 'not_performed');
});

test('release source snapshots reject build changes hidden by Git assume-unchanged', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-release-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'release-test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'release-test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  git('init', '--quiet'); writeFileSync(resolve(dir, 'input.ts'), 'committed source'); git('add', 'input.ts'); git('commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD').trim();
  assert.equal(committedFile(dir, commit, 'input.ts').toString(), 'committed source');
  git('update-index', '--assume-unchanged', 'input.ts'); writeFileSync(resolve(dir, 'input.ts'), 'changed source');
  assert.equal(git('status', '--porcelain').trim(), '');
  assert.throws(() => committedFile(dir, commit, 'input.ts'), /pinned source commit/);
});
