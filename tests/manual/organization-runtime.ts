import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const env = { ...process.env };
delete env.CORE_ORGANIZATION_ORIGIN;
const denied = spawnSync(process.execPath, ['dist/service/scripts/organization-server.js'], { env, encoding: 'utf8' });
assert.notEqual(denied.status, 0, 'compiled service must refuse missing audience');
const directory = mkdtempSync(resolve(tmpdir(), 'core-organization-runtime-'));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const address = reservation.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
await new Promise<void>(r => reservation.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof spawn> | undefined;
try {
  for (let round = 0; round < 2; round++) {
    child = spawn(process.execPath, ['dist/service/scripts/organization-server.js'], { env: { ...env, PORT: String(port), CORE_ORGANIZATION_HOST: '127.0.0.1', CORE_ORGANIZATION_ORIGIN: origin, CORE_ORGANIZATION_DB: resolve(directory, 'organization.sqlite'), CORE_ORGANIZATION_ALLOWED_ORIGINS: 'http://localhost:3000', CORE_ORGANIZATION_RPC_URL: 'https://rpc.testnet.near.org' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr?.on('data', b => { errors += String(b); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(errors);
      try { const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(500) }); if (response.status === 200) { ready = true; break; } } catch {}
      await delay(30);
    }
    assert.equal(ready, true, errors);
    const denied = await fetch(origin + '/v1/organizations', { headers: { origin: 'http://localhost:3000' } }); assert.equal(denied.status, 401);
    const challenge = await fetch(origin + '/v1/auth/challenge', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'fixture.testnet' }) });
    assert.equal(challenge.status, 200); const body = await challenge.json() as { audience: string }; assert.equal(body.audience, origin);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const result = await Promise.race([exited, delay(7000).then(() => { throw new Error('Organization shutdown timeout'); })]); assert.equal(result[0], 0); child = undefined;
  }
  console.log('Compiled organization service passed: required audience, health, unauthenticated denial, persisted database restart and graceful shutdown. No public chain call or live deployment.');
} finally { child?.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
