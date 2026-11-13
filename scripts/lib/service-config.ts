import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SharedPolicySchema } from '../../sdk/shared.js';
import { NearRpcOperationsSource } from '../../sdk/operations.js';
import { serverSettings } from '../../server/settings.js';

export class ServiceError extends Error { constructor(readonly code: string) { super(code); } }
const number = (v: string | undefined, fallback: number, min: number, max: number) => {
  if (v !== undefined) z.string().regex(/^(0|[1-9]\d*)$/).parse(v);
  return z.coerce.number().int().min(min).max(max).parse(v ?? fallback);
};
export function loadServiceConfig(env: NodeJS.ProcessEnv) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw new ServiceError('SERVICE_REQUIRES_NODE_22_16');
  for (const key of ['CORE_DEPLOY_KEY_FILE', 'CORE_NOTE_PASSWORD', 'CORE_RECEIPT_PASSWORD']) if (env[key]) throw new ServiceError('SIGNING_SECRETS_FORBIDDEN_IN_HOSTED_SERVICE');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new ServiceError('TLS_VERIFICATION_MUST_STAY_ENABLED');
  if (env.CORE_DISCOVERY_START_HEIGHT !== undefined) z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().nonnegative().safe()).parse(env.CORE_DISCOVERY_START_HEIGHT);
  if (!/^[a-f0-9]{64}$/.test(env.CORE_POLICY_SHA256 ?? '')) throw new ServiceError('SERVICE_POLICY_PIN_REQUIRED');
  if (!!env.CORE_POLICY_FILE === !!env.CORE_POLICY_JSON) throw new ServiceError('SET_EXACTLY_ONE_POLICY_SOURCE');
  let bytes: Buffer;
  if (env.CORE_POLICY_JSON) bytes = Buffer.from(env.CORE_POLICY_JSON);
  else {
    const info = lstatSync(env.CORE_POLICY_FILE!);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16000) throw new ServiceError('INVALID_SERVICE_POLICY_FILE');
    bytes = readFileSync(env.CORE_POLICY_FILE!);
  }
  if (bytes.length > 16000 || createHash('sha256').update(bytes).digest('hex') !== env.CORE_POLICY_SHA256) throw new ServiceError('SERVICE_POLICY_DIGEST_MISMATCH');
  const policy = SharedPolicySchema.parse(JSON.parse(bytes.toString()));
  const mode = z.enum(['testnet', 'sandbox']).parse(env.CORE_SERVICE_NETWORK ?? 'testnet');
  const host = env.CORE_API_HOST ?? '0.0.0.0', port = number(env.PORT, 3001, 1024, 65535);
  if (!['0.0.0.0', '127.0.0.1'].includes(host) || policy.network !== mode || (mode === 'sandbox' && host !== '127.0.0.1')) throw new ServiceError('INVALID_SERVICE_NETWORK_BINDING');
  let rpc: URL;
  try { rpc = new URL(env.CORE_RPC_URL!); } catch { throw new ServiceError('SERVICE_RPC_REQUIRED'); }
  if (rpc.username || rpc.password || rpc.search || rpc.hash || (rpc.protocol !== 'https:' && !(mode === 'sandbox' && rpc.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(rpc.hostname)))) throw new ServiceError('INVALID_SERVICE_RPC');
  const origins = (env.CORE_ALLOWED_ORIGINS ?? '').split(',');
  if (!origins.length || origins.some(origin => { try { const u = new URL(origin); return origin !== u.origin || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))); } catch { return true; } })) throw new ServiceError('SERVICE_EXACT_CORS_ORIGINS_REQUIRED');
  if (env.CORE_API_REQUIRE_INDEX !== undefined && env.CORE_API_REQUIRE_INDEX !== 'true') throw new ServiceError('HOSTED_API_REQUIRES_INDEX');
  const dataDir = resolve(env.CORE_DATA_DIR ?? 'data/service'), db = resolve(dataDir, 'activity.sqlite');
  if (env.CORE_INDEX_DB && resolve(env.CORE_INDEX_DB) !== db) throw new ServiceError('SERVICE_DATABASE_MUST_USE_DATA_DIRECTORY');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) throw new ServiceError('INVALID_SERVICE_DATA_DIRECTORY');
  const policyFile = resolve(dataDir, `policy-${env.CORE_POLICY_SHA256}.json`);
  if (!existsSync(policyFile)) writeFileSync(policyFile, bytes, { mode: 0o600, flag: 'wx' });
  const snapshot = lstatSync(policyFile);
  if (!snapshot.isFile() || snapshot.isSymbolicLink() || createHash('sha256').update(readFileSync(policyFile)).digest('hex') !== env.CORE_POLICY_SHA256) throw new ServiceError('SERVICE_POLICY_SNAPSHOT_MISMATCH');
  const childEnv: NodeJS.ProcessEnv = { ...env, CORE_POLICY_FILE: policyFile, CORE_INDEX_DB: db, CORE_API_REQUIRE_INDEX: 'true', CORE_API_HOST: host, PORT: String(port), CORE_ALLOWED_ORIGINS: origins.join(',') };
  delete childEnv.CORE_POLICY_JSON;
  serverSettings(childEnv);
  const bootstrapMs = number(env.CORE_SERVICE_BOOTSTRAP_MS, 120000, 1000, 900000);
  const shutdownMs = number(env.CORE_SERVICE_SHUTDOWN_MS, 10000, 1000, 25000);
  const backupMs = number(env.CORE_BACKUP_INTERVAL_MS, 21600000, 0, 604800000);
  if (backupMs > 0 && backupMs < 60000) throw new ServiceError('BACKUP_INTERVAL_TOO_SHORT');
  const backupKeep = number(env.CORE_BACKUP_KEEP, 7, 1, 90);
  return { policy, policyFile, dataDir, db, host, port, mode, childEnv, bootstrapMs, shutdownMs, backupMs, backupKeep };
}
export type ServiceConfig = ReturnType<typeof loadServiceConfig>;
class RuntimeSource extends NearRpcOperationsSource {
  status() { return this.rpc('status', []); }
}
export async function checkServiceNetwork(config: ServiceConfig, signal?: AbortSignal) {
  const source = new RuntimeSource(config.policy.network, config.policy.registry, config.childEnv.CORE_RPC_URL!, signal);
  const status = z.object({ chain_id: z.string(), sync_info: z.object({ syncing: z.boolean(), latest_block_time: z.string().datetime() }) }).parse(await source.status());
  const age = Date.now() - Date.parse(status.sync_info.latest_block_time);
  if (status.sync_info.syncing || age > 120000 || age < -30000 || (config.mode === 'testnet' ? status.chain_id !== 'testnet' : ['mainnet', 'testnet'].includes(status.chain_id))) throw new ServiceError('SERVICE_RPC_NETWORK_OR_FRESHNESS_MISMATCH');
}
