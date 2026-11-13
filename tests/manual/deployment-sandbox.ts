import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'near-workspaces';
import { InMemorySigner, KeyPair, transactions } from 'near-api-js';
import { ensureSandbox } from '../../scripts/sandbox.js';
import { assembleRelease, digest, verifyRelease, type ReleaseMetadata } from '../../scripts/lib/release.js';
import { buildDeploymentPlan, deploymentPreflight, executeDeployment, loadDeployment, NearRpcDeploymentSource, reconcileDeployment, saveDeploymentPlan, type DeploymentSource } from '../../scripts/lib/deployment.js';
import { SharedPolicySchema } from '../../sdk/shared.js';

const input = process.env.CORE_RELEASE_DIR, expected = process.env.CORE_RELEASE_MANIFEST_SHA256;
if (!input || !expected) throw new Error('Set CORE_RELEASE_DIR and independently trusted CORE_RELEASE_MANIFEST_SHA256');
const releaseDirectory = resolve(input), release = verifyRelease(releaseDirectory, expected);
const temporary = mkdtempSync(resolve(tmpdir(), 'core-deployment-rehearsal-'));
await ensureSandbox(); const worker = await Worker.init();
try {
  const root = worker.rootAccount, token = await root.createSubAccount('token', { initialBalance: 10n * 10n ** 24n }), treasury = await root.createSubAccount('treasury', { initialBalance: 10n ** 24n });
  const mock = readFileSync(resolve(process.env.CORE_CONTRACT_REPO || '../Contract', 'artifacts/core_test_ft.wasm'));
  await token.deploy(mock); await token.call(token, 'new', { owner_id: root.accountId, total_supply: '1000000000000' });
  const summaries = [];
  for (const kind of ['native', 'ft'] as const) {
    const registry = await root.createSubAccount(kind, { initialBalance: 30n * 10n ** 24n });
    const policy = SharedPolicySchema.parse({ network: 'testnet', registry: registry.accountId, denomination: kind === 'native' ? (10n ** 24n).toString() : '1000000',
      feeRecipient: treasury.accountId,
      registryWasmSha256: release.files['artifacts/core_forest.wasm'].sha256, vaultWasmSha256: release.files['artifacts/core_shared_vault.wasm'].sha256,
      verifierSha256: JSON.parse(readFileSync(resolve(releaseDirectory, release.groups[0].policy), 'utf8')).verifierSha256,
      ...(kind === 'ft' ? { tokenId: token.accountId } : {}) });
    const payload = new Map(Object.keys(release.files).filter(path => !path.startsWith('policies/')).map(path => [path, readFileSync(resolve(releaseDirectory, path))]));
    payload.set(`policies/${kind}.json`, Buffer.from(JSON.stringify(policy)));
    const { format: _f, safety: _s, chainVerification: _c, files: _files, ...original } = release;
    const metadata: ReleaseMetadata = { ...original, version: '0.1.0-rehearsal.1', network: 'testnet', groups: [{ id: kind, policy: `policies/${kind}.json`, apiOrigin: 'https://rehearsal.invalid', depositsEnabled: true }] };
    const bundle = assembleRelease(resolve(temporary, kind), metadata, payload);
    const key = await registry.getKey(); assert.ok(key);
    const pair = KeyPair.fromString(key.toString() as `ed25519:${string}`);
    const plan = buildDeploymentPlan(bundle.directory, bundle.manifestSha256, { format: 'core-testnet-deployment-input-v1', groupId: kind, rpcUrl: 'https://rpc.testnet.near.org', publicKey: pair.getPublicKey().toString(),
      gasReserveYoctoNear: '100000000000000000000000', maxRegistrationYoctoNear: kind === 'native' ? '0' : '100000000000000000000000', ...(kind === 'ft' ? { tokenCodeSha256: digest(mock) } : {}) });
    const planFile = resolve(temporary, `${kind}-plan.json`), saved = saveDeploymentPlan(planFile, plan), context = loadDeployment(planFile, saved.planSha256, bundle.directory);
    const rpc = (worker.provider as any).connection.url as string, raw = new NearRpcDeploymentSource('sandbox', registry.accountId, rpc);
    const actualChain = await raw.chain(); assert.notEqual(actualChain.chainId, 'testnet');
    // Account creation helpers return before our separately pinned finalized snapshot may observe them.
    for (let i = 0; i < 30; i++) {
      const block = await raw.finalBlock();
      if (await raw.account(registry.accountId, block.hash) && await raw.account(treasury.accountId, block.hash)) break;
      await new Promise(r => setTimeout(r, 300));
    }
    // Test-only port: actual local-chain execution, with the public testnet label supplied by this harness.
    // Production CLI has no such override: it constructs HTTPS testnet transport from the reviewed plan.
    const source: DeploymentSource = new Proxy(raw, { get(target, property) {
      if (property === 'network') return 'testnet';
      if (property === 'chain') return async () => ({ ...await target.chain(), chainId: 'testnet' });
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const signer = async (tx: transactions.Transaction) => (await transactions.signTransaction(tx, await InMemorySigner.fromKeyPair('testnet', registry.accountId, pair), registry.accountId, 'testnet'))[1];
    const journal = resolve(temporary, `${kind}-journal.json`);
    const check = await deploymentPreflight(context, source, 'deploy'); assert.equal(check.broadcast, false);
    if (kind === 'ft') {
      const interrupted: DeploymentSource = new Proxy(source, { get(target, property) {
        if (property === 'submit') return async (tx: string) => { await target.submit(tx); throw new Error('Simulated lost RPC response'); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(() => executeDeployment(context, interrupted, 'deploy', journal, saved.planSha256, signer), /uncertain/);
      assert.equal((await reconcileDeployment(context, source, journal, saved.planSha256)).attempts[0].state, 'complete');
      for (const phase of ['register-registry', 'register-treasury'] as const) assert.equal((await executeDeployment(context, source, phase, journal, saved.planSha256, signer)).state, 'complete');
    } else assert.equal((await executeDeployment(context, source, 'deploy', journal, saved.planSha256, signer)).state, 'complete');
    await assert.rejects(() => executeDeployment(context, source, 'seal', journal, saved.planSha256, signer), /acknowledgement/);
    assert.equal((await executeDeployment(context, source, 'seal', journal, saved.planSha256, signer, { acknowledgeKeyRemoval: true })).state, 'complete');
    const verified = await deploymentPreflight(context, source, 'verify'); assert.equal(verified.keyless, true);
    summaries.push({ asset: kind, rpcChainId: actualChain.chainId, simulatedNetworkLabel: 'testnet', atomicInitialization: true, keylessVerified: true,
      registrations: verified.registration, transactions: (await reconcileDeployment(context, source, journal, saved.planSha256)).attempts });
  }
  mkdirSync('demo-output', { recursive: true });
  writeFileSync('demo-output/deployment-validation.json', JSON.stringify({ fixture: 'actual-local-sandbox-wasm-testnet-labelled-port-not-public-testnet', publicNetworkDeployed: false, sourceReleaseManifestSha256: expected, summaries }, null, 2));
  console.log('Native and FT deployment rehearsal passed: actual WASM, atomic init, token registration, uncertain-response reconciliation and explicit key removal. No public-network deployment.');
} finally { await worker.tearDown(); rmSync(temporary, { recursive: true, force: true }); }
