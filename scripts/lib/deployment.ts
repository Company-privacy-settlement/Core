import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import { InMemorySigner, KeyPair, transactions, utils } from 'near-api-js';
import { z } from 'zod';
import { canonical } from '../../sdk/client/crypto.js';
import { encodeVerificationKey } from '../../sdk/core.js';
import { NearRpcOperationsSource, type OperationsSource } from '../../sdk/operations.js';
import { discoverSharedVaults, SharedPolicySchema } from '../../sdk/shared.js';
import { Atomic, Count, Sha256 } from '../../sdk/validation.js';
import { digest, verifyRelease } from './release.js';

const NEAR = 10n ** 24n, GAS = 300n * 10n ** 12n;
const zeroCodeHash = bs58.encode(new Uint8Array(32));
const Phase = z.enum(['deploy', 'register-registry', 'register-treasury', 'seal']);
export type DeploymentPhase = z.infer<typeof Phase>;
const PublicKey = z.string().refine(value => { try { return value.startsWith('ed25519:') && utils.PublicKey.fromString(value).toString() === value; } catch { return false; } }, 'Use a canonical Ed25519 public key');
const RpcUrl = z.string().max(1024).refine(value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, 'Use a public HTTPS testnet RPC URL without credentials');
const Positive = Atomic.refine(v => BigInt(v) > 0n);
export const DeploymentInput = z.object({ format: z.literal('core-testnet-deployment-input-v1'), groupId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  rpcUrl: RpcUrl, publicKey: PublicKey, gasReserveYoctoNear: Positive, maxRegistrationYoctoNear: Atomic, tokenCodeSha256: Sha256.optional() }).strict();
export const DeploymentPlan = z.object({ format: z.literal('core-testnet-deployment-v1'), network: z.literal('testnet'),
  releaseManifestSha256: Sha256, releaseVersion: z.string().min(1).max(100), groupId: z.string(), policy: SharedPolicySchema,
  rpcUrl: RpcUrl, publicKey: PublicKey, gasReserveYoctoNear: Positive, maxRegistrationYoctoNear: Atomic, tokenCodeSha256: Sha256.optional(),
  initMethod: z.enum(['new', 'new_ft']), initArgs: z.record(z.string(), z.unknown()),
  initDepositYoctoNear: z.literal('1000000000000000000000000'), gas: z.literal('300000000000000'),
  safety: z.literal('UNSAFE_LOCAL_DEVELOPMENT_ONLY'), keyRemoval: z.literal('separate_explicit_phase'),
}).strict();
export type Plan = z.infer<typeof DeploymentPlan>;
type Context = { plan: Plan; releaseDirectory: string; wasm: Buffer };
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
function boundedFile(path: string, max: number) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw new Error('Expected a bounded regular deployment file'); return readFileSync(path); }

