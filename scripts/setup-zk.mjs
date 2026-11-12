import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const dir = 'artifacts';
mkdirSync(dir, { recursive: true });
if (existsSync(`${dir}/manifest.json`) && !process.argv.includes('--force')) {
  console.log('ZK artifacts already exist. Use npm run zk:setup -- --force to replace.');
  process.exit(0);
}
// Never leave an old successful manifest after a failed rebuild.
rmSync(`${dir}/manifest.json`, { force: true });
function run(binary, args) {
  console.log(`Running ${binary} ${args.slice(0, 3).join(' ')}…`);
  const r = spawnSync(`node_modules/.bin/${binary}`, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  // Some snarkjs CLI commands return status 0 even after logging an error.
  if (r.status !== 0 || /\[ERROR\]/.test(`${r.stdout}${r.stderr}`)) process.exit(r.status || 1);
}
run('circom2', ['circuits/spend.circom', '--O2', '--r1cs', '--wasm', '--sym', '-l', 'node_modules', '-o', dir]);
run('snarkjs', ['powersoftau', 'new', 'bn128', '12', `${dir}/pot0.ptau`]);
run('snarkjs', ['powersoftau', 'contribute', `${dir}/pot0.ptau`, `${dir}/pot1.ptau`, '--name=local-hackathon-only', `-e=${randomBytes(64).toString('hex')}`]);
run('snarkjs', ['powersoftau', 'prepare', 'phase2', `${dir}/pot1.ptau`, `${dir}/pot-final.ptau`]);
run('snarkjs', ['groth16', 'setup', `${dir}/spend.r1cs`, `${dir}/pot-final.ptau`, `${dir}/spend0.zkey`]);
run('snarkjs', ['zkey', 'contribute', `${dir}/spend0.zkey`, `${dir}/spend.zkey`, '--name=local-hackathon-only', `-e=${randomBytes(64).toString('hex')}`]);
run('snarkjs', ['zkey', 'export', 'verificationkey', `${dir}/spend.zkey`, `${dir}/verification_key.json`]);
run('snarkjs', ['zkey', 'verify', `${dir}/spend.r1cs`, `${dir}/pot-final.ptau`, `${dir}/spend.zkey`]);
const hashes = Object.fromEntries(['spend.r1cs', 'spend_js/spend.wasm', 'spend.zkey', 'verification_key.json'].map(f => [f, createHash('sha256').update(readFileSync(`${dir}/${f}`)).digest('hex')]));
writeFileSync(`${dir}/manifest.json`, JSON.stringify({ protocol: 'core-v1', depth: 8, setup: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', hashes }, null, 2));
console.log('Local development setup verified. New setup = new verifier = new pool. Never use with real funds.');
