import {openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {captureRuleSources,qualifyProviders} from './lib/provider-qualification.js';
const [command,...args]=process.argv.slice(2);let fd:number|undefined,outputStarted=false;
try{
 if(!((command==='sources'&&args.length===1)||(command==='check'&&args.length===2)))throw Error('QUALIFICATION_USAGE');
 // Reserve the output before any network request. Never overwrite prior evidence.
 fd=openSync(args.at(-1)!,'wx',0o600);
 const report=command==='sources'?await captureRuleSources():await qualifyProviders(args[0]);
 outputStarted=true;writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fsyncSync(fd);
 const passed=command==='sources'?(report as Awaited<ReturnType<typeof captureRuleSources>>).allPinnedSourcesMatched:(report as Awaited<ReturnType<typeof qualifyProviders>>).status==='passed';
 console.log(JSON.stringify({output:args.at(-1),status:passed?'passed':'blocked',productionQualified:false}));if(!passed)process.exitCode=2;
}catch{if(fd!==undefined&&!outputStarted){writeFileSync(fd,JSON.stringify({format:'core-provider-qualification-failure-v1',status:'failed',checkedAt:new Date().toISOString(),reason:'QUALIFICATION_INPUT_OR_EXECUTION_FAILED',productionQualified:false},null,2)+'\n');fsyncSync(fd);}console.error('Provider qualification could not run. Use a new output path and valid owner-only configuration; no credentials or identity records are printed.');process.exitCode=1;}finally{if(fd!==undefined)closeSync(fd);}
