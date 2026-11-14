import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {z} from 'zod';
import {canonical} from '../../sdk/client/crypto.js';
import {ruleCatalog,ruleCatalogHash,verifyRuleReview,type RuleSource} from '../../sdk/client/rules.js';
import {SumsubProvider,loadSumsubConfig} from '../../server/organizations/sumsub.js';

const Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const QualificationConfig=z.object({
 format:z.literal('core-provider-qualification-config-v1'),
 sumsubConfigFile:z.string().min(1).nullable(),casesFile:z.string().min(1).nullable(),
 ruleTrustFile:z.string().min(1).nullable(),trustedRulePolicySha256:Sha.nullable(),
 ruleReviewFiles:z.array(z.string().min(1)).max(20),
 ruleAuthorIds:z.array(z.string().min(1).max(128)).min(1).max(20),
}).strict();
const CaseList=z.object({format:z.literal('core-sumsub-qualification-cases-v1'),cases:z.array(z.object({
 reference:z.string().regex(/^[a-z0-9-]{1,64}$/),externalUserId:z.string().min(1).max(256).refine(v=>!v.startsWith('REPLACE_')),country:z.enum(['USA','ARE']),
 expectedState:z.enum(['in_review','needs_information','approved','expired','revoked','rejected']),
}).strict()).min(1).max(10)}).strict().refine(v=>new Set(v.cases.map(c=>c.reference)).size===v.cases.length&&new Set(v.cases.map(c=>c.externalUserId)).size===v.cases.length);

export function qualificationJson(file:string,max:number,privateFile=true){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=fstatSync(fd);if(!s.isFile()||s.size>max||(privateFile&&((s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))))throw Error('QUALIFICATION_FILE_REJECTED');return JSON.parse(readFileSync(fd,'utf8'));}
 finally{closeSync(fd);}
}
const hosts=new Set(['www.irs.gov','irs.gov','tax.gov.ae','www.tax.gov.ae','mof.gov.ae','www.mof.gov.ae','u.ae','www.uaelegislation.gov.ae','uaelegislation.gov.ae','www.adgm.com','adgm.com','assets.adgm.com','en.adgm.thomsonreuters.com']);
function sourceUrl(raw:string){const u=new URL(raw);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.username||u.password||u.port||u.hash)throw Error('SOURCE_ORIGIN_REJECTED');return u;}
export type SourceCapture={id:string;url:string;finalUrl:string|null;httpStatus:number|null;checkedAt:string;expectedSha256:string|null;observedSha256:string|null;bytes:number|null;status:'match'|'changed'|'unversioned'|'unavailable';reason:string|null};
export async function captureRuleSources(sources:readonly RuleSource[]=ruleCatalog().rules.flatMap(r=>r.sources),transport:typeof fetch=fetch,signal:AbortSignal=AbortSignal.timeout(60000)){
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('SOURCE_TLS_REQUIRED');
 const unique=new Map<string,RuleSource>();for(const s of sources){const old=unique.get(s.id);if(old&&(old.url!==s.url||old.documentSha256!==s.documentSha256))throw Error('SOURCE_ID_CONFLICT');unique.set(s.id,s);}
 const capture=async(s:RuleSource):Promise<SourceCapture>=>{
  const out:SourceCapture={id:s.id,url:s.url,finalUrl:null,httpStatus:null,checkedAt:new Date().toISOString(),expectedSha256:s.documentSha256,observedSha256:null,bytes:null,status:'unavailable',reason:null};
  try{
   let u=sourceUrl(s.url),response:Response|undefined;
   for(let redirects=0;redirects<=3;redirects++){
    signal.throwIfAborted();response=await transport(u.href,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:{accept:'application/pdf,text/html;q=0.9,*/*;q=0.1','user-agent':'MoneyStation-SourceQualification/1.0'}});out.finalUrl=u.href;out.httpStatus=response.status;
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===3)throw Error('SOURCE_REDIRECT_LIMIT');u=sourceUrl(new URL(location,u).href);continue;}break;
   }
   if(!response?.ok||!response.body){await response?.body?.cancel();throw Error('SOURCE_HTTP_UNAVAILABLE');}
   const reader=response.body.getReader(),hash=createHash('sha256');let bytes=0,prefix=Buffer.alloc(0);
   try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>8388608)throw Error('SOURCE_BODY_LIMIT');if(prefix.length<5)prefix=Buffer.concat([prefix,Buffer.from(p.value)]).subarray(0,5);hash.update(p.value);}}
   finally{await reader.cancel();reader.releaseLock();}
   if(!bytes)throw Error('SOURCE_EMPTY');
   if((/\.pdf(?:\/|$)/i.test(new URL(s.url).pathname)||/\/download$/.test(new URL(s.url).pathname))&&prefix.toString()!=='%PDF-')throw Error('SOURCE_EXPECTED_PDF');
   signal.throwIfAborted();out.bytes=bytes;out.observedSha256=hash.digest('hex');out.status=s.documentSha256===null?'unversioned':out.observedSha256===s.documentSha256?'match':'changed';
  }catch(e){out.reason=e instanceof Error&&/^SOURCE_[A-Z_]+$/.test(e.message)?e.message:'SOURCE_FETCH_UNAVAILABLE';}
  return out;
 };
 const list=[...unique.values()],captures:SourceCapture[]=[];
 for(let i=0;i<list.length;i+=2)captures.push(...await Promise.all(list.slice(i,i+2).map(capture)));
 return{format:'core-rule-source-qualification-v1',checkedAt:new Date().toISOString(),catalogHash:await ruleCatalogHash(),captures,allPinnedSourcesMatched:captures.length>0&&captures.every(c=>c.status==='match'),legalApplicabilityVerified:false,interpretation:'A changed byte hash can reflect layout or dynamic content. It does not itself establish a legal change. No catalog pin, rate or approval is rewritten.'};
}

