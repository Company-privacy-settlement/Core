import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type ServiceCommand = { file: string; args: string[] };
function start(command: ServiceCommand, env: NodeJS.ProcessEnv) {
  const child = spawn(command.file, command.args, { env, stdio: 'inherit' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}
async function stop(child: ChildProcess, exited: Promise<unknown>, graceMs: number) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([exited.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), graceMs); })]);
  clearTimeout(timer);
  if (!done) { child.kill('SIGKILL'); await exited; }
}
export async function runBootstrap(command: ServiceCommand, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted(); const { child, exited } = start(command, env);
  const controller = new AbortController(), onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([exited, delay(timeoutMs, null, { signal: controller.signal }).then(() => null).catch(() => null)]);
    if (!result || signal.aborted) { await stop(child, exited, 5000); throw new Error('SERVICE_BOOTSTRAP_TIMEOUT_OR_STOP'); }
    if (result.code !== 0) throw new Error('SERVICE_BOOTSTRAP_FAILED');
  } finally { controller.abort(); signal.removeEventListener('abort', onAbort); }
}
export async function superviseService(commands: { api: ServiceCommand; indexer: ServiceCommand }, env: NodeJS.ProcessEnv, signal: AbortSignal, graceMs: number) {
  signal.throwIfAborted();
  const indexer = start(commands.indexer, env), api = start(commands.api, env);
  let onAbort!: () => void;
  const aborted = new Promise<'stop'>(resolve => { onAbort = () => resolve('stop'); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try {
    const reason = await Promise.race([aborted, indexer.exited.then(() => 'indexer' as const), api.exited.then(() => 'api' as const)]);
    // Stop accepting requests before ending the sole writer. Unexpected exit is fatal, including code 0.
    await stop(api.child, api.exited, graceMs); await stop(indexer.child, indexer.exited, graceMs);
    if (reason !== 'stop') throw new Error(`SERVICE_${reason.toUpperCase()}_EXITED`);
  } finally { signal.removeEventListener('abort', onAbort); }
}
