import{lstatSync,readFileSync,mkdirSync}from'node:fs';
import{dirname,resolve}from'node:path';
import{KeyPair}from'near-api-js';
import{z}from'zod';
import{SharedPolicySchema}from'../sdk/shared.js';
import{shutdownProver,sha256}from'../sdk/core.js';
import{RelayLimits,pinnedRelayVerifier,relayPolicyHash}from'../server/relay/protocol.js';
import{RelayStore}from'../server/relay/store.js';
import{NearRelaySigner,RelayRpcSource}from'../server/relay/signer.js';
import{ProofRelay}from'../server/relay/service.js';
import{createRelayApi}from'../server/relay/http.js';
import{startRelayWorker}from'../server/relay/worker.js';
function file(path:string,limit:number,secret=false){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>limit||(secret&&((st.mode&0o077)||st.uid!==(process.getuid?.()??st.uid))))throw Error('RELAY_FILE_REJECTED');return readFileSync(path);}
const Config=z.object({format:z.literal('core-proof-relay-config-v1'),policyFile:z.string(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),verificationKeyFile:z.string(),sponsorKeyFile:z.string(),journalFile:z.string(),rpcUrl:z.string().max(1024),host:z.literal('127.0.0.1').default('127.0.0.1'),port:z.number().int().min(1).max(65535).default(3003),allowedOrigins:z.array(z.string()).max(20).default([]),limits:RelayLimits}).strict();
const [configFile,...extra]=process.argv.slice(2);
let store:RelayStore|undefined;
try{
 if(!configFile||extra.length)throw Error('RELAY_CONFIGURATION_REQUIRED');
 const c=Config.parse(JSON.parse(file(configFile,16384).toString())),base=dirname(resolve(configFile)),path=(s:string)=>resolve(base,s);
 const bytes=file(path(c.policyFile),16384);if(sha256(bytes)!==c.policySha256)throw Error('RELAY_POLICY_DIGEST_MISMATCH');const policy=SharedPolicySchema.parse(JSON.parse(bytes.toString()));
 const url=new URL(c.rpcUrl);if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(policy.network==='sandbox'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw Error('RELAY_RPC_REJECTED');
 for(const origin of c.allowedOrigins){const u=new URL(origin);if(u.origin!==origin||!['https:','http:'].includes(u.protocol)||(u.protocol==='http:'&&!['127.0.0.1','localhost'].includes(u.hostname)))throw Error('RELAY_ORIGIN_REJECTED');}
 const key=z.object({account_id:z.string(),public_key:z.string(),private_key:z.string()}).strict().parse(JSON.parse(file(path(c.sponsorKeyFile),4096,true).toString())),pair=KeyPair.fromString(key.private_key);if(pair.getPublicKey().toString()!==key.public_key)throw Error('RELAY_KEY_MISMATCH');
 const source=new RelayRpcSource(policy.network,policy.registry,c.rpcUrl),signer=new NearRelaySigner(key.account_id,pair,policy,source,c.limits.maxGasPriceYoctoNear);await signer.fresh();
 const verify=pinnedRelayVerifier(policy,JSON.parse(file(path(c.verificationKeyFile),16384).toString())),journal=path(c.journalFile);mkdirSync(dirname(journal),{recursive:true,mode:0o700});
 store=new RelayStore(journal,{policyHash:relayPolicyHash(policy),sponsor:signer.accountId,publicKey:signer.publicKey},c.limits);
 const relay=new ProofRelay(policy,source,signer,store,verify),server=createRelayApi(relay,c.allowedOrigins);
 await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(c.port,c.host,yes);});
 const stopWorker=startRelayWorker(relay);
 console.log(JSON.stringify({service:'core-proof-relay',host:c.host,port:c.port,network:policy.network,sponsor:signer.accountId,policyHash:relayPolicyHash(policy)}));
 let stopping=false;const close=()=>{if(stopping)return;stopping=true;const stopped=stopWorker();server.close(()=>{void stopped.then(()=>{store?.close();return shutdownProver();}).then(()=>process.exit(0));});server.closeIdleConnections();};process.on('SIGINT',close);process.on('SIGTERM',close);
}catch{store?.close();await shutdownProver();console.error('Relay startup failed. Check pinned policy/verifier, protected dedicated sponsor key, journal and configured test network. No user signing key is accepted.');process.exitCode=1;}
