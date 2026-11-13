import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { encodeVerificationKey, quoteFees } from '../../sdk/core.js';
import { SharedPolicySchema } from '../../sdk/shared.js';
import { parsePolicy } from '../../sdk/client/payment.js';
import { canonical } from '../../sdk/client/crypto.js';
import { quoteFtFees } from '../../sdk/ft.js';

export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.string().max(100).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  .refine(v => !v.split('+')[0].split('-').slice(1).join('-').split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith('0')), 'Noncanonical SemVer prerelease');
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Network = z.enum(['sandbox', 'testnet']);
const Repos = ['Core', 'Contract', 'Front'] as const;
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contractNames = ['pool', 'factory', 'shared_vault', 'forest'] as const;
const provingFiles = ['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json'] as const;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;

function safePath(path: string): string {
  if (path.length > 200 || !/^[a-zA-Z0-9_.\/-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || isAbsolute(path))
    throw new Error('Unsafe release path');
  return path;
}
function regular(path: string, max = MAX_FILE): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Expected a bounded regular release file');
  return readFileSync(path);
}
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a regular release directory');
}
function walk(root: string, prefix = ''): string[] {
  directory(root);
  return readdirSync(root).sort().flatMap(name => {
    const path = safePath(prefix + name), full = resolve(root, name), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('Release symlinks are forbidden');
    if (stat.isDirectory()) return walk(full, path + '/');
    if (!stat.isFile()) throw new Error('Unsupported release file');
    return [path];
  });
}
function origin(value: string) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value !== url.origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
    throw new Error('Use an exact HTTPS API origin, or loopback HTTP origin');
  return value;
}
const Origin = z.string().max(512).refine(v => { try { origin(v); return true; } catch { return false; } }, 'Invalid API origin');
export const ReleaseInput = z.object({
  format: z.literal('core-release-input-v1'), version: Version, network: Network,
  groups: z.array(z.object({ id: Id, policyFile: z.string().min(1).max(4096), apiOrigin: Origin, depositsEnabled: z.boolean() }).strict()).min(1).max(8),
}).strict();
const Source = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), packageVersion: Version,
  inputs: z.record(z.string(), Hash) }).strict();
const Inventory = z.record(z.string(), z.object({ bytes: z.number().int().min(0).max(MAX_FILE), sha256: Hash }).strict());
export const ReleaseManifest = z.object({
  format: z.literal('core-release-v1'), version: Version, network: Network,
  safety: z.literal('UNSAFE_LOCAL_DEVELOPMENT_ONLY'), chainVerification: z.literal('not_performed'),
  sourceDateEpoch: z.number().int().nonnegative().max(253402300799),
  sources: z.object({ Core: Source, Contract: Source, Front: Source }).strict(),
  tools: z.object({ node: z.string().max(100), rustc: z.string().max(200), platform: z.string().max(100) }).strict(),
  groups: z.array(z.object({ id: Id, policy: z.string(), apiOrigin: Origin, depositsEnabled: z.boolean() }).strict()).min(1).max(8),
  files: Inventory,
}).strict();
export type Release = z.infer<typeof ReleaseManifest>;
export type ReleaseMetadata = Omit<Release, 'format' | 'safety' | 'chainVerification' | 'files'>;

