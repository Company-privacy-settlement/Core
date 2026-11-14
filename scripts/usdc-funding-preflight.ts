import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { inspectUsdcFunding, loadUsdcFundingInput } from './lib/usdc-funding-preflight.js';
const [input,output,...extra]=process.argv.slice(2);
if(!input||!output||extra.length){console.error('Usage: testnet:preflight-usdc INPUT_JSON NEW_REPORT_JSON');process.exitCode=1;}
else {let fd:number|undefined;try{
  const config=loadUsdcFundingInput(input);
  fd=openSync(output,'wx',0o600);
  const report=await inspectUsdcFunding(config);
  writeFileSync(fd,JSON.stringify(report,null,2)+'\n');fsyncSync(fd);
  console.log(JSON.stringify({fundingReady:report.fundingReady,blockers:report.blockers,report:output,usdcSettlementVerified:false}));
  if(!report.fundingReady)process.exitCode=2;
}catch{
  if(fd!==undefined){writeFileSync(fd,JSON.stringify({format:'core-usdc-funding-preflight-v1',fundingReady:false,error:'INPUT_OR_PUBLIC_CHAIN_VERIFICATION_FAILED',claims:{readOnly:true,browserWalletVerified:false,usdcSettlementVerified:false}})+'\n');fsyncSync(fd);}
  console.error('USDC funding preflight did not complete. Check the testnet input, public RPC and a new output path. No wallet execution is claimed.');process.exitCode=1;
}finally{if(fd!==undefined)closeSync(fd);}}
