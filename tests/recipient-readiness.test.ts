import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { operationsFixture } from './fixtures/operations.js';
import { recipientReadiness } from '../sdk/operations.js';
import { parseRecipientReadiness } from '../sdk/client/recipients.js';
import { HttpGateway } from '../sdk/client/http.js';
import { createReadOnlyApi } from '../server/api.js';

const implicit = 'a'.repeat(64), minimum = '1250000000000000000000';
test('recipient preparation separates account activation, token registration and readiness at a pinned block', async () => {
  const f = operationsFixture(); f.missingAccounts.add(implicit);
  let result = await recipientReadiness(f.source, f.policy, { recipient: implicit });
  assert.equal(result.state, 'account_missing'); assert.equal(result.accountKind, 'near_implicit');
  assert.equal(result.registrationCall, null); assert.equal(result.activationAmountYoctoNear, null);
  assert.equal(result.canReceiveTokens, false); assert.equal(result.chainFreshnessChecked, false);
  assert.equal(f.state.snapshots, 1); assert.deepEqual(new Set(f.reads.map(r => r.block)), new Set(['block-20']));
  f.missingAccounts.delete(implicit);
  f.source.account = async () => ({ amount: '0', locked: '0', storage_usage: 0 });
  result = await recipientReadiness(f.source, f.policy, { recipient: implicit });
  assert.equal(result.state, 'registration_required'); assert.equal(result.storageMinimumYoctoNear, minimum);
  assert.deepEqual(result.registrationCall, { contract: f.policy.tokenId, method: 'storage_deposit', args: { account_id: implicit, registration_only: true }, attachedYoctoNear: minimum, gas: '300000000000000' });
  f.registrations.add(implicit);
  result = await recipientReadiness(f.source, f.policy, { recipient: implicit });
  assert.equal(result.state, 'ready'); assert.equal(result.canReceiveTokens, true); assert.equal(result.registrationCall, null);
  assert.ok(f.reads.every(r => !['ft_transfer', 'ft_transfer_call', 'transfer', 'withdraw'].includes(r.method)));
});
test('pre-registration does not activate an absent account and account kinds do not imply creation instructions', async () => {
  const f = operationsFixture();
  for (const [recipient, kind] of [[implicit, 'near_implicit'], ['0x' + 'b'.repeat(40), 'eth_implicit'], [f.recipient, 'named_or_other'], ['0s' + 'c'.repeat(40), 'named_or_other']]) {
    f.missingAccounts.add(recipient); f.registrations.add(recipient);
    const result = await recipientReadiness(f.source, f.policy, { recipient });
    assert.equal(result.accountKind, kind); assert.equal(result.tokenRegistered, true);
    assert.equal(result.state, 'account_missing'); assert.equal(result.canReceiveTokens, false); assert.equal(result.registrationCall, null);
  }
});
test('recipient checks reject untrusted groups and internal destinations before reading and reject mutable deployments', async () => {
  const f = operationsFixture();
  for (const recipient of [f.policy.registry, 'child.' + f.policy.registry, 'INVALID ACCOUNT']) await assert.rejects(recipientReadiness(f.source, f.policy, { recipient }));
  await assert.rejects(recipientReadiness({ ...f.source, network: 'testnet' }, f.policy, { recipient: f.recipient }), /source/);
  const n = operationsFixture(true); await assert.rejects(recipientReadiness(n.source, n.policy, { recipient: n.recipient }), /v3/);
  assert.equal(f.state.snapshots, 0); assert.equal(n.state.snapshots, 0);
  await assert.rejects(recipientReadiness({ ...f.source, accessKeys: async () => [{}] }, f.policy, { recipient: f.recipient }), /keys/);
  await assert.rejects(recipientReadiness({ ...f.source, codeSha256: async () => 'dd'.repeat(32) }, f.policy, { recipient: f.recipient }), /code/);
});
test('invalid registration accounting and RPC errors cannot produce a ready recipient', async () => {
  for (const bounds of [{ min: '0', max: null }, { min: (10n ** 24n + 1n).toString(), max: null }, { min: minimum, max: '1' }]) {
    const f = operationsFixture(), original = f.source.contractView;
    f.source.contractView = async (a, m, args, b) => m === 'storage_balance_bounds' ? bounds : original(a, m, args, b);
    await assert.rejects(recipientReadiness(f.source, f.policy, { recipient: f.recipient }));
  }
  const f = operationsFixture(), original = f.source.contractView;
  f.source.contractView = async (a, m, args, b) => m === 'storage_balance_of' ? { total: '1', available: '2' } : original(a, m, args, b);
  await assert.rejects(recipientReadiness(f.source, f.policy, { recipient: f.recipient }), /accounting/);
  f.source.contractView = original; f.source.account = async () => { throw new Error('UNKNOWN_BLOCK'); };
  await assert.rejects(recipientReadiness(f.source, f.policy, { recipient: f.recipient }), /UNKNOWN_BLOCK/);
});
test('browser parser binds registration cost, call, recipient and policy and rejects false readiness claims', async () => {
  const f = operationsFixture(); f.source.finalBlock = async () => ({ hash: 'B'.repeat(44), height: 20 });
  const result = await recipientReadiness(f.source, f.policy, { recipient: f.recipient });
  assert.deepEqual(parseRecipientReadiness(result, f.policy, f.recipient), result);
  const corruptions = [
    { recipient: f.payer }, { policy: { ...f.policy, feeRecipient: f.payer } },
    { state: 'ready', canReceiveTokens: true }, { accountKind: 'near_implicit' },
    { activationAmountYoctoNear: '1' }, { chainFreshnessChecked: true }, { secret: 'not-public' },
    { checkedAtBlock: { hash: 'B'.repeat(44), height: 20, finalized: true } },
    { registrationCall: null },
    ...[
      { contract: f.payer }, { attachedYoctoNear: '1' }, { gas: '1' },
      { args: { account_id: f.payer, registration_only: true } },
      { args: { account_id: f.recipient, registration_only: false } },
    ].map(patch => ({ registrationCall: { ...result.registrationCall!, ...patch } })),
  ];
  for (const patch of corruptions) assert.throws(() => parseRecipientReadiness({ ...result, ...patch }, f.policy, f.recipient));
});
async function api(t: { after(fn: () => Promise<void>): void }, maxRpcReads = 16) {
  const f = operationsFixture(); f.source.finalBlock = async () => ({ hash: 'B'.repeat(44), height: 20 });
  const server = createReadOnlyApi({ source: f.source, policy: f.policy, limits: { maxRpcReads } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, query = '') => fetch(url + '/v1/recipients/readiness' + query, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...f, url, post };
}
test('read-only API and HTTP client prepare recipients without accepting secret or RPC input', async t => {
  const f = await api(t), client = new HttpGateway(f.url);
  assert.equal((await client.recipientReadiness(f.policy, f.recipient)).state, 'registration_required');
  f.registrations.add(f.recipient);
  assert.equal((await client.recipientReadiness(f.policy, f.recipient)).state, 'ready');
  for (const extra of [{ secret: 'never-return-this' }, { rpcUrl: 'http://internal.local' }, { amount: '999' }]) {
    const response = await f.post({ recipient: f.recipient, ...extra });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('never-return-this'));
  }
  assert.equal((await f.post({ recipient: f.recipient }, '?recipient=' + f.payer)).status, 400);
  await assert.rejects(client.recipientReadiness({ ...f.policy, feeRecipient: f.payer }, f.recipient), /policy/i);
  await assert.rejects(client.recipientReadiness(f.policy, f.recipient, { signal: AbortSignal.abort() }), /abort/i);
  f.source.account = async () => { throw new Error('Sensitive RPC credentials'); };
  const failed = await f.post({ recipient: f.recipient });
  assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes('Sensitive'));
});
test('recipient API read budgets stop incomplete snapshots instead of returning readiness', async t => {
  const f = await api(t, 2), response = await f.post({ recipient: f.recipient });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'RPC_BUDGET_EXCEEDED');
});
