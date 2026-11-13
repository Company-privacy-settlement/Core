import { prepareRelease, verifyRelease } from './lib/release.js';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare' && args.length === 2) {
    console.log(JSON.stringify(prepareRelease(args[0], args[1]), null, 2));
  } else if (command === 'verify' && args.length === 2) {
    const manifest = verifyRelease(args[0], args[1]);
    console.log(JSON.stringify({ verified: true, version: manifest.version, network: manifest.network,
      chainVerification: manifest.chainVerification, safety: manifest.safety }, null, 2));
  } else {
    throw new Error('Usage: release:prepare -- <config.json> <new-output-directory> OR release:verify -- <directory> <independently-obtained-manifest-sha256>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release operation failed');
  process.exitCode = 1;
}
