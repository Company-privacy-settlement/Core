import { lstatSync, readFileSync } from 'node:fs';
import { buildDeploymentPlan, deploymentKeyFile, deploymentPreflight, executeDeployment, loadDeployment, NearRpcDeploymentSource, reconcileDeployment, resumeDeploymentIntent, saveDeploymentPlan, type DeploymentPhase } from './lib/deployment.js';

const [command, ...args] = process.argv.slice(2);
const output = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const phases = ['deploy', 'register-registry', 'register-treasury', 'seal'];
try {
  if (command === 'plan' && args.length === 4) {
    const [release, digest, config, target] = args, stat = lstatSync(config);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid deployment input file');
    output(saveDeploymentPlan(target, buildDeploymentPlan(release, digest, JSON.parse(readFileSync(config, 'utf8')))));
  } else if ((command === 'preflight' || command === 'verify') && args.length === (command === 'verify' ? 3 : 4)) {
    const [plan, digest, release, phase] = args;
    if (phase && !phases.includes(phase)) throw new Error('Unknown deployment phase');
    const context = loadDeployment(plan, digest, release), p = context.plan;
    output(await deploymentPreflight(context, new NearRpcDeploymentSource('testnet', p.policy.registry, p.rpcUrl), command === 'verify' ? 'verify' : phase as DeploymentPhase));
  } else if ((command === 'execute' || command === 'resume-intent' || command === 'reconcile') && args.length >= (command === 'reconcile' ? 4 : 5)) {
    const [plan, digest, release, journal, phase, ...flags] = args;
    if (command === 'reconcile' && args.length !== 4) throw new Error('Reconcile accepts no signing options');
    if (command !== 'reconcile' && (!phases.includes(phase) || new Set(flags).size !== flags.length || flags.some(f => !(command === 'resume-intent' ? ['--acknowledge-exact-original-intent', '--acknowledge-irreversible-key-removal'] : ['--acknowledge-irreversible-key-removal', '--retry-final-failure']).includes(f)))) throw new Error('Invalid deployment execution options');
    const context = loadDeployment(plan, digest, release), p = context.plan, source = new NearRpcDeploymentSource('testnet', p.policy.registry, p.rpcUrl);
    if (command === 'reconcile') output(await reconcileDeployment(context, source, journal, digest));
    else {
      const file = process.env.CORE_DEPLOY_KEY_FILE;
      if (!file) throw new Error('Set CORE_DEPLOY_KEY_FILE to an owner-only local deployer key file; never pass a private key as an argument');
      const result = command === 'resume-intent'
        ? await resumeDeploymentIntent(context, source, phase as DeploymentPhase, journal, digest, deploymentKeyFile(file, p), { acknowledgeExactIntent: flags.includes('--acknowledge-exact-original-intent'), acknowledgeKeyRemoval: flags.includes('--acknowledge-irreversible-key-removal') })
        : await executeDeployment(context, source, phase as DeploymentPhase, journal, digest, deploymentKeyFile(file, p), { acknowledgeKeyRemoval: flags.includes('--acknowledge-irreversible-key-removal'), retryFinalFailure: flags.includes('--retry-final-failure') });
      output(result);
      if (['pending', 'failed'].includes(result.state)) process.exitCode = 2;
    }
  } else throw new Error('Usage: deploy:plan -- <release-dir> <release-sha256> <input.json> <new-plan.json>; deploy:preflight -- <plan> <plan-sha256> <release-dir> <phase>; deploy:execute -- <plan> <plan-sha256> <release-dir> <journal> <phase> [--acknowledge-irreversible-key-removal] [--retry-final-failure]; deploy:reconcile -- <plan> <plan-sha256> <release-dir> <journal>; deploy:verify -- <plan> <plan-sha256> <release-dir>');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment operation failed');
  process.exitCode = 1;
}
