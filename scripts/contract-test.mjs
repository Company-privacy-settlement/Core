import { runContractScript } from './contract-artifacts.mjs';
runContractScript(process.argv[2] || 'test');
