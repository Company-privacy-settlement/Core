import {createHash} from 'node:crypto';
import {closeSync,openSync,writeFileSync,fsyncSync,ftruncateSync,writeSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadPublicWalletEvidence} from './lib/testnet-wallet-verification.js';
import {collectNativePrivacyObservations} from './lib/privacy-wallet-observations.js';
import {measurePrivacy} from './lib/privacy-baseline.js';
const [file,digest,datasetFile,reportFile,...extra]=process.argv.slice(2);
const opened:number[]=[];
try{
 if(!file||!digest||!datasetFile||!reportFile||extra.length||new Set([file,datasetFile,reportFile].map(p=>resolve(p))).size!==3)throw Error('Usage');
 const evidence=loadPublicWalletEvidence(file,digest);
 // Reserve both outputs before public reads. Failed attempts keep explicit non-success reports.
 const dataFd=openSync(datasetFile,'wx',0o600);opened.push(dataFd);
 const reportFd=openSync(reportFile,'wx',0o600);opened.push(reportFd);
 const {dataset,verification}=await collectNativePrivacyObservations(evidence);
 const bytes=Buffer.from(JSON.stringify(dataset,null,2)+'\n'),observationFileSha256=createHash('sha256').update(bytes).digest('hex');
 const report={...measurePrivacy(dataset),observationFileSha256,chainVerification:{...verification,evidenceSha256:digest}};
 writeFileSync(dataFd,bytes);fsyncSync(dataFd);writeFileSync(reportFd,JSON.stringify(report,null,2)+'\n');fsyncSync(reportFd);
 console.log(JSON.stringify({dataset:datasetFile,report:reportFile,observationFileSha256,records:dataset.records.length,depositSigners:report.participation.observedDepositSignerCount,effectiveAnonymityEstablished:false}));
}catch{
 for(const fd of opened){const bytes=Buffer.from(JSON.stringify({format:'core-privacy-collection-failure-v1',collected:false,error:'PUBLIC_EVIDENCE_OR_CHAIN_COLLECTION_FAILED',effectiveAnonymityEstablished:false})+'\n');ftruncateSync(fd,0);writeSync(fd,bytes,0,bytes.length,0);fsyncSync(fd);}
 console.error('Privacy collection failed; no measured or verified privacy result is claimed. Reconcile the inputs/RPC and use new output paths.');process.exitCode=1;
}finally{for(const fd of opened)closeSync(fd);}
