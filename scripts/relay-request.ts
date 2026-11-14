import{createHash}from'node:crypto';
import{readFileSync,lstatSync,openSync,writeFileSync,fsyncSync,closeSync}from'node:fs';
import{z}from'zod';
import{SharedPolicySchema}from'../sdk/shared.js';
import{RelayRequest,parseRelayRequest,relayPolicyHash,relayRequestId}from'../server/relay/protocol.js';
const[policyFile,policyDigest,argsFile,output,...extra]=process.argv.slice(2);let fd:number|undefined;
function file(path:string){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>16384)throw Error('RELAY_INPUT_REJECTED');return readFileSync(path);}
try{
 if(!policyFile||!policyDigest||!argsFile||!output||extra.length||!/^[a-f0-9]{64}$/.test(policyDigest))throw Error('RELAY_USAGE');
 const bytes=file(policyFile);if(createHash('sha256').update(bytes).digest('hex')!==policyDigest)throw Error('RELAY_POLICY_MISMATCH');const policy=SharedPolicySchema.parse(JSON.parse(bytes.toString()));
 const a=z.object({vault:RelayRequest.shape.vault,recipient:RelayRequest.shape.recipient,disclosure_root:RelayRequest.shape.disclosureRoot,proof:RelayRequest.shape.spend.shape.proof,public_inputs:RelayRequest.shape.spend.shape.public_inputs}).strict().parse(JSON.parse(file(argsFile).toString()));
 const r=parseRelayRequest(policy,{format:'core-relay-withdrawal-v1',policyHash:relayPolicyHash(policy),vault:a.vault,recipient:a.recipient,disclosureRoot:a.disclosure_root,spend:{proof:a.proof,public_inputs:a.public_inputs}});
 fd=openSync(output,'wx',0o600);writeFileSync(fd,JSON.stringify(r,null,2)+'\n');fsyncSync(fd);console.log(JSON.stringify({requestId:relayRequestId(r),output,principal:policy.denomination,assetTokenId:policy.tokenId??null}));
}catch{console.error('Relay request preparation failed. Use the independently pinned policy, public withdrawal arguments and a new output path; no note secrets or signing keys are accepted.');process.exitCode=1;}finally{if(fd!==undefined)closeSync(fd);}
