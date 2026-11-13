import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const repositories = ['Core', 'Contract', 'Front'];
const packages = { Core: '@company-privacy-settlement/core', Contract: '@company-privacy-settlement/contracts', Front: '@company-privacy-settlement/front' };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function commit(value) {
  if (typeof value !== 'string' || value.length !== 40 || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Integration revisions must be full lowercase 40-character commit SHAs');
  return value;
}
export function selectRevisions(lock, candidate) {
  if (!lock || lock.format !== 'core-integration-lock-v1' || Object.keys(lock).sort().join() !== 'Contract,Front,format') throw new Error('Invalid integration lock');
  // Always validate the committed baseline, even when a candidate overrides it.
  commit(lock.Contract); commit(lock.Front);
  return { Core: commit(candidate.Core), Contract: commit(candidate.Contract ?? lock.Contract), Front: commit(candidate.Front ?? lock.Front) };
}
export function inspectSources(root, selected) {
  return Object.fromEntries(repositories.map(name => {
    const dir = resolve(root, name), revision = git(dir, ['rev-parse', 'HEAD']);
    if (revision !== commit(selected[name])) throw new Error(`${name} checkout differs from selected revision`);
    if (git(dir, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`${name} source checkout is dirty`);
    const pkg = readJson(resolve(dir, 'package.json'));
    if (pkg.name !== packages[name]) throw new Error(`${name} package identity mismatch`);
    return [name, { repository: `Company-privacy-settlement/${name}`, commit: revision, tree: git(dir, ['rev-parse', 'HEAD^{tree}']), packageVersion: pkg.version }];
  }));
}
function publicFile(dir, name) {
  const path = resolve(dir, name);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Expected regular artifact file');
  return readFileSync(path);
}
function sameInventory(actual, expected, label) {
  if (actual.sort().join('|') !== expected.sort().join('|')) throw new Error(`${label} inventory mismatch`);
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser manifest');
  return value;
}
function browser(dir) {
  const manifest = JSON.parse(publicFile(dir, 'manifest.json'));
  if (manifest.format !== 'core-browser-client-v1') throw new Error('Invalid browser manifest format');
  sameInventory(Object.keys(manifest), ['format', 'files', 'sources'], 'Browser manifest');
  const files = object(manifest.files), sources = object(manifest.sources);
  if (!files['index.js'] || !files['index.d.ts'] || !sources['index.ts']) throw new Error('Missing browser SDK entry');
  for (const [name, hash] of Object.entries(files)) {
    if (!/^[a-z-]+\.(?:js|d\.ts)$/.test(name) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid browser artifact inventory');
    if (sha256(publicFile(dir, name)) !== hash) throw new Error(`Browser SDK checksum mismatch: ${name}`);
  }
  for (const [name, hash] of Object.entries(sources)) {
    if (!/^[a-z-]+\.ts$/.test(name) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid browser source inventory');
  }
  sameInventory(readdirSync(dir), ['manifest.json', ...Object.keys(files)], 'Browser SDK');
  return manifest;
}
export function verifyBrowserClient(core, front) {
  const builtDir = resolve(core, 'dist/client'), vendorDir = resolve(front, 'src/vendor/core-client');
  const built = browser(builtDir), vendor = browser(vendorDir);
  for (const key of ['files', 'sources']) {
    sameInventory(Object.keys(built[key]), Object.keys(vendor[key]), `Front SDK ${key}`);
    for (const [name, hash] of Object.entries(built[key])) if (vendor[key][name] !== hash) throw new Error(`Front SDK differs from rebuilt Core: ${name}. Sync and commit the client; CI never rewrites it.`);
  }
  const sourceDir = resolve(core, 'sdk/client');
  sameInventory(readdirSync(sourceDir).filter(f => f.endsWith('.ts')), Object.keys(built.sources), 'Core browser sources');
  for (const [name, hash] of Object.entries(built.sources)) if (sha256(publicFile(sourceDir, name)) !== hash) throw new Error(`Stale Core browser source: ${name}`);
  return { format: built.format, files: built.files, sources: built.sources, manifestSha256: sha256(publicFile(builtDir, 'manifest.json')) };
}
export function verifyPublicVectors(core, contract) {
  const expected = ['shared-ft.json', 'shared.json', 'spend.json'];
  for (const dir of [resolve(core, 'test-vectors'), resolve(contract, 'test-vectors')]) sameInventory(readdirSync(dir), expected.slice(), 'Public vectors');
  return Object.fromEntries(expected.map(name => {
    const a = publicFile(resolve(core, 'test-vectors'), name), b = publicFile(resolve(contract, 'test-vectors'), name);
    if (!a.equals(b)) throw new Error(`Core/Contract public vector differs: ${name}`);
    return [name, sha256(a)];
  }));
}
export const stageIds = ['checkout-core', 'node', 'refs', 'checkout-contract', 'checkout-front', 'sources', 'rust', 'cache', 'install', 'core', 'sdk', 'client', 'service', 'front', 'chromium', 'browser', 'contracts', 'setup', 'native', 'ft', 'release'];
export function stageResults(steps) {
  return Object.fromEntries(stageIds.map(id => [id, steps[id]?.outcome ?? 'not_run']));
}
export function succeeded(stages) { return stageIds.every(id => stages[id] === 'success'); }
