import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['dist/service/scripts/organization-maintenance.js', ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('Organization maintenance launcher failed; run build:service first'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
