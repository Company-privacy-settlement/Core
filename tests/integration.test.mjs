import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inspectSources, json, selectRevisions, sha256, stageIds, stageResults, succeeded, verifyBrowserClient, verifyPublicVectors } from '../scripts/lib/integration.mjs';

const baseline = { format: 'core-integration-lock-v1', Contract: 'b'.repeat(40), Front: 'c'.repeat(40) };
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'core-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = resolve(root, 'Core'), front = resolve(root, 'Front'), contract = resolve(root, 'Contract');
  const write = (file, value) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, value); };
  const source = 'export const value = true;';
  const files = { 'index.js': sha256('export const value=true;'), 'index.d.ts': sha256('export declare const value: true;') };
  const manifest = { format: 'core-browser-client-v1', files, sources: { 'index.ts': sha256(source) } };
  write(resolve(core, 'sdk/client/index.ts'), source);
  for (const dir of [resolve(core, 'dist/client'), resolve(front, 'src/vendor/core-client')]) {
    write(resolve(dir, 'index.js'), 'export const value=true;');
    write(resolve(dir, 'index.d.ts'), 'export declare const value: true;');
    write(resolve(dir, 'manifest.json'), json(manifest));
  }
  for (const name of ['spend.json', 'shared.json', 'shared-ft.json']) for (const repo of [core, contract]) write(resolve(repo, 'test-vectors', name), json({ fixture: name }));
  return { root, core, front, contract, write, manifest };
}
test('integration keeps exact baseline SHAs and replaces only explicitly selected candidates', () => {
  assert.deepEqual(selectRevisions(baseline, { Core: 'a'.repeat(40) }), { Core: 'a'.repeat(40), Contract: baseline.Contract, Front: baseline.Front });
  assert.equal(selectRevisions(baseline, { Core: 'a'.repeat(40), Front: 'd'.repeat(40) }).Front, 'd'.repeat(40));
});
test('integration rejects mutable, malformed and injected revisions or lock fields', () => {
  for (const value of ['main', 'refs/heads/main', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(40) + '\n', 'a'.repeat(40) + '\nfront=main', '', null]) assert.throws(() => selectRevisions(baseline, { Core: value }), /commit SHAs/);
  assert.throws(() => selectRevisions({ ...baseline, token: 'never-accepted' }, { Core: 'a'.repeat(40) }), /Invalid integration lock/);
  assert.throws(() => selectRevisions({ ...baseline, Contract: 'main' }, { Core: 'a'.repeat(40), Contract: 'd'.repeat(40) }), /commit SHAs/);
});
test('integration verifies actual rebuilt bytes, declarations and complete source inventory', t => {
  const f = fixture(t), result = verifyBrowserClient(f.core, f.front);
  assert.equal(result.files['index.js'], f.manifest.files['index.js']);
  f.write(resolve(f.core, 'sdk/client/added.ts'), 'export {};');
  assert.throws(() => verifyBrowserClient(f.core, f.front), /source.*inventory mismatch/);
});
test('a self-consistent but stale Front bundle fails against rebuilt Core', t => {
  const f = fixture(t), manifest = structuredClone(f.manifest);
  f.write(resolve(f.front, 'src/vendor/core-client/index.js'), 'old client');
  manifest.files['index.js'] = sha256('old client');
  f.write(resolve(f.front, 'src/vendor/core-client/manifest.json'), json(manifest));
  assert.throws(() => verifyBrowserClient(f.core, f.front), /Front SDK differs/);
});
test('a source-only change cannot reuse an old matching pair of client manifests', t => {
  const f = fixture(t);
  f.write(resolve(f.core, 'sdk/client/index.ts'), 'export const value = false;');
  assert.throws(() => verifyBrowserClient(f.core, f.front), /Stale Core browser source/);
});
test('integration rejects altered bytes, extra files, unsafe names and artifact symlinks', t => {
  const f = fixture(t), vendor = resolve(f.front, 'src/vendor/core-client');
  f.write(resolve(vendor, 'index.js'), 'tampered');
  assert.throws(() => verifyBrowserClient(f.core, f.front), /checksum mismatch/);
  f.write(resolve(vendor, 'index.js'), 'export const value=true;');
  f.write(resolve(vendor, 'extra.js'), 'export {};');
  assert.throws(() => verifyBrowserClient(f.core, f.front), /inventory mismatch/);
  rmSync(resolve(vendor, 'extra.js'));
  const manifest = structuredClone(f.manifest); manifest.files['../outside.js'] = 'a'.repeat(64);
  f.write(resolve(vendor, 'manifest.json'), json(manifest));
  assert.throws(() => verifyBrowserClient(f.core, f.front), /Invalid browser artifact/);
  f.write(resolve(vendor, 'manifest.json'), json(f.manifest));
  rmSync(resolve(vendor, 'index.js')); symlinkSync(resolve(f.core, 'dist/client/index.js'), resolve(vendor, 'index.js'));
  assert.throws(() => verifyBrowserClient(f.core, f.front), /regular artifact/);
});
test('committed Core and Contract public-vector bytes must match', t => {
  const f = fixture(t);
  assert.equal(Object.keys(verifyPublicVectors(f.core, f.contract)).length, 3);
  f.write(resolve(f.contract, 'test-vectors/shared-ft.json'), '{}');
  assert.throws(() => verifyPublicVectors(f.core, f.contract), /public vector differs/);
});
test('source evidence rejects wrong commits, dirty source and wrong package identity', t => {
  const f = fixture(t), selected = {};
  const names = { Core: '@company-privacy-settlement/core', Contract: '@company-privacy-settlement/contracts', Front: '@company-privacy-settlement/front' };
  for (const [name, pkg] of Object.entries(names)) {
    const dir = resolve(f.root, name), git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    f.write(resolve(dir, 'package.json'), json({ name: pkg, version: '0.0.0' }));
    git(['init', '--quiet']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    selected[name] = git(['rev-parse', 'HEAD']);
  }
  assert.equal(inspectSources(f.root, selected).Front.commit, selected.Front);
  assert.throws(() => inspectSources(f.root, { ...selected, Front: 'a'.repeat(40) }), /differs from selected/);
  f.write(resolve(f.front, 'uncommitted.ts'), 'export {};');
  assert.throws(() => inspectSources(f.root, selected), /source checkout is dirty/);
  rmSync(resolve(f.front, 'uncommitted.ts'));
  f.write(resolve(f.front, 'package.json'), json({ name: 'wrong', version: '0.0.0' }));
  execFileSync('git', ['-C', f.front, 'add', '.']);
  execFileSync('git', ['-C', f.front, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'wrong identity']);
  selected.Front = execFileSync('git', ['-C', f.front, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.throws(() => inspectSources(f.root, selected), /package identity mismatch/);
});
test('failed, cancelled, skipped and missing stages never produce a passed integration report', () => {
  const steps = Object.fromEntries(stageIds.map(id => [id, { outcome: 'success', conclusion: 'success' }]));
  assert.equal(succeeded(stageResults(steps)), true);
  for (const outcome of ['failure', 'cancelled', 'skipped']) {
    assert.equal(succeeded(stageResults({ ...steps, ft: { outcome, conclusion: 'success' } })), false);
  }
  assert.equal(succeeded(stageResults({ ...steps, relay: { outcome: 'failure' } })), false);
  const withoutRelay = { ...steps }; delete withoutRelay.relay;
  assert.equal(succeeded(stageResults(withoutRelay)), false);
  delete steps.release;
  assert.equal(stageResults(steps).release, 'not_run');
  assert.equal(succeeded(stageResults(steps)), false);
});
