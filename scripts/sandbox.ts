import { existsSync, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// near-workspaces 5 bundles a 2.6.2 sandbox, older than near-sdk 5.30 host imports.
// Use the official versioned nearcore artifact in this project's ignored directory.
export async function ensureSandbox(): Promise<void> {
  const version = '2.14.1';
  const platform = process.platform === 'linux' && process.arch === 'x64' ? 'Linux-x86_64'
    : process.platform === 'darwin' && process.arch === 'arm64' ? 'Darwin-arm64' : null;
  if (!platform) throw new Error('Demo supports Linux x64 or macOS arm64');
  const dir = resolve('artifacts', `sandbox-${version}`), binary = resolve(dir, 'near-sandbox');
  await mkdir(dir, { recursive: true });
  if (!existsSync(binary)) {
    console.log(`Downloading official NEAR sandbox ${version}…`);
    const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platform}/${version}/near-sandbox.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`Sandbox download HTTP ${response.status}`);
    const archive = resolve(dir, 'sandbox.tar.gz');
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(archive));
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
    if (extracted.status !== 0 || !existsSync(binary)) throw new Error('Sandbox extraction failed');
  }
  const check = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (check.status !== 0 || !check.stdout.includes(version)) throw new Error('Unexpected sandbox binary version');
  process.env.NEAR_SANDBOX_BIN_PATH = dir;
  process.env.NEAR_SANDBOX_BINARY_PATH = dir;
}
