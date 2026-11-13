import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { IndexStore } from '../sdk/indexer/store.js';
import { checkServiceNetwork, loadServiceConfig, ServiceError } from './lib/service-config.js';
import { runBootstrap, superviseService } from './lib/service-processes.js';
import { rotateBackup } from './lib/index-backup.js';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
let timer: ReturnType<typeof setInterval> | undefined, pendingBackup: Promise<unknown> | undefined;
try {
  const config = loadServiceConfig(process.env);
  await checkServiceNetwork(config, controller.signal);
  const script = (name: string) => fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  const env = config.childEnv, deadline = Date.now() + config.bootstrapMs;
  do {
    await runBootstrap({ file: process.execPath, args: [script('indexer'), 'once'] }, env, controller.signal, Math.max(1, deadline - Date.now()));
    const store = new IndexStore(config.db, config.policy, true);
    let complete: boolean;
    try { const status = store.status() as { checkpoint: unknown; remainingRecords: number | null }; complete = !!status.checkpoint && status.remainingRecords === 0; } finally { store.close(); }
    if (complete) break;
    if (Date.now() >= deadline) throw new ServiceError('SERVICE_BOOTSTRAP_CATCHUP_TIMEOUT');
  } while (!controller.signal.aborted);
  controller.signal.throwIfAborted();
  if (config.backupMs > 0) {
    const backup = () => {
      if (pendingBackup || controller.signal.aborted) return;
      pendingBackup = rotateBackup(config.db, resolve(config.dataDir, 'backups'), config.policy, config.backupKeep)
        .then(result => console.log(JSON.stringify({ event: 'index_backup_created', bytes: result.bytes, sha256: result.sha256 })))
        .catch(() => console.error(JSON.stringify({ event: 'index_backup_failed', code: 'BACKUP_FAILED' })))
        .finally(() => { pendingBackup = undefined; });
    };
    backup(); timer = setInterval(backup, config.backupMs);
  }
  console.log(JSON.stringify({ event: 'core_service_started', mode: config.mode, indexRequired: true }));
  await superviseService({ api: { file: process.execPath, args: [script('server')] }, indexer: { file: process.execPath, args: [script('indexer'), 'watch'] } }, env, controller.signal, config.shutdownMs);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(JSON.stringify({ event: 'core_service_failed', code: error instanceof ServiceError ? error.code : error instanceof Error && /^SERVICE_[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_START_OR_RUNTIME_FAILED' }));
    process.exitCode = 1;
  }
} finally { clearInterval(timer); await pendingBackup; }
