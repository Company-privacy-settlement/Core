import { resolve } from 'node:path';
import { loadServiceConfig } from './lib/service-config.js';
import { backupIndex, restoreIndex } from './lib/index-backup.js';
const [mode, ...args] = process.argv.slice(2);
try {
  const config = loadServiceConfig(process.env);
  if (mode === 'backup' && args.length === 1) console.log(JSON.stringify(await backupIndex(config.db, resolve(args[0]), config.policy), null, 2));
  else if (mode === 'restore' && args.length === 2) console.log(JSON.stringify(await restoreIndex(resolve(args[0]), args[1], config.db, config.policy), null, 2));
  else throw new Error('Usage: index:backup -- <new-backup.sqlite> OR index:restore -- <backup.sqlite> <independently-trusted-sha256>');
} catch { console.error('Index maintenance failed: verify configuration, policy pin, digest and empty restore destination'); process.exitCode = 1; }
