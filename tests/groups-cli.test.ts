import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNote, sha256 } from '../sdk/core.js';
import { encryptPrivate, decryptPrivate } from '../sdk/disclosure.js';
import { groupPool } from '../sdk/groups.js';
import { groupFixture, groupDirectory } from './fixtures/groups.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const old = groupFixture('old'), next = groupFixture('next'), spare = groupFixture('spare'), fixtures = [old, next, spare];
  old.config.leaf_count = 256;
  const { directory } = groupDirectory(...fixtures), dir = await mkdtemp(join(tmpdir(), 'core-groups-cli-'));
  const registryCode = Buffer.from('registry-code'), vaultCode = Buffer.from('vault-code');
  for (const f of fixtures) {
    f.policy.registryWasmSha256 = sha256(registryCode); f.policy.vaultWasmSha256 = sha256(vaultCode);
    f.config.vault_wasm_sha256 = f.policy.vaultWasmSha256;
  }
  const policyFile = join(dir, 'approved.json'), noteFile = join(dir, 'note.json'), password = 'group CLI regression password';
  const calls: { method: string; account?: string; block?: string }[] = [];
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const { id, method, params: p } = JSON.parse(text); let result: unknown;
      calls.push({ method: method === 'query' ? p.method_name ?? p.request_type : method, account: p?.account_id, block: p?.block_id });
      if (method === 'block') result = { header: { hash: 'groups-final-block' } };
      else {
        assert.equal(method, 'query');
        const f = fixtures.find(f => [f.policy.registry, f.vault].includes(p.account_id)); assert.ok(f);
        if (p.request_type === 'view_code') result = { code_base64: (p.account_id === f.policy.registry ? registryCode : vaultCode).toString('base64') };
        else if (p.request_type === 'view_access_key_list') result = { keys: [] };
        else {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()); let value: unknown;
          if (p.method_name === 'get_config') value = p.account_id === f.policy.registry ? f.config : f.local;
          else if (p.method_name === 'list_vaults') value = [f.record].slice(args.from_index, args.from_index + args.limit);
          else if (p.method_name === 'get_vault') value = args.account_id === f.vault ? f.record : null;
          else throw new Error('Unexpected fixture method');
          result = { result: [...Buffer.from(JSON.stringify(value))] };
        }
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const saveDirectory = () => writeFile(policyFile, JSON.stringify(directory)); await saveDirectory();
  const run = (command: string, ...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/cli.ts', command, policyFile, `http://127.0.0.1:${address.port}`, ...args], { env: { ...process.env, CORE_NOTE_PASSWORD: password } });
  return { old, next, spare, directory, dir, noteFile, password, calls, run, saveDirectory };
}

test('CLI selects the next approved group, protects the encrypted backup and never reroutes an existing note', async t => {
  const f = await fixture(t);
  let result = JSON.parse((await f.run('groups-status')).stdout);
  assert.equal(result.groups[0].depositState, 'full'); assert.equal(result.groups[1].depositState, 'available');
  result = JSON.parse((await f.run('group-note', f.noteFile)).stdout);
  assert.equal(result.groupId, 'next'); assert.equal(result.policy.registry, f.next.policy.registry);
  const note = decryptPrivate(await readFile(f.noteFile, 'utf8'), f.password) as { secret: string; nullifier: string; commitment: string };
  assert.equal(result.paymentRequest.commitment, note.commitment);
  assert.ok(!JSON.stringify(result).includes(note.secret)); assert.ok(!JSON.stringify(result).includes(note.nullifier));
  assert.equal((await stat(f.noteFile)).mode & 0o777, 0o600);
  await assert.rejects(f.run('group-note', f.noteFile), /EEXIST/);
  f.calls.length = 0;
  result = JSON.parse((await f.run('group-deposit-args', f.noteFile, 'ab'.repeat(32))).stdout);
  assert.equal(result.groupId, 'next'); assert.equal(result.tokenCall.args.receiver_id, f.next.vault); assert.equal(result.tokenCall.args.amount, '1001500');
  assert.equal(f.calls.filter(c => c.method === 'block').length, 1);
  assert.deepEqual(new Set(f.calls.flatMap(c => c.block ? [c.block] : [])), new Set(['groups-final-block']));
  assert.ok(f.calls.filter(c => c.account).every(c => [f.next.policy.registry, f.next.vault].includes(c.account!)));
  f.next.config.leaf_count = 256;
  f.calls.length = 0;
  await assert.rejects(f.run('group-deposit-args', f.noteFile, 'ab'.repeat(32)), /full group.*cannot be rerouted/);
  assert.ok(f.calls.filter(c => c.account).every(c => [f.next.policy.registry, f.next.vault].includes(c.account!)));
  f.next.group.depositsEnabled = false; await f.saveDirectory(); f.calls.length = 0;
  await assert.rejects(f.run('group-deposit-args', f.noteFile, 'ab'.repeat(32)), /deposits are disabled/);
  assert.equal(f.calls.length, 0);
});

test('CLI rejects foreign notes locally and locates retired-group withdrawal policy before proof generation', async t => {
  const f = await fixture(t), foreign = groupFixture('foreign'), actionFile = join(f.dir, 'action.json'), outputFile = join(f.dir, 'plan.json');
  await writeFile(actionFile, JSON.stringify({ kind: 'withdraw', vault: f.old.vault, target: f.old.recipient, disclosureRoot: 'ab'.repeat(32) }));
  await writeFile(f.noteFile, encryptPrivate(await createNote(groupPool(foreign.group)), f.password));
  for (const command of ['group-deposit-args', 'group-spend-args']) {
    await assert.rejects(command === 'group-deposit-args' ? f.run(command, f.noteFile, 'ab'.repeat(32)) : f.run(command, f.noteFile, actionFile, outputFile), /outside the approved directory/);
  }
  assert.equal(f.calls.length, 0);
  await writeFile(f.noteFile, encryptPrivate(await createNote(groupPool(f.old.group)), f.password));
  f.old.group.depositsEnabled = false; await f.saveDirectory();
  // A foreign selected vault is rejected on the old registry, before any prover artifacts are needed.
  await writeFile(actionFile, JSON.stringify({ kind: 'withdraw', vault: f.next.vault, target: f.old.recipient, disclosureRoot: 'ab'.repeat(32) }));
  await assert.rejects(f.run('group-spend-args', f.noteFile, actionFile, outputFile), /not registered in this group/);
  assert.ok(f.calls.some(c => c.method === 'get_vault' && c.account === f.old.policy.registry));
  assert.ok(f.calls.filter(c => c.account).every(c => c.account === f.old.policy.registry));
  await assert.rejects(readFile(outputFile), /ENOENT/);
  await writeFile(actionFile, JSON.stringify({ kind: 'transfer', target: '42', disclosureRoot: 'ab'.repeat(32) }));
  f.calls.length = 0;
  await assert.rejects(f.run('group-spend-args', f.noteFile, actionFile, outputFile), /private transfers require a new output slot/);
  assert.ok(f.calls.filter(c => c.account).every(c => [f.old.policy.registry, f.old.vault].includes(c.account!)));
});
