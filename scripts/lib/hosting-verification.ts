import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { SharedPolicySchema } from '../../sdk/shared.js';
import { canonical } from '../../sdk/client/crypto.js';
import { CheckpointSchema } from '../../sdk/indexer/types.js';

const Origin = z.string().refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !['localhost','127.0.0.1','[::1]'].includes(u.hostname); } catch { return false; }
}, 'Use an exact non-loopback HTTPS origin');
export const HostingVerificationConfig = z.object({
  apiOrigin: Origin, organizationOrigin: Origin, frontendOrigin: Origin,
  policyFile: z.string().min(1), policySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleDelayMs: z.number().int().min(2000).max(30000).default(3000),
  maxIndexAgeMs: z.number().int().min(1000).max(3600000).default(60000),
  maxIndexLagBlocks: z.number().int().min(0).max(10000).default(100),
}).strict().refine(v => v.apiOrigin !== v.organizationOrigin && ![v.apiOrigin,v.organizationOrigin].includes(v.frontendOrigin), 'Use separate API, organization and frontend origins');
export type HostingConfig = z.output<typeof HostingVerificationConfig>;
export type HostingCheck = { name: string; passed: boolean; status?: number; error?: string };
export type HostingReport = {
  format: 'core-hosting-verification-v1'; checkedAt: string; passed: boolean;
  targets: { apiOrigin: string; organizationOrigin: string; frontendOrigin: string };
  policySha256: string; checks: HostingCheck[];
  indexSamples: { height: number; hash: string; indexedRecords: number }[];
  claims: { tlsVerificationRequired: true; deploymentPolicyMatched: boolean; indexAdvancementObserved: boolean; restartPersistenceVerified: false; authenticatedBusinessWritesVerified: false };
};
function boundedFile(file: string, limit: number) {
  const stat=lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('Use a bounded regular configuration file');
  return readFileSync(file);
}
export function loadHostingVerification(file: string) {
  const path=resolve(file),config=HostingVerificationConfig.parse(JSON.parse(boundedFile(path,16384).toString('utf8')));
  return {...config,policyFile:resolve(dirname(path),config.policyFile)};
}
export async function verifyHosting(input: HostingConfig, transport: typeof fetch=fetch, wait: (ms:number)=>Promise<unknown>=delay): Promise<HostingReport> {
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('TLS verification must stay enabled');
  const config=HostingVerificationConfig.parse(input),bytes=boundedFile(config.policyFile,8192);
  if(createHash('sha256').update(bytes).digest('hex')!==config.policySha256)throw new Error('Deployment policy digest mismatch');
  const policy=SharedPolicySchema.parse(JSON.parse(bytes.toString('utf8')));
  if(policy.network!=='testnet')throw new Error('A verified testnet deployment policy is required');
  const report:HostingReport={format:'core-hosting-verification-v1',checkedAt:new Date().toISOString(),passed:false,
    targets:{apiOrigin:config.apiOrigin,organizationOrigin:config.organizationOrigin,frontendOrigin:config.frontendOrigin},policySha256:config.policySha256,checks:[],indexSamples:[],
    claims:{tlsVerificationRequired:true,deploymentPolicyMatched:false,indexAdvancementObserved:false,restartPersistenceVerified:false,authenticatedBusinessWritesVerified:false}};
  const demand=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
  async function probe(name:string,origin:string,path:string,expected:number,inspect:(body:any,response:Response)=>void=()=>{},init:RequestInit={}){
    const check:HostingCheck={name,passed:false};report.checks.push(check);let response:Response|undefined;
    try {
      const r=await transport(origin+path,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(12000)});response=r;check.status=r.status;
      demand(r.status===expected,'UNEXPECTED_STATUS');
      demand(r.headers.get('cache-control')?.includes('no-store'),'NO_STORE_REQUIRED');
      if(expected===204){inspect(null,r);check.passed=true;return;}
      demand(r.body&&r.headers.get('content-type')?.includes('application/json'),'JSON_REQUIRED');
      const reader=r.body!.getReader(),parts:Uint8Array[]=[];let total=0;
      try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;demand(total<=131072,'RESPONSE_TOO_LARGE');parts.push(next.value);}}finally{await reader.cancel();reader.releaseLock();}
      inspect(JSON.parse(Buffer.concat(parts).toString('utf8')),r);check.passed=true;
    } catch(error) {check.error=error instanceof Error&&/^[A-Z_]{1,64}$/.test(error.message)?error.message:'CHECK_FAILED';} finally {if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
  }
  const cors={origin:config.frontendOrigin},denied='https://core-deployment-denied.invalid';
  demand(![config.frontendOrigin,config.apiOrigin,config.organizationOrigin].includes(denied),'Use real deployment domains');
  await probe('settlement_liveness',config.apiOrigin,'/healthz',200,b=>demand(b.service==='core'&&b.readOnly===true&&b.network==='testnet'&&b.registry===policy.registry,'WRONG_SERVICE'));
  await probe('settlement_policy_and_cors',config.apiOrigin,'/v1/config',200,(b,r)=>{
    demand(canonical(SharedPolicySchema.parse(b.policy))===canonical(policy)&&b.readOnly===true&&b.signing==='client-wallet'&&b.secretsAccepted===false,'POLICY_MISMATCH');
    demand(r.headers.get('access-control-allow-origin')===config.frontendOrigin,'CORS_MISMATCH');report.claims.deploymentPolicyMatched=true;
  },{headers:cors});
  await probe('settlement_readiness',config.apiOrigin,'/readyz',200,b=>demand(b.ready===true&&b.readOnly===true&&b.deploymentVerified===true&&b.index?.enabled===true&&Number.isFinite(b.index.ageMs)&&b.index.ageMs<=config.maxIndexAgeMs&&b.index.ageMs>=0&&Number.isSafeInteger(b.index.lagBlocks)&&b.index.lagBlocks>=0&&b.index.lagBlocks<=config.maxIndexLagBlocks,'INDEX_NOT_READY'));
  const sample=(b:any)=>{const c=CheckpointSchema.parse(b.checkpoint);demand(b.enabled===true&&Number.isSafeInteger(b.indexedRecords)&&b.indexedRecords>=0&&b.remainingRecords===0&&c.nextIndex===b.indexedRecords&&c.sourceRecordCount===b.indexedRecords,'INDEX_INCOMPLETE');demand(Date.now()-Date.parse(c.updatedAt)<=config.maxIndexAgeMs&&Date.parse(c.updatedAt)-Date.now()<=30000,'INDEX_STALE');report.indexSamples.push({height:c.block.height,hash:c.block.hash,indexedRecords:b.indexedRecords});};
  await probe('index_sample_before',config.apiOrigin,'/v1/index/status',200,sample);
  await wait(config.sampleDelayMs);
  await probe('index_sample_after',config.apiOrigin,'/v1/index/status',200,b=>{sample(b);const [a,c]=report.indexSamples;demand(a&&c&&c.height>a.height&&c.hash!==a.hash&&c.indexedRecords>=a.indexedRecords,'INDEX_NOT_ADVANCING');report.claims.indexAdvancementObserved=true;});
  await probe('settlement_denied_origin',config.apiOrigin,'/v1/config',403,b=>demand(b.error==='ORIGIN_DENIED','CORS_NOT_ENFORCED'),{headers:{origin:denied}});
  await probe('organization_liveness',config.organizationOrigin,'/healthz',200,b=>demand(b.live===true&&b.service==='core-organizations','WRONG_SERVICE'));
  await probe('organization_chain_and_storage_readiness',config.organizationOrigin,'/readyz',200,b=>{
    demand(b.ready===true&&b.service==='core-organizations'&&b.network==='testnet'&&b.databaseAvailable===true&&b.identityClaimsVerified===false,'ORGANIZATION_NOT_READY');
    demand(Number.isSafeInteger(b.checkedAtBlock?.height)&&b.checkedAtBlock.height>=0&&typeof b.checkedAtBlock.hash==='string'&&b.checkedAtBlock.hash.length>=32,'FINAL_BLOCK_REQUIRED');
    demand(Number.isFinite(Date.parse(b.checkedAt))&&Math.abs(Date.now()-Date.parse(b.checkedAt))<=30000,'READINESS_STALE');
  });
  await probe('organization_preflight',config.organizationOrigin,'/v1/me',204,(_b,r)=>demand(r.headers.get('access-control-allow-origin')===config.frontendOrigin&&r.headers.get('access-control-allow-methods')?.split(',').map(x=>x.trim()).includes('POST'),'CORS_MISMATCH'),{method:'OPTIONS',headers:{...cors,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
  await probe('organization_requires_session',config.organizationOrigin,'/v1/me',401,b=>demand(b.error==='SESSION_REQUIRED','SESSION_NOT_ENFORCED'),{headers:cors});
  await probe('organization_denied_origin',config.organizationOrigin,'/v1/me',403,b=>demand(b.error==='ORIGIN_DENIED','CORS_NOT_ENFORCED'),{headers:{origin:denied}});
  await probe('organization_draft_proxy_admission',config.organizationOrigin,'/v1/organizations/00000000-0000-4000-8000-000000000000/tax-drafts',401,b=>demand(b.error==='SESSION_REQUIRED','DRAFT_ROUTE_NOT_REACHABLE'),{method:'POST',headers:{...cors,'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(12000)})});
  report.passed=report.checks.every(c=>c.passed)&&report.claims.deploymentPolicyMatched&&report.claims.indexAdvancementObserved;
  return report;
}
