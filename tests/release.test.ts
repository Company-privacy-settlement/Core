import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assembleRelease, committedFile, digest, ReleaseInput, verifyRelease } from '../scripts/lib/release.js';
import { releaseFixture as fixture } from './fixtures/releases.js';


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