function uniqueGroups(groups: { id: string }[]) {
  if (new Set(groups.map(g => g.id)).size !== groups.length) throw new Error('Duplicate release group ID');
}
function checkPayload(m: Release, get: (path: string) => Buffer) {
  uniqueGroups(m.groups);
  const readJson = (path: string) => JSON.parse(get(path).toString('utf8'));
  const build = z.object({ protocol: z.literal('core-build-v1'),
    contracts: z.object(Object.fromEntries(contractNames.map(name => [name, z.object({ wasm: z.literal(`core_${name}.wasm`), bytes: z.number().int().positive(), sha256: Hash }).strict()]))).strict(),
    factoryEmbeddedVaultSha256: Hash, forestEmbeddedVaultSha256: Hash }).strict().parse(readJson('artifacts/build-manifest.json'));
  for (const name of contractNames) {
    const entry = build.contracts[name], bytes = get(`artifacts/${entry.wasm}`);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
      throw new Error('Contract artifact mismatch');
  }
  if (build.factoryEmbeddedVaultSha256 !== build.contracts.pool.sha256 || build.forestEmbeddedVaultSha256 !== build.contracts.shared_vault.sha256)
    throw new Error('Embedded vault manifest mismatch');
  const proving = z.object({ protocol: z.literal('core-v1'), depth: z.literal(8), setup: z.literal('UNSAFE_LOCAL_DEVELOPMENT_ONLY'), hashes: z.record(z.string(), Hash) }).strict().parse(readJson('artifacts/manifest.json'));
  if (Object.keys(proving.hashes).sort().join('|') !== [...provingFiles].sort().join('|')) throw new Error('Unexpected proving inventory');
  for (const file of provingFiles) if (digest(get(`artifacts/${file}`)) !== proving.hashes[file]) throw new Error('Proving artifact mismatch');
  // Policies bind the raw NEAR verification-key bytes, not the JSON file checksum.
  const key = Buffer.from(encodeVerificationKey(readJson('artifacts/verification_key.json')), 'base64');
  const fq = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  if (key.length !== 832 || !key.some(v => v !== 0)) throw new Error('Invalid verifier encoding');
  for (let i = 0; i < key.length; i += 32) if (BigInt('0x' + Buffer.from(key.subarray(i, i + 32)).reverse().toString('hex')) >= fq) throw new Error('Noncanonical verifier coordinate');
  const verifier = digest(key), registries = new Set<string>();
  for (const group of m.groups) {
    if (group.policy !== `policies/${group.id}.json`) throw new Error('Unexpected policy path');
    const policy = SharedPolicySchema.parse(readJson(group.policy));
    parsePolicy(policy);
    if (policy.network !== m.network || registries.has(policy.registry)) throw new Error('Duplicate registry or mixed release networks');
    registries.add(policy.registry);
    if (policy.registryWasmSha256 !== build.contracts.forest.sha256 || policy.vaultWasmSha256 !== build.contracts.shared_vault.sha256 || policy.verifierSha256 !== verifier)
      throw new Error('Policy does not match released contract/verifier artifacts');
    if (policy.tokenId) quoteFtFees(policy.denomination); else quoteFees(policy.denomination);
  }
  const client = z.object({ format: z.literal('core-browser-client-v1'), files: z.record(z.string(), Hash), sources: z.record(z.string(), Hash) }).strict().parse(readJson('sdk/client/manifest.json'));
  if (!client.files['index.js'] || !client.files['index.d.ts']) throw new Error('Missing browser SDK entry');
  for (const [path, hash] of Object.entries(client.files)) {
    if (!/^[a-z-]+\.(?:js|d\.ts)$/.test(path) || digest(get(`sdk/client/${path}`)) !== hash) throw new Error('Browser SDK artifact mismatch');
  }
  const clientSources = Object.keys(m.sources.Core.inputs).filter(p => p.startsWith('sdk/client/') && p.endsWith('.ts')).map(p => p.slice('sdk/client/'.length)).sort();
  if (Object.keys(client.sources).sort().join('|') !== clientSources.join('|')) throw new Error('Browser SDK source inventory mismatch');
  for (const [path, hash] of Object.entries(client.sources)) if (hash !== m.sources.Core.inputs[`sdk/client/${path}`]) throw new Error('Stale browser SDK sources');
  const vendor = readJson('sources/Front/src/vendor/core-client/manifest.json');
  if (canonical(vendor) !== canonical(client)) throw new Error('Front vendored SDK differs from the release');
  for (const [path, hash] of Object.entries(client.files)) if (digest(get(`sources/Front/src/vendor/core-client/${path}`)) !== hash) throw new Error('Front vendored SDK checksum mismatch');
  for (const repo of Repos) {
    if (!m.sources[repo].inputs['package.json'] || !m.sources[repo].inputs['package-lock.json']) throw new Error('Missing source package provenance');
    for (const [path, hash] of Object.entries(m.sources[repo].inputs)) if (digest(get(`sources/${repo}/${safePath(path)}`)) !== hash) throw new Error('Source input mismatch');
    if (readJson(`sources/${repo}/package.json`).version !== m.sources[repo].packageVersion) throw new Error('Source package version mismatch');
  }
  const sdkPackage = readJson('sdk/package.json'), corePackage = readJson('sources/Core/package.json');
  if (sdkPackage.name !== corePackage.name || sdkPackage.version !== corePackage.version || canonical(sdkPackage.dependencies) !== canonical(corePackage.dependencies) || digest(get('sdk/package-lock.json')) !== m.sources.Core.inputs['package-lock.json'])
    throw new Error('Node SDK package provenance mismatch');
  for (const path of Object.keys(m.sources.Core.inputs).filter(p => p.startsWith('sdk/') && p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
    const stem = path.slice(4, -3);
    get(`sdk/node/${stem}.js`); get(`sdk/node/${stem}.d.ts`);
  }
  // Inventory is closed: no secrets, undeclared SDK files or unrelated public files.
  const allowed = new Set(['artifacts/build-manifest.json', 'artifacts/manifest.json', 'sdk/package.json', 'sdk/package-lock.json', 'sdk/client/manifest.json', 'README.md']);
  for (const name of contractNames) allowed.add(`artifacts/core_${name}.wasm`);
  for (const file of provingFiles) allowed.add(`artifacts/${file}`);
  for (const group of m.groups) allowed.add(group.policy);
  for (const path of Object.keys(client.files)) allowed.add(`sdk/client/${path}`);
  for (const repo of Repos) for (const path of Object.keys(m.sources[repo].inputs)) allowed.add(`sources/${repo}/${safePath(path)}`);
  for (const path of Object.keys(m.sources.Core.inputs).filter(p => p.startsWith('sdk/') && p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
    const stem = path.slice(4, -3); allowed.add(`sdk/node/${stem}.js`); allowed.add(`sdk/node/${stem}.d.ts`);
  }
  if (Object.keys(m.files).sort().join('|') !== [...allowed].sort().join('|')) throw new Error('Unexpected or missing release payload');
}

/** Offline integrity verification. The expected manifest digest is mandatory and supplied independently. */
export function verifyRelease(path: string, expectedManifestSha256: string): Release {
  Hash.parse(expectedManifestSha256);
  const root = resolve(path); directory(root);
  const bytes = regular(resolve(root, 'release.json'), 1024 * 1024);
  if (digest(bytes) !== expectedManifestSha256) throw new Error('Release manifest differs from the independently trusted digest');
  const manifest = ReleaseManifest.parse(JSON.parse(bytes.toString('utf8')));
  const paths = walk(root);
  if (paths.length > 2000 || paths.sort().join('|') !== ['release.json', ...Object.keys(manifest.files)].sort().join('|')) throw new Error('Release file inventory mismatch');
  let total = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    const bytes = regular(resolve(root, safePath(path)));
    total += bytes.length;
    if (total > MAX_TOTAL || bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Release payload checksum/size mismatch');
  }
  checkPayload(manifest, path => regular(resolve(root, safePath(path))));
  return manifest;
}

/** Write a new package from an explicit public-file allowlist. Never overwrite a previous version. */
export function assembleRelease(path: string, metadata: ReleaseMetadata, payload: ReadonlyMap<string, Buffer>) {
  const root = resolve(path);
  if (existsSync(root)) throw new Error('Release output already exists');
  const files: Release['files'] = {};
  for (const [path, bytes] of [...payload].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    safePath(path);
    if (path === 'release.json') throw new Error('Reserved manifest path');
    files[path] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  const manifest = ReleaseManifest.parse({ ...metadata, format: 'core-release-v1', safety: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', chainVerification: 'not_performed', files });
  checkPayload(manifest, path => { const bytes = payload.get(safePath(path)); if (!bytes) throw new Error('Missing release input'); return bytes; });
  mkdirSync(dirname(root), { recursive: true });
  const stage = mkdtempSync(resolve(dirname(root), '.core-release-'));
  try {
    for (const [path, bytes] of payload) { const file = resolve(stage, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { mode: 0o644, flag: 'wx' }); }
    const encoded = json(manifest), manifestSha256 = digest(encoded);
    writeFileSync(resolve(stage, 'release.json'), encoded, { mode: 0o644, flag: 'wx' });
    verifyRelease(stage, manifestSha256);
    // Exclusively claim the destination before replacing our own empty placeholder.
    mkdirSync(root);
    try { renameSync(stage, root); } catch (error) { try { rmdirSync(root); } catch {} throw error; }
    return { directory: root, manifestSha256, version: manifest.version };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function command(repo: string, program: string, args: string[]) {
  return execFileSync(program, args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function run(repo: string, program: string, args: string[]) {
  const output = command(repo, program, args);
  process.stderr.write(output);
  if (/\[ERROR\]/.test(output)) throw new Error('Release build tool reported an error');
}
function cleanSource(repo: string) {
  if (command(repo, 'git', ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Commit tracked and untracked source changes before creating a release');
  return command(repo, 'git', ['rev-parse', 'HEAD']).trim();
}
function sourceInputs(repo: string, name: typeof Repos[number]) {
  const files = command(repo, 'git', ['ls-files', '-z']).split('\0').filter(Boolean);
  const common = /^(package(?:-lock)?\.json|tsconfig(?:\.[a-z]+)?\.json|rust-toolchain\.toml|THIRD_PARTY_NOTICES\.md)$/;
  return files.filter(p => common.test(p) || /^docs\/licenses\/[a-zA-Z0-9_.-]+$/.test(p) || (name === 'Core' && /^(sdk\/.*\.(?:ts)|scripts\/(?:build-client\.mjs|build-sdk\.mjs|browser-poseidon\.mjs|release\.ts|lib\/release\.ts))$/.test(p)) ||
    (name === 'Contract' && /^(contracts\/.*\.(?:rs|toml|lock|bin)|circuits\/.*\.circom|scripts\/.*\.mjs)$/.test(p)) ||
    (name === 'Front' && /^src\/vendor\/core-client\//.test(p))).sort();
}
export function committedFile(repo: string, commit: string, path: string) {
  const bytes = regular(resolve(repo, safePath(path)));
  const original = execFileSync('git', ['show', `${commit}:${path}`], { cwd: repo, maxBuffer: MAX_FILE });
  if (!bytes.equals(original)) throw new Error('Build input differs from the pinned source commit');
  return bytes;
}
function cannotContain(root: string, output: string) {
  const diff = relative(output, root);
  if (!diff || (!diff.startsWith('..' + '/') && diff !== '..' && !isAbsolute(diff))) throw new Error('Release output must not contain a source checkout');
}

/** Rebuild from clean pinned sources; keep the existing setup and validate its circuit/key linkage. */
export function prepareRelease(configFile: string, outputDirectory: string) {
  const inputPath = resolve(configFile), config = ReleaseInput.parse(JSON.parse(regular(inputPath, 64 * 1024).toString('utf8')));
  uniqueGroups(config.groups);
  const roots = { Core: coreRoot, Contract: resolve(coreRoot, process.env.CORE_CONTRACT_REPO || '../Contract'), Front: resolve(coreRoot, process.env.CORE_FRONT_REPO || '../Front') };
  const output = resolve(outputDirectory), archive = output + '.tar.gz';
  if (existsSync(output) || existsSync(archive)) throw new Error('Release output/archive already exists');
  for (const root of Object.values(roots)) cannotContain(root, output);
  const commits = Object.fromEntries(Repos.map(name => [name, cleanSource(roots[name])]));
  const policies = config.groups.map(group => SharedPolicySchema.parse(JSON.parse(regular(resolve(dirname(inputPath), group.policyFile), 16000).toString('utf8'))));
  const expectedNames = { Core: '@company-privacy-settlement/core', Contract: '@company-privacy-settlement/contracts', Front: '@company-privacy-settlement/front' };
  for (const name of Repos) if (JSON.parse(regular(resolve(roots[name], 'package.json')).toString()).name !== expectedNames[name]) throw new Error('Wrong source checkout');
  run(roots.Contract, 'npm', ['run', 'build']);
  run(roots.Core, 'npm', ['run', 'build:sdk']);
  const circuit = mkdtempSync(resolve(tmpdir(), 'core-release-circuit-'));
  try {
    run(roots.Contract, resolve(roots.Contract, 'node_modules/.bin/circom2'), ['circuits/spend.circom', '--O2', '--r1cs', '--wasm', '--sym', '-l', 'node_modules', '-o', circuit]);
    for (const file of ['spend.r1cs', 'spend_js/spend.wasm']) if (digest(regular(resolve(circuit, file))) !== digest(regular(resolve(roots.Contract, 'artifacts', file)))) throw new Error('Proving artifacts differ from the current circuit source');
    run(roots.Contract, resolve(roots.Contract, 'node_modules/.bin/snarkjs'), ['zkey', 'export', 'verificationkey', 'artifacts/spend.zkey', resolve(circuit, 'verification_key.json')]);
    if (canonical(JSON.parse(regular(resolve(circuit, 'verification_key.json')).toString())) !== canonical(JSON.parse(regular(resolve(roots.Contract, 'artifacts/verification_key.json')).toString()))) throw new Error('Proving key and verification key differ');
  } finally { rmSync(circuit, { recursive: true, force: true }); }
  const payload = new Map<string, Buffer>();
  const add = (path: string, value: Buffer | string) => { if (payload.has(path)) throw new Error('Duplicate payload file'); payload.set(safePath(path), Buffer.isBuffer(value) ? value : Buffer.from(value)); };
  const sources = {} as Release['sources'];
  for (const name of Repos) {
    const inputs: Record<string, string> = {};
    for (const path of sourceInputs(roots[name], name)) { const bytes = committedFile(roots[name], commits[name], path); inputs[path] = digest(bytes); add(`sources/${name}/${path}`, bytes); }
    sources[name] = { commit: commits[name], packageVersion: JSON.parse(regular(resolve(roots[name], 'package.json')).toString()).version, inputs };
  }
  for (const file of ['build-manifest.json', 'manifest.json', ...contractNames.map(n => `core_${n}.wasm`), ...provingFiles]) add(`artifacts/${file}`, regular(resolve(roots.Contract, 'artifacts', file)));
  for (const file of walk(resolve(roots.Core, 'dist/client'))) add(`sdk/client/${file}`, regular(resolve(roots.Core, 'dist/client', file)));
  for (const file of walk(resolve(roots.Core, 'dist/node'))) add(`sdk/node/${file}`, regular(resolve(roots.Core, 'dist/node', file)));
  const corePackage = JSON.parse(regular(resolve(roots.Core, 'package.json')).toString());
  const sdkPackage = { ...corePackage, exports: { '.': { types: './node/core.d.ts', import: './node/core.js' }, './client': { types: './client/index.d.ts', import: './client/index.js' }, './*': { types: './node/*.d.ts', import: './node/*.js' } }, files: ['node/', 'client/'] };
  delete sdkPackage.scripts;
  add('sdk/package.json', json(sdkPackage)); add('sdk/package-lock.json', regular(resolve(roots.Core, 'package-lock.json')));
  config.groups.forEach((g, i) => add(`policies/${g.id}.json`, json(policies[i])));
  add('README.md', '# Core development release\n\nUNSAFE_LOCAL_DEVELOPMENT_ONLY. Not a production ceremony, audit or chain-readiness assertion.\n\nVerify release.json against a SHA-256 obtained independently before using this bundle. Run Core release:verify on the extracted directory; do not trust a hash delivered only beside a substituted package. SDK: cd sdk and npm ci --omit=dev; browser entry: client/index.js, Node entry: node/core.js. Proving functions require the explicit artifacts directory. Policies bind this release only; retain original policies/artifacts for older notes. Never overwrite an existing group to apply this release.\n');
  for (const name of Repos) if (cleanSource(roots[name]) !== commits[name]) throw new Error('Source commit changed during release preparation');
  const metadata: ReleaseMetadata = { version: config.version, network: config.network, sources,
    sourceDateEpoch: Math.max(...Repos.map(name => Number(command(roots[name], 'git', ['show', '-s', '--format=%ct', 'HEAD']).trim()))),
    tools: { node: process.version, rustc: command(roots.Contract, 'rustc', ['--version']).trim(), platform: `${process.platform}-${process.arch}` },
    groups: config.groups.map(g => ({ id: g.id, policy: `policies/${g.id}.json`, apiOrigin: g.apiOrigin, depositsEnabled: g.depositsEnabled })) };
  const result = assembleRelease(output, metadata, payload);
  const archiveStage = mkdtempSync(resolve(dirname(output), '.core-release-archive-'));
  try {
    const temp = resolve(archiveStage, 'release.tar.gz');
    run(roots.Core, 'tar', ['--format=ustar', '--sort=name', `--mtime=@${metadata.sourceDateEpoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX', '-czf', temp, '-C', output, '.']);
    // Link-free output is already verified; never replace an existing archive.
    linkSync(temp, archive);
    return { ...result, archive, archiveSha256: digest(regular(archive, MAX_TOTAL)), safety: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', chainVerification: 'not_performed' };
  } finally { rmSync(archiveStage, { recursive: true, force: true }); }
}
