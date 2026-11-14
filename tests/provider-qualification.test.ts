import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {canonical} from '../sdk/client/crypto.js';
import {ruleCatalog,ruleCatalogHash,ruleReviewMessage,type RuleReviewClaims} from '../sdk/client/rules.js';
import {captureRuleSources,qualifyProviders,qualificationJson} from '../scripts/lib/provider-qualification.js';
const digest=(b:string)=>createHash('sha256').update(b).digest('hex'),body='%PDF- test official document';
const source={id:'fixture-source',title:'Controlled test',url:'https://www.irs.gov/fixture.pdf',locator:'Section one',checkedAt:'2026-11-14',documentSha256:digest(body)};
test('source capture checks exact bytes and deduplicates rule-specific locators',async()=>{
 let calls=0;const transport:typeof fetch=async(_url,init)=>{calls++;assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'manual');return new Response(body);};
 const report=await captureRuleSources([source,{...source,locator:'Section two'}],transport);assert.equal(calls,1);assert.equal(report.allPinnedSourcesMatched,true);assert.equal(report.captures[0].observedSha256,source.documentSha256);assert.equal(report.legalApplicabilityVerified,false);
 await assert.rejects(captureRuleSources([source,{...source,url:'https://www.irs.gov/other.pdf'}],transport),/SOURCE_ID_CONFLICT/);
});
test('changed, unversioned and inaccessible sources never acquire automatic approval',async()=>{
 const changed=await captureRuleSources([source],async()=>new Response(body+' altered'));assert.equal(changed.captures[0].status,'changed');assert.equal(changed.allPinnedSourcesMatched,false);
 const unversioned=await captureRuleSources([{...source,documentSha256:null}],async()=>new Response(body));assert.equal(unversioned.captures[0].status,'unversioned');assert.equal(unversioned.allPinnedSourcesMatched,false);
 for(const response of [()=>new Response('blocked',{status:403}),()=>new Response('<html>challenge</html>')]){const r=await captureRuleSources([source],async()=>response());assert.equal(r.captures[0].status,'unavailable');assert.equal(r.captures[0].observedSha256,null);}
});
test('source redirects cannot move requests to an unapproved host or protocol',async()=>{
 for(const location of ['https://private.example/','http://www.irs.gov/fixture.pdf','https://user:password@www.irs.gov/fixture.pdf']){let calls=0;const r=await captureRuleSources([source],async()=>{calls++;return new Response(null,{status:302,headers:{location}});});assert.equal(calls,1);assert.equal(r.captures[0].reason,'SOURCE_ORIGIN_REJECTED');}
});
test('source TLS disable and owner-file/symlink failures are closed before private reads',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'qualification-files-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'config.json');writeFileSync(file,'{}',{mode:0o600});assert.deepEqual(qualificationJson(file,20),{});
 symlinkSync(file,join(dir,'link.json'));assert.throws(()=>qualificationJson(join(dir,'link.json'),20));chmodSync(file,0o644);assert.throws(()=>qualificationJson(file,20));
 const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';t.after(()=>{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;});
 await assert.rejects(captureRuleSources([source],async()=>{throw Error('No request allowed');}),/TLS/);
});
function setup(t:{after(fn:()=>void):void}){
 const dir=mkdtempSync(join(tmpdir(),'provider-qualification-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config={format:'core-provider-qualification-config-v1',sumsubConfigFile:null as string|null,casesFile:null as string|null,ruleTrustFile:null as string|null,trustedRulePolicySha256:null as string|null,ruleReviewFiles:[] as string[],ruleAuthorIds:['fixture-author']};
 const save=(name:string,v:unknown)=>{const p=join(dir,name);writeFileSync(p,JSON.stringify(v),{mode:0o600});return p;},file=save('runtime.json',config),write=()=>save('runtime.json',config);
 const sourceTransport:typeof fetch=async()=>new Response(body);return{dir,config,save,file,write,sourceTransport};
}
test('unconfigured providers emit explicit blockers without sending a Sumsub request',async t=>{
 const f=setup(t);let sent=0;const r=await qualifyProviders(f.file,{sourceTransport:f.sourceTransport,transport:async()=>{sent++;throw Error('No provider account');}});
 assert.equal(sent,0);assert.equal(r.status,'blocked');assert.equal(r.kyb.providerCallsAttempted,false);assert.equal(r.claims.liveKybLifecycleQualified,false);assert.ok(r.blockers.includes('INDEPENDENT_RULE_POLICY_AND_SIGNED_REVIEWS_REQUIRED'));assert.ok(!JSON.stringify(r).includes(body));
});
test('independent rule checks reject author, revoked, expired, tampered and unpinned reviews',async t=>{
 const f=setup(t),now=Date.parse('2026-11-14T12:00:00.000Z'),pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
 const claims:RuleReviewClaims={format:'core-rule-review-v1',catalogHash:await ruleCatalogHash(),reviewerId:'fixture-reviewer',ruleIds:ruleCatalog().rules.map(r=>r.id),reviewedAt:new Date(now-1000).toISOString(),validThrough:new Date(now+3600000).toISOString(),scope:'component-preparation',rationale:'Controlled test key only; not a professional approval.'};
 const artifact=()=>({claims,signature:sign(null,Buffer.from(ruleReviewMessage(claims)),pair.privateKey).toString('base64')}),trust={format:'core-rule-trust-v1',reviewers:[{id:'fixture-reviewer',publicKey,validFrom:'2026-01-01',validThrough:'2027-01-01'}],revokedReviewHashes:[] as string[]};
 f.config.ruleTrustFile=f.save('trust.json',trust);f.config.ruleReviewFiles=[f.save('review.json',artifact())];f.config.trustedRulePolicySha256=digest(canonical(trust));f.write();
 const run=()=>qualifyProviders(f.file,{sourceTransport:f.sourceTransport,now:()=>now});let r=await run();assert.ok(r.rules.every(r=>r.independentTrustedReviewValid));assert.equal(r.status,'blocked');assert.equal(r.claims.professionalQualificationsAutomaticallyVerified,false);
 f.config.ruleAuthorIds.push('fixture-reviewer');f.write();assert.ok((await run()).rules.every(r=>!r.independentTrustedReviewValid));f.config.ruleAuthorIds.pop();
 f.config.trustedRulePolicySha256='0'.repeat(64);f.write();assert.ok((await run()).rules.every(r=>!r.independentTrustedReviewValid));
 trust.revokedReviewHashes=[digest(canonical(artifact()))];f.save('trust.json',trust);f.config.trustedRulePolicySha256=digest(canonical(trust));f.write();assert.ok((await run()).rules.every(r=>!r.independentTrustedReviewValid));
 trust.revokedReviewHashes=[];f.save('trust.json',trust);f.config.trustedRulePolicySha256=digest(canonical(trust));f.write();claims.validThrough=new Date(now-1).toISOString();f.save('review.json',artifact());assert.ok((await run()).rules.every(r=>!r.independentTrustedReviewValid));
 claims.validThrough=new Date(now+3600000).toISOString();const altered=artifact();altered.signature=Buffer.alloc(64).toString('base64');f.save('review.json',altered);assert.ok((await run()).rules.every(r=>!r.independentTrustedReviewValid));
});
test('read-only provider adapter covers GET snapshots and excludes private applicant data',async t=>{
 const f=setup(t),now=Date.parse('2026-11-14T12:00:00.000Z'),states=['in_review','needs_information','approved','expired','revoked'] as const,cases=states.map((expectedState,i)=>({reference:'controlled-case-'+i,externalUserId:'private-case-'+i,country:i<2?'USA':'ARE',expectedState}));
 const c={format:'core-sumsub-config-v1',environment:'sandbox',apiOrigin:'https://api.sumsub.com',clientId:'fixture-client',appToken:'sbx:fixture-token',secretKey:'s'.repeat(32),webhookSecret:'w'.repeat(32),companyLevel:'company',individualLevel:'person',validityDays:30};
 f.config.sumsubConfigFile=f.save('sumsub.json',c);f.config.casesFile=f.save('cases.json',{format:'core-sumsub-qualification-cases-v1',cases});f.write();
 const rootId=(i:number)=>'a'.repeat(23)+i,childId=(i:number)=>'b'.repeat(23)+i;
 const profile=(i:number,child=false)=>({id:child?childId(i):rootId(i),type:child?'individual':'company',clientId:c.clientId,sandboxMode:true,externalUserId:'private-case-'+i,deleted:i===4,info:child?{firstName:'PRIVATE NAME'}:{companyInfo:{country:cases[i].country,beneficiaries:[{applicantId:childId(i),types:['ubo']}]}}});
 let calls=0;const transport:typeof fetch=async(url,init)=>{calls++;assert.equal(init?.method,'GET');const u=new URL(String(url));assert.equal(u.origin,c.apiOrigin);const external=u.pathname.match(/externalUserId=(.+)\/one/);let value;
  if(external){value=profile(Number(decodeURIComponent(external[1]).split('-').at(-1)));}
  else{const m=u.pathname.match(/\/([ab][a-z0-9]{23})\/(one|status)$/);assert.ok(m);const i=Number(m[1].at(-1));value=m[2]==='one'?profile(i,true):{levelName:m[1].startsWith('a')?c.companyLevel:c.individualLevel,reviewStatus:i===0?'pending':'completed',reviewDate:new Date(i===3?now-31*86400000:now-1000).toISOString(),reviewResult:i===1?{reviewAnswer:'RED',reviewRejectType:'RETRY'}:{reviewAnswer:'GREEN'}};}
  return new Response(JSON.stringify(value));};
 const r=await qualifyProviders(f.file,{transport,sourceTransport:f.sourceTransport,now:()=>now});assert.ok(calls>5);assert.equal(r.kyb.passed,true);assert.equal(r.status,'blocked');assert.equal(r.claims.productionQualified,false);assert.ok(r.kyb.observations.every(o=>o.matched));assert.ok(!JSON.stringify(r).includes('private-case-'));assert.ok(!JSON.stringify(r).includes('PRIVATE NAME'));
 const sent=calls;cases[0].externalUserId='REPLACE_WITH_EXISTING_CASE';f.save('cases.json',{format:'core-sumsub-qualification-cases-v1',cases});const incomplete=await qualifyProviders(f.file,{transport,sourceTransport:f.sourceTransport,now:()=>now});assert.equal(calls,sent);assert.equal(incomplete.kyb.providerCallsAttempted,false);assert.equal(incomplete.status,'blocked');
});