export function buildDeploymentPlan(releaseDirectory: string, expectedReleaseDigest: string, raw: unknown): Plan {
  const input = DeploymentInput.parse(raw), release = verifyRelease(releaseDirectory, expectedReleaseDigest);
  if (release.network !== 'testnet') throw new Error('Public deployment requires a testnet release, never sandbox/mainnet');
  const group = release.groups.find(g => g.id === input.groupId);
  if (!group || !group.depositsEnabled) throw new Error('Choose a released group enabled for a new deployment');
  const p = SharedPolicySchema.parse(JSON.parse(boundedFile(resolve(releaseDirectory, group.policy), 16000).toString()));
  if (p.network !== 'testnet' || p.feeRecipient === p.registry || p.tokenId === p.registry || p.tokenId === p.feeRecipient) throw new Error('Invalid testnet deployment destinations');
  if (!!p.tokenId !== !!input.tokenCodeSha256 || (p.tokenId && BigInt(input.maxRegistrationYoctoNear) === 0n)) throw new Error('FT deployment requires an independently reviewed token code hash and registration limit');
  const key = encodeVerificationKey(JSON.parse(boundedFile(resolve(releaseDirectory, 'artifacts/verification_key.json'), 65536).toString()));
  return DeploymentPlan.parse({ ...input, format: 'core-testnet-deployment-v1', network: 'testnet', releaseManifestSha256: expectedReleaseDigest, releaseVersion: release.version, policy: p,
    initMethod: p.tokenId ? 'new_ft' : 'new', initArgs: { network: 'testnet', denomination: p.denomination, fee_recipient: p.feeRecipient, verification_key: key, ...(p.tokenId ? { token_id: p.tokenId } : {}) },
    initDepositYoctoNear: NEAR.toString(), gas: GAS.toString(), safety: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', keyRemoval: 'separate_explicit_phase' });
}
export function loadDeployment(planFile: string, expectedPlanDigest: string, releaseDirectory: string): Context {
  Sha256.parse(expectedPlanDigest);
  const bytes = boundedFile(planFile, 65536);
  if (digest(bytes) !== expectedPlanDigest) throw new Error('Deployment plan differs from the reviewed digest');
  const p = DeploymentPlan.parse(JSON.parse(bytes.toString()));
  const rebuilt = buildDeploymentPlan(releaseDirectory, p.releaseManifestSha256, { format: 'core-testnet-deployment-input-v1', groupId: p.groupId, rpcUrl: p.rpcUrl, publicKey: p.publicKey,
    gasReserveYoctoNear: p.gasReserveYoctoNear, maxRegistrationYoctoNear: p.maxRegistrationYoctoNear, ...(p.tokenCodeSha256 ? { tokenCodeSha256: p.tokenCodeSha256 } : {}) });
  if (canonical(p) !== canonical(rebuilt)) throw new Error('Deployment plan actions differ from the release');
  return { plan: p, releaseDirectory, wasm: boundedFile(resolve(releaseDirectory, 'artifacts/core_forest.wasm'), 1_400_000) };
}
export function saveDeploymentPlan(file: string, plan: Plan) {
  const bytes = json(plan); writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return { file: resolve(file), planSha256: digest(bytes), phases: Phase.options, network: 'testnet', broadcast: false };
}

export interface DeploymentSource extends OperationsSource {
  chain(): Promise<{ chainId: string; syncing: boolean; latestHeight: number; latestTime: string }>;
  costs(block: string): Promise<{ storageByteCost: string; gasPrice: string }>;
  emptyState(account: string, block: string): Promise<boolean>;
  submit(signedTransactionBase64: string): Promise<unknown>;
  transaction(hash: string, signer: string): Promise<unknown | null>;
}
export class NearRpcDeploymentSource extends NearRpcOperationsSource implements DeploymentSource {
  async chain() { const s = z.object({ chain_id: z.string(), sync_info: z.object({ syncing: z.boolean(), latest_block_height: Count, latest_block_time: z.string().datetime() }) }).parse(await this.rpc('status', [])); return { chainId: s.chain_id, syncing: s.sync_info.syncing, latestHeight: s.sync_info.latest_block_height, latestTime: s.sync_info.latest_block_time }; }
  async costs(block: string) {
    const [config, gas] = await Promise.all([this.rpc('EXPERIMENTAL_protocol_config', { block_id: block }), this.rpc('gas_price', [block])]);
    return { storageByteCost: Positive.parse(config.runtime_config.storage_amount_per_byte), gasPrice: Positive.parse(gas.gas_price) };
  }
  async emptyState(account: string, block: string) { const state = z.object({ values: z.array(z.unknown()) }).parse(await this.rpc('query', { request_type: 'view_state', account_id: account, prefix_base64: '', block_id: block })); return state.values.length === 0; }
  submit(signedTransactionBase64: string) { return this.rpc('send_tx', { signed_tx_base64: signedTransactionBase64, wait_until: 'FINAL' }); }
}
const Account = z.object({ amount: Atomic, locked: Atomic, storage_usage: Count, code_hash: z.string().min(1) });
const Keys = z.array(z.object({ public_key: PublicKey, access_key: z.object({ nonce: Count, permission: z.unknown() }) }));
async function initialized(source: DeploymentSource, p: Plan, block: string, sealed: boolean) {
  // Reuse the complete shared-policy validator, while explicitly accounting for the temporary deployment key.
  const actualKeys = await source.accessKeys(p.policy.registry, block);
  if (sealed ? actualKeys.length !== 0 : !singleKey(actualKeys, p.publicKey)) throw new Error(sealed ? 'Registry is not keyless' : 'Unexpected deployment access keys');
  const pinned = new Proxy(source, { get(target, key) {
    if (key === 'finalizedBlock') return async () => block;
    if (key === 'accessKeys') return (account: string, at: string) => account === p.policy.registry && !sealed ? Promise.resolve([]) : target.accessKeys(account, at);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const catalog = await discoverSharedVaults(pinned, p.policy, { maxRecords: 1 });
  return catalog;
}
function singleKey(raw: unknown[], publicKey: string): boolean { const keys = Keys.parse(raw); return keys.length === 1 && keys[0].public_key === publicKey && keys[0].access_key.permission === 'FullAccess'; }
function freshTestnet(chain: Awaited<ReturnType<DeploymentSource['chain']>>) {
  const age = Date.now() - Date.parse(chain.latestTime);
  if (chain.chainId !== 'testnet' || chain.syncing || !Number.isFinite(age) || age < -30000 || age > 120000) throw new Error('RPC must be a fresh synchronized testnet node');
}

export async function deploymentPreflight(context: Context, source: DeploymentSource, phase: DeploymentPhase | 'verify' | 'initialized') {
  if (![...Phase.options, 'verify', 'initialized'].includes(phase)) throw new Error('Unknown deployment phase');
  const p = context.plan;
  if (source.network !== 'testnet' || source.factory !== p.policy.registry) throw new Error('Deployment source binding mismatch');
  const chain = await source.chain();
  freshTestnet(chain);
  const block = await source.finalBlock();
  if (Math.abs(Count.parse(chain.latestHeight) - block.height) > 10) throw new Error('Finalized deployment snapshot is too far from the observed chain head');
  const [rawAccount, treasury, rawKeys, costs] = await Promise.all([source.account(p.policy.registry, block.hash), source.account(p.policy.feeRecipient, block.hash), source.accessKeys(p.policy.registry, block.hash), source.costs(block.hash)]);
  if (!rawAccount || !treasury) throw new Error('Activate and fund registry/treasury accounts separately before deployment');
  const account = Account.parse(rawAccount), keys = Keys.parse(rawKeys), storageCost = BigInt(Positive.parse(costs.storageByteCost)), gasPrice = BigInt(Positive.parse(costs.gasPrice));
  if (phase !== 'verify' && (!singleKey(rawKeys, p.publicKey) || account.locked !== '0')) throw new Error('Require one matching FullAccess deployment key and no staked balance');
  if (phase === 'deploy') {
    if (account.code_hash !== zeroCodeHash || !await source.emptyState(p.policy.registry, block.hash)) throw new Error('Refuse to overwrite existing code or contract state');
  } else {
    const catalog = await initialized(source, p, block.hash, phase === 'verify');
    if (phase === 'seal' && (catalog.vaultCount !== 0 || catalog.leafCount !== 0 || catalog.outstandingNotes !== 0)) throw new Error('Seal before creating vaults or accepting deposits');
  }
  let registration: { account: string; required: boolean; deposit: string }[] = [];
  if (p.policy.tokenId) {
    if (await source.codeSha256(p.policy.tokenId, block.hash) !== p.tokenCodeSha256) throw new Error('Token code differs from the independently reviewed hash');
    const metadata = z.object({ spec: z.literal('ft-1.0.0'), decimals: z.number().int().min(0).max(255), symbol: z.string().min(1).max(128) }).parse(await source.contractView(p.policy.tokenId, 'ft_metadata', {}, block.hash));
    const bounds = z.object({ min: Positive, max: Atomic.nullable() }).parse(await source.contractView(p.policy.tokenId, 'storage_balance_bounds', {}, block.hash));
    if ((bounds.max !== null && BigInt(bounds.max) < BigInt(bounds.min)) || BigInt(bounds.min) > BigInt(p.maxRegistrationYoctoNear)) throw new Error('Token registration storage exceeds the reviewed limit');
    for (const account of [p.policy.registry, p.policy.feeRecipient]) {
      const entry = z.object({ total: Atomic, available: Atomic }).nullable().parse(await source.contractView(p.policy.tokenId, 'storage_balance_of', { account_id: account }, block.hash));
      if (entry && (BigInt(entry.total) < BigInt(bounds.min) || BigInt(entry.available) > BigInt(entry.total))) throw new Error('Invalid token registration accounting');
      registration.push({ account, required: entry === null, deposit: entry ? '0' : bounds.min });
    }
    if ((phase === 'seal' || phase === 'verify') && registration.some(r => r.required)) throw new Error('Register registry and treasury on the token before sealing');
    void metadata;
  } else if (phase.startsWith('register-')) throw new Error('Native NEAR groups need no token registration');
  // Conservative reserve, not a fee cap or a storage/gas reservation. Signer and receiver coincide for init.
  const storageBytes = BigInt(account.storage_usage + (phase === 'deploy' ? context.wasm.length + 65536 : 0));
  const pendingStorage = registration.reduce((n, r) => n + BigInt(r.deposit), 0n);
  const required = storageBytes * storageCost + NEAR + BigInt(p.gasReserveYoctoNear) + pendingStorage;
  if (phase !== 'verify' && (GAS * gasPrice > BigInt(p.gasReserveYoctoNear) || BigInt(account.amount) < required)) throw new Error('Insufficient registry balance or gas reserve for the reviewed snapshot');
  return { phase, checkedAtBlock: block, registry: p.policy.registry, publicKey: p.publicKey, keys,
    registration, minimumBalanceYoctoNear: required.toString(), quoteIsReservation: false as const,
    keyless: phase === 'verify', fundsReady: false as const, broadcast: false as const };
}
function actionSet(context: Context, phase: DeploymentPhase, preflight: Awaited<ReturnType<typeof deploymentPreflight>>) {
  const p = context.plan;
  if (phase === 'deploy') return { receiver: p.policy.registry, actions: [transactions.deployContract(context.wasm), transactions.functionCall(p.initMethod, Buffer.from(canonical(p.initArgs)), GAS, NEAR)] };
  if (phase === 'seal') return { receiver: p.policy.registry, actions: [transactions.deleteKey(utils.PublicKey.fromString(p.publicKey))] };
  const account = phase === 'register-registry' ? p.policy.registry : p.policy.feeRecipient;
  const registration = preflight.registration.find(r => r.account === account);
  if (!registration?.required || !p.policy.tokenId) return null;
  return { receiver: p.policy.tokenId, actions: [transactions.functionCall('storage_deposit', Buffer.from(canonical({ account_id: account, registration_only: true })), GAS, BigInt(registration.deposit))] };
}

const Attempt = z.object({ phase: Phase, unsignedTransaction: z.string().max(2_000_000), hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  state: z.enum(['intent', 'submitted', 'complete', 'failed']), }).strict();
const Journal = z.object({ format: z.literal('core-deployment-journal-v1'), planSha256: Sha256, attempts: z.array(Attempt).max(16) }).strict();
type AttemptValue = z.infer<typeof Attempt>;
function decodedPublicKey(raw: any) {
  if (!raw?.ed25519Key?.data || raw.ed25519Key.data.length !== 32) throw new Error('Unsupported deployment public key encoding');
  return utils.PublicKey.fromString(`ed25519:${bs58.encode(Uint8Array.from(raw.ed25519Key.data))}`);
}
function decodeUnsigned(bytes: Buffer): transactions.Transaction {
  const raw = transactions.Transaction.decode(bytes);
  return transactions.createTransaction(raw.signerId, decodedPublicKey(raw.publicKey), raw.receiverId, BigInt(raw.nonce), raw.actions, Uint8Array.from(raw.blockHash));
}
export function decodeDeploymentSignedTransaction(bytes: Buffer) {
  const raw = transactions.SignedTransaction.decode(bytes);
  const signature = raw.signature?.ed25519Signature?.data;
  if (!signature || signature.length !== 64) throw new Error('Unsupported deployment signature encoding');
  return { transaction: transactions.createTransaction(raw.transaction.signerId, decodedPublicKey(raw.transaction.publicKey), raw.transaction.receiverId, BigInt(raw.transaction.nonce), raw.transaction.actions, Uint8Array.from(raw.transaction.blockHash)), signature: Uint8Array.from(signature) };
}
function transactionHash(transaction: transactions.Transaction) { return bs58.encode(createHash('sha256').update(transaction.encode()).digest()); }
function validateIntent(context: Context, a: AttemptValue) {
  const bytes = Buffer.from(a.unsignedTransaction, 'base64'), tx = decodeUnsigned(bytes), p = context.plan;
  if (!Buffer.from(tx.encode()).equals(bytes) || tx.signerId !== p.policy.registry || tx.publicKey.toString() !== p.publicKey || tx.nonce <= 0n || tx.blockHash.length !== 32 || transactionHash(tx) !== a.hash) throw new Error('Deployment journal transaction binding mismatch');
  let deposit = '0';
  if (a.phase.startsWith('register-')) {
    deposit = tx.actions[0]?.functionCall?.deposit.toString() ?? '0';
    if (BigInt(deposit) <= 0n || BigInt(deposit) > BigInt(p.maxRegistrationYoctoNear)) throw new Error('Deployment journal registration limit mismatch');
  }
  const check = { registration: [{ account: a.phase === 'register-registry' ? p.policy.registry : p.policy.feeRecipient, required: true, deposit }] } as Awaited<ReturnType<typeof deploymentPreflight>>;
  const set = actionSet(context, a.phase, check);
  if (!set || !Buffer.from(transactions.createTransaction(tx.signerId, tx.publicKey, set.receiver, tx.nonce, set.actions, tx.blockHash).encode()).equals(bytes)) throw new Error('Deployment journal actions differ from the reviewed plan');
}
function withJournal<T>(context: Context, file: string, planSha256: string, fn: (journal: z.infer<typeof Journal>, save: () => void) => Promise<T>) {
  const path = resolve(file); mkdirSync(dirname(path), { recursive: true });
  const lock = path + '.lock', fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const save = (journal: z.infer<typeof Journal>) => {
    const temp = path + '.' + randomUUID() + '.tmp';
    const bytes = json(Journal.parse(journal));
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new Error('Deployment journal exceeds size limit');
    try {
      const writer = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(writer, bytes); fsyncSync(writer); } finally { closeSync(writer); }
      renameSync(temp, path); const parent = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  };
  return (async () => {
    try {
      const journal = existsSync(path) ? Journal.parse(JSON.parse(boundedFile(path, 32 * 1024 * 1024).toString())) : Journal.parse({ format: 'core-deployment-journal-v1', planSha256, attempts: [] });
      if (journal.planSha256 !== planSha256) throw new Error('Deployment journal belongs to another plan');
      for (const a of journal.attempts) validateIntent(context, a);
      return await fn(journal, () => save(journal));
    } finally { closeSync(fd); unlinkSync(lock); }
  })();
}
function finalizedResult(raw: unknown, attempt: AttemptValue, p: Plan): 'pending' | 'complete' | 'failed' {
  if (!raw || typeof raw !== 'object') return 'pending';
  const r = raw as any;
  if (r.final_execution_status !== 'FINAL') return 'pending';
  const expected = decodeUnsigned(Buffer.from(attempt.unsignedTransaction, 'base64'));
  if (r.transaction?.hash !== attempt.hash || r.transaction.signer_id !== p.policy.registry || r.transaction.receiver_id !== expected.receiverId || r.transaction.public_key !== p.publicKey || BigInt(Count.parse(r.transaction.nonce)) !== expected.nonce || (r.transaction.block_hash !== undefined && r.transaction.block_hash !== bs58.encode(expected.blockHash))) throw new Error('Finalized transaction differs from deployment intent');
  // SignedTransactionView omits block_hash. Verify its signature against our exact unsigned bytes/hash.
  const signature = r.transaction.signature;
  let validSignature = false;
  try {
    if (typeof signature === 'string' && signature.startsWith('ed25519:')) {
      const bytes = bs58.decode(signature.slice(8));
      validSignature = bytes.length === 64 && bs58.encode(bytes) === signature.slice(8) && expected.publicKey.verify(createHash('sha256').update(expected.encode()).digest(), bytes);
    }
  } catch {}
  if (!validSignature) throw new Error('Finalized deployment signature differs from the original intent');
  const observed = r.transaction.actions;
  if (!Array.isArray(observed) || observed.length !== expected.actions.length) throw new Error('Finalized deployment actions differ');
  expected.actions.forEach((action: transactions.Action, i: number) => {
    const actual = observed[i];
    if (action.deployContract) {
      // NEAR ActionView exposes base64(SHA256(code)), not the original WASM bytes.
      if (Object.keys(actual).join() !== 'DeployContract' || actual.DeployContract.code !== createHash('sha256').update(Buffer.from(action.deployContract.code)).digest('base64')) throw new Error('Finalized deploy code differs');
    } else if (action.functionCall) {
      const c = z.object({ method_name: z.string(), args: z.string(), gas: Count, deposit: Atomic }).strict().parse(actual.FunctionCall);
      if (Object.keys(actual).join() !== 'FunctionCall' || c.method_name !== action.functionCall.methodName || c.args !== Buffer.from(action.functionCall.args).toString('base64') || BigInt(c.gas) !== action.functionCall.gas || c.deposit !== action.functionCall.deposit.toString()) throw new Error('Finalized deployment call differs');
    } else if (action.deleteKey) {
      if (Object.keys(actual).join() !== 'DeleteKey' || actual.DeleteKey.public_key !== p.publicKey) throw new Error('Finalized key removal differs');
    } else throw new Error('Unexpected deployment action');
  });
  const failed = (s: unknown) => !!s && typeof s === 'object' && Object.hasOwn(s, 'Failure');
  if (failed(r.status) || failed(r.transaction_outcome?.outcome?.status) || (Array.isArray(r.receipts_outcome) && r.receipts_outcome.some((x: any) => failed(x.outcome?.status)))) return 'failed';
  const succeeded = (s: any) => typeof s?.SuccessValue === 'string' || typeof s?.SuccessReceiptId === 'string';
  if (typeof r.status?.SuccessValue !== 'string' || !succeeded(r.transaction_outcome?.outcome?.status) || !Array.isArray(r.receipts_outcome) || r.receipts_outcome.length === 0 || r.receipts_outcome.some((x: any) => !succeeded(x.outcome?.status))) throw new Error('Incomplete finalized deployment outcome');
  return 'complete';
}
export type DeploymentSigner = (transaction: transactions.Transaction) => Promise<transactions.SignedTransaction>;
export function deploymentKeyFile(file: string, plan: Plan): DeploymentSigner {
  // Local one-shot deployer only. Never expose this adapter through the read-only API.
  try {
    const stat = lstatSync(file);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const key = z.object({ account_id: z.literal(plan.policy.registry), public_key: z.literal(plan.publicKey), private_key: z.string() }).strict().parse(JSON.parse(boundedFile(file, 8192).toString()));
    const pair = KeyPair.fromString(key.private_key as `ed25519:${string}`);
    if (pair.getPublicKey().toString() !== plan.publicKey) throw new Error();
    return async tx => {
      const signer = await InMemorySigner.fromKeyPair('testnet', plan.policy.registry, pair);
      return (await transactions.signTransaction(tx, signer, plan.policy.registry, 'testnet'))[1];
    };
  } catch { throw new Error('Invalid deployment key file: require owner-only permissions and matching account/public key'); }
}
export async function executeDeployment(context: Context, source: DeploymentSource, phase: DeploymentPhase, journalFile: string, planSha256: string, signer: DeploymentSigner, options: { acknowledgeKeyRemoval?: boolean; retryFinalFailure?: boolean } = {}) {
  Phase.parse(phase);
  context = { ...context, plan: structuredClone(context.plan), wasm: Buffer.from(context.wasm) };
  if (phase === 'seal' && !options.acknowledgeKeyRemoval) throw new Error('Explicit irreversible key-removal acknowledgement is required');
  return withJournal(context, journalFile, planSha256, async (journal, save) => {
    if (journal.attempts.some(a => a.state === 'intent' || a.state === 'submitted')) throw new Error('Unresolved deployment intent: reconcile the original hash before signing again');
    const previous = journal.attempts.filter(a => a.phase === phase).at(-1);
    if (previous?.state === 'complete') {
      const check = await deploymentPreflight(context, source, phase === 'seal' ? 'verify' : 'initialized');
      if (phase.startsWith('register-') && check.registration.some(r => r.account === (phase === 'register-registry' ? context.plan.policy.registry : context.plan.policy.feeRecipient) && r.required)) throw new Error('Previously registered account is no longer registered');
      return { phase, state: 'already_complete', hash: previous.hash };
    }
    if (previous?.state === 'failed' && !options.retryFinalFailure) throw new Error('Explicit retry of the verified final failure is required');
    if (journal.attempts.length >= 16) throw new Error('Deployment attempt limit reached');
    const check = await deploymentPreflight(context, source, phase), set = actionSet(context, phase, check);
    if (!set) return { phase, state: 'already_registered' };
    const key = check.keys.find(k => k.public_key === context.plan.publicKey)!;
    if (key.access_key.nonce >= Number.MAX_SAFE_INTEGER) throw new Error('Deployment nonce exceeds supported RPC integer precision');
    const tx = transactions.createTransaction(context.plan.policy.registry, utils.PublicKey.fromString(context.plan.publicKey), set.receiver, BigInt(key.access_key.nonce) + 1n, set.actions, bs58.decode(check.checkedAtBlock.hash));
    const unsigned = Buffer.from(tx.encode());
    const attempt: AttemptValue = { phase, unsignedTransaction: unsigned.toString('base64'), hash: transactionHash(tx), state: 'intent' };
    journal.attempts.push(attempt); save(); // Durable, public intent before signer or network side effects.
    const signedBytes = Buffer.from((await signer(decodeUnsigned(unsigned))).encode());
    const signed = decodeDeploymentSignedTransaction(signedBytes);
    if (!Buffer.from(signed.transaction.encode()).equals(unsigned) || !tx.publicKey.verify(createHash('sha256').update(unsigned).digest(), signed.signature)) throw new Error('Signer changed deployment transaction or signature');
    // A wallet/file signer may have been open for a while: recheck the live stage before dispatch.
    await deploymentPreflight(context, source, phase);
    attempt.state = 'submitted'; save();
    let result: unknown;
    try { result = await source.submit(signedBytes.toString('base64')); }
    catch { throw new Error(`Deployment broadcast outcome is uncertain; reconcile ${attempt.hash} before signing again`); }
    const state = finalizedResult(result, attempt, context.plan);
    if (state !== 'pending') { attempt.state = state; save(); }
    if (state !== 'complete') return { phase, state, hash: attempt.hash };
    await deploymentPreflight(context, source, phase === 'seal' ? 'verify' : 'initialized');
    return { phase, state, hash: attempt.hash };
  });
}
export async function reconcileDeployment(context: Context, source: DeploymentSource, journalFile: string, planSha256: string) {
  const chain = await source.chain();
  freshTestnet(chain);
  if (source.network !== 'testnet' || source.factory !== context.plan.policy.registry) throw new Error('Wrong reconciliation network/source');
  return withJournal(context, journalFile, planSha256, async (journal, save) => {
    for (const attempt of journal.attempts.filter(a => a.state === 'intent' || a.state === 'submitted')) {
      const state = finalizedResult(await source.transaction(attempt.hash, context.plan.policy.registry), attempt, context.plan);
      if (state !== 'pending') { attempt.state = state; save(); }
    }
    return { attempts: journal.attempts.map(({ phase, hash, state }) => ({ phase, hash, state })), automaticResubmit: false };
  });
}

/** Explicitly recover a pre-dispatch intent; never creates a new transaction or nonce. */
export async function resumeDeploymentIntent(context: Context, source: DeploymentSource, phase: DeploymentPhase, journalFile: string, planSha256: string, signer: DeploymentSigner, options: { acknowledgeExactIntent?: boolean; acknowledgeKeyRemoval?: boolean } = {}) {
  Phase.parse(phase);
  if (!options.acknowledgeExactIntent) throw new Error('Explicit acknowledgement of the exact original intent is required');
  if (phase === 'seal' && !options.acknowledgeKeyRemoval) throw new Error('Explicit irreversible key-removal acknowledgement is required');
  context = { ...context, plan: structuredClone(context.plan), wasm: Buffer.from(context.wasm) };
  return withJournal(context, journalFile, planSha256, async (journal, save) => {
    const pending = journal.attempts.filter(a => a.state === 'intent' || a.state === 'submitted');
    if (pending.length !== 1 || pending[0].phase !== phase || pending[0].state !== 'intent') throw new Error('Resume only one exact pre-dispatch intent; submitted uncertainty requires read-only reconciliation');
    const attempt = pending[0], chain = await source.chain();
    freshTestnet(chain);
    if (source.network !== 'testnet' || source.factory !== context.plan.policy.registry) throw new Error('Wrong resume network/source');
    const observed = finalizedResult(await source.transaction(attempt.hash, context.plan.policy.registry), attempt, context.plan);
    if (observed !== 'pending') { attempt.state = observed; save(); return { phase, state: observed, hash: attempt.hash, resumedExactIntent: false }; }
    const unsigned = Buffer.from(attempt.unsignedTransaction, 'base64'), tx = decodeUnsigned(unsigned);
    const nonceMatches = (check: Awaited<ReturnType<typeof deploymentPreflight>>) => {
      const key = check.keys.find(k => k.public_key === context.plan.publicKey)!;
      if (!Number.isSafeInteger(key.access_key.nonce) || BigInt(key.access_key.nonce) + 1n !== tx.nonce) throw new Error('Original intent nonce is no longer next; reconcile instead');
    };
    nonceMatches(await deploymentPreflight(context, source, phase));
    const signedBytes = Buffer.from((await signer(decodeUnsigned(unsigned))).encode()), signed = decodeDeploymentSignedTransaction(signedBytes);
    if (!Buffer.from(signed.transaction.encode()).equals(unsigned) || transactionHash(signed.transaction) !== attempt.hash || !tx.publicKey.verify(createHash('sha256').update(unsigned).digest(), signed.signature)) throw new Error('Signer changed the exact original intent');
    nonceMatches(await deploymentPreflight(context, source, phase));
    attempt.state = 'submitted'; save();
    let result: unknown;
    try { result = await source.submit(signedBytes.toString('base64')); }
    catch { throw new Error(`Original intent outcome is uncertain; reconcile ${attempt.hash} without resubmission`); }
    const state = finalizedResult(result, attempt, context.plan);
    if (state !== 'pending') { attempt.state = state; save(); }
    if (state === 'complete') await deploymentPreflight(context, source, phase === 'seal' ? 'verify' : 'initialized');
    return { phase, state, hash: attempt.hash, resumedExactIntent: true };
  });
}
