import { runContractScript, syncProvingArtifacts } from './contract-artifacts.mjs';
runContractScript('zk:setup', process.argv.slice(2));
syncProvingArtifacts();
