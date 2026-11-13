import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyProvingAssets } from '../sdk/client/prover.js';
import { parsePolicy } from '../sdk/client/payment.js';

const [input, expected, policyFile, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !expected || !policyFile || !output || extra.length) throw new Error('Usage: prover:export -- <artifacts-directory> <independent-artifact-manifest-sha256> <trusted-ft-policy.json> <new-output-directory>');
  const read = async (name: string, max: number) => {
    const path = resolve(input, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > max) throw new Error('Expected bounded regular proving files');
    return readFile(path);
  };
  const manifest = await read('manifest.json', 8192), wasm = await read('spend_js/spend.wasm', 8 * 1024 * 1024), zkey = await read('spend.zkey', 16 * 1024 * 1024), verificationKey = await read('verification_key.json', 16384);
  const policy = parsePolicy(JSON.parse(await readFile(policyFile, 'utf8')));
  const verified = await verifyProvingAssets({ manifest: new Blob([manifest]), wasm: new Blob([wasm]), zkey: new Blob([zkey]), verificationKey: new Blob([verificationKey]), manifestSha256: expected }, policy);
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [name, value] of Object.entries({ 'manifest.json': manifest, 'spend.wasm': wasm, 'spend.zkey': zkey, 'verification_key.json': verificationKey })) await writeFile(resolve(output, name), value, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(output, 'README.txt'), `Core browser proving assets\nManifest SHA-256: ${expected}\nSetup: ${verified.setup}\nObtain the manifest hash independently from the reviewed release. Checksums and matching verifier bytes do not qualify a setup ceremony or a deployed chain. No private notes or keys belong in this directory.\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  console.log(JSON.stringify({ directory: resolve(output), manifestSha256: expected, setup: verified.setup, publicNetworkDeployed: false }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not export proving files');
  process.exitCode = 1;
}