export async function qualifyProviders(configFile:string,options:{transport?:typeof fetch;sourceTransport?:typeof fetch;now?:()=>number;signal?:AbortSignal}={}){
 const config=QualificationConfig.parse(qualificationJson(configFile,16384)),base=dirname(resolve(configFile)),path=(p:string)=>resolve(base,p),now=options.now??Date.now,signal=options.signal??AbortSignal.timeout(120000),transport=options.transport??fetch;
 const sources=await captureRuleSources(undefined,options.sourceTransport??fetch,signal),blockers=new Set<string>();
 const kyb:{configured:boolean;providerCallsAttempted:boolean;environment:string|null;observations:{reference:string;expectedState:string;observedState:string|null;providerState:string|null;subjects:number;matched:boolean;error:string|null}[];passed:boolean}={configured:false,providerCallsAttempted:false,environment:null,observations:[],passed:false};
 if(!config.sumsubConfigFile||!config.casesFile)blockers.add('SUMSUB_CREDENTIALS_AND_AUTHORIZED_CASES_REQUIRED');
 else try{
  const provider=new SumsubProvider(loadSumsubConfig(path(config.sumsubConfigFile)),transport,now),cases=CaseList.parse(qualificationJson(path(config.casesFile),32768)).cases;kyb.configured=true;kyb.environment=provider.config.environment;
  for(const c of cases){signal.throwIfAborted();const o={reference:c.reference,expectedState:c.expectedState,observedState:null as string|null,providerState:null as string|null,subjects:0,matched:false,error:null as string|null};
   try{kyb.providerCallsAttempted=true;const snapshot=await provider.snapshot(c.externalUserId,c.country,signal);o.providerState=snapshot.state;o.observedState=snapshot.state==='approved'&&snapshot.approvedAt&&Date.parse(snapshot.approvedAt)+provider.config.validityDays*86400000<=now()?'expired':snapshot.state;o.subjects=snapshot.subjects.length;o.matched=o.observedState===c.expectedState;}catch{o.error='SUMSUB_OBSERVATION_UNAVAILABLE';}kyb.observations.push(o);
  }
  const states=new Set(kyb.observations.filter(o=>o.matched).map(o=>o.observedState)),countries=new Set(cases.filter((_,i)=>kyb.observations[i].matched).map(c=>c.country));
  kyb.passed=kyb.observations.every(o=>o.matched)&&['in_review','needs_information','approved','expired','revoked'].every(s=>states.has(s))&&countries.has('USA')&&countries.has('ARE');if(!kyb.passed)blockers.add('SUMSUB_LIFECYCLE_OR_COUNTRY_COVERAGE_INCOMPLETE');
 }catch{blockers.add('SUMSUB_CONFIGURATION_OR_CASES_UNAVAILABLE');}

 let trust:unknown,pin:string|undefined,reviews:unknown[]=[];
 if(!config.ruleTrustFile||!config.trustedRulePolicySha256||!config.ruleReviewFiles.length)blockers.add('INDEPENDENT_RULE_POLICY_AND_SIGNED_REVIEWS_REQUIRED');
 else try{trust=qualificationJson(path(config.ruleTrustFile),131072);pin=config.trustedRulePolicySha256;reviews=config.ruleReviewFiles.map(f=>qualificationJson(path(f),131072));}catch{blockers.add('RULE_REVIEW_FILES_UNAVAILABLE');}
 const rules=[];
 for(const rule of ruleCatalog().rules){
  const sourceIntegrity=rule.sources.every(s=>sources.captures.find(c=>c.id===s.id)?.status==='match');let accepted:Awaited<ReturnType<typeof verifyRuleReview>>|null=null;
  for(const review of reviews){try{const checked=await verifyRuleReview(review,trust,pin??'',rule,now());if(config.ruleAuthorIds.includes(checked.reviewerId))continue;accepted=checked;break;}catch{/* No untrusted error strings or document contents are exported. */}}
  rules.push({ruleId:rule.id,sourcesMatched:sourceIntegrity,independentTrustedReviewValid:!!accepted,reviewerId:accepted?.reviewerId??null,reviewHash:accepted?.reviewHash??null,validThrough:accepted?.validThrough??null});
 }
 if(!sources.allPinnedSourcesMatched)blockers.add('RULE_SOURCE_BYTES_REQUIRE_REVIEW');if(rules.some(r=>!r.independentTrustedReviewValid))blockers.add('RULE_INDEPENDENT_REVIEW_COVERAGE_INCOMPLETE');
 return{format:'core-provider-qualification-v1',checkedAt:new Date(now()).toISOString(),status:blockers.size?'blocked':'passed',blockers:[...blockers],kyb,ruleSources:sources,rules,claims:{liveKybLifecycleQualified:kyb.passed,ruleSourcesAndIndependentKeysQualified:rules.every(r=>r.sourcesMatched&&r.independentTrustedReviewValid),providerIdentityDeclarations:'Configuration identifies the provider account; reviewer authority and author-ID independence require an operator policy distributed out of band.',professionalQualificationsAutomaticallyVerified:false,filingProviderIntegrated:false,productionQualified:false},limits:['Only authenticated GET requests are made to Sumsub; no applicant creation, approval, rejection, deactivation or document upload.','State coverage uses operator-authorized existing cases, not proof of transitions on one real business. Expiry derives from the configured local validity policy.','Signed review validation binds catalog/rules, authority dates and current supplied revocations. It does not verify professional licensing or fresh external revocation lists.','Missing credentials, inaccessible/changed/unpinned sources or absent/expired/revoked/self-author reviews never count as a pass.']};
}
