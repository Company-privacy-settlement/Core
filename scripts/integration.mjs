import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSources, json, selectRevisions, sha256, stageResults, succeeded, verifyBrowserClient, verifyPublicVectors } from './lib/integration.mjs';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(core, '..');
const output = resolve(core, 'dist/integration');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (name, value) => { mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, name), json(value)); };
const lockPath = resolve(core, '.github/integration-lock.json');
const selected = () => selectRevisions(read(lockPath), { Core: process.env.CORE_CI_CORE_SHA, Contract: process.env.CORE_CI_CONTRACT_SHA || undefined, Front: process.env.CORE_CI_FRONT_SHA || undefined });
const action = process.argv[2];

if (action === 'refs') {
  const refs = selected();
  if (process.env.GITHUB_OUTPUT) for (const [name, revision] of Object.entries(refs)) appendFileSync(process.env.GITHUB_OUTPUT, `${name.toLowerCase()}=${revision}\n`);
  console.log(json(refs));
} else if (action === 'sources') {
  const sources = inspectSources(root, selected());
  const vectors = verifyPublicVectors(core, resolve(root, 'Contract'));
  write('sources.json', { format: 'core-integration-sources-v1', sources, vectors, lockSha256: sha256(readFileSync(lockPath)) });
  console.log('Three exact source revisions and shared public vectors verified');
} else if (action === 'client') {
  write('client.json', verifyBrowserClient(core, resolve(root, 'Front')));
  console.log('Front vendored SDK matches rebuilt Core bytes and current source inventory');
} else if (action === 'release-input') {
  // Only a disposable sandbox report can generate this CI development release.
  const report = read(resolve(core, 'demo-output/ft-validation.json'));
  if (report.policy?.network !== 'sandbox' || report.fixture !== 'NEP-141 sandbox token, NOT Circle-issued USDC') throw new Error('CI release requires the actual local FT sandbox report');
  write('policy.json', report.policy);
  write('release-input.json', { format: 'core-release-input-v1', version: '0.0.0-ci.1', network: 'sandbox', groups: [{ id: 'ci-testusd', policyFile: './policy.json', apiOrigin: 'http://127.0.0.1:3001', depositsEnabled: true }] });
} else if (action === 'release') {
  const result = JSON.parse(execFileSync('npm', ['run', '--silent', 'release:prepare', '--', resolve(output, 'release-input.json'), resolve(output, 'bundle')], { cwd: core, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  if (sha256(readFileSync(result.archive)) !== result.archiveSha256) throw new Error('CI release archive digest mismatch');
  execFileSync('npm', ['run', '--silent', 'release:verify', '--', result.directory, result.manifestSha256], { cwd: core, stdio: 'inherit' });
  const manifest = read(resolve(result.directory, 'release.json')), sources = read(resolve(output, 'sources.json')).sources;
  for (const name of Object.keys(sources)) if (manifest.sources[name].commit !== sources[name].commit) throw new Error('Release differs from tested source revisions');
  inspectSources(root, selected());
  write('release-result.json', result);
} else if (action === 'report') {
  const stages = stageResults(JSON.parse(process.env.CORE_CI_STAGES || '{}'));
  const evidence = (stage, name) => stages[stage] === 'success' && existsSync(resolve(output, name)) ? read(resolve(output, name)) : null;
  const report = { format: 'core-integration-result-v1', status: succeeded(stages) ? 'passed' : 'failed', stages,
    sources: evidence('sources', 'sources.json'),
    client: evidence('client', 'client.json'),
    release: evidence('release', 'release-result.json'),
    tools: { node: process.version, rustc: (() => { try { return execFileSync('rustc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unavailable'; } })() },
    safety: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', publicNetworkDeployed: false };
  write('report.json', report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(stages).map(([name, outcome]) => `| ${name} | ${outcome} |`).join('\n');
    const revisions = Object.entries(report.sources?.sources ?? {}).map(([name, source]) => `- ${name}: \`${source.commit}\``).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Three-repository integration: ${report.status}\n\n${revisions}\n\n| Stage | Outcome |\n| --- | --- |\n${rows}\n\nDisposable local WASM/Groth16 only. No public deployment or production qualification.\n`);
  }
  console.log(json(report));
} else throw new Error('Use refs, sources, client, release-input, release or report');
