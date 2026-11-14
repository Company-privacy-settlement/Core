import { readFileSync, writeFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { createPrivateKey,createPublicKey,sign } from 'node:crypto';
import { evaluateRules,exportRuleResult,ruleCatalog,ruleCatalogHash,ruleReviewMessage,verifyRuleReview,verifyRuleResult,type RuleReviewClaims } from '../sdk/client/rules.js';
import { canonical,sha256 } from '../sdk/client/crypto.js';
const [command,...args]=process.argv.slice(2);
const json=(path:string,max=262144)=>{const b=readFileSync(path);if(b.length>max)throw new Error('Rule file exceeds its bounded size');return JSON.parse(b.toString('utf8'));};
const output=(value:unknown,path?:string)=>{const text=JSON.stringify(value,null,2)+'\n';if(path)writeFileSync(path,text,{mode:0o600,flag:'wx'});else process.stdout.write(text);};
async function main(){
 if(command==='catalog'&&args.length<=1){output(ruleCatalog(),args[0]);return;}
 if(command==='catalog-hash'&&!args.length){console.log(await ruleCatalogHash());return;}
 if(command==='policy-hash'&&args.length===1){console.log(await sha256(canonical(json(args[0]))));return;}
 if(command==='review-template'&&args.length===2){const now=new Date();output({format:'core-rule-review-v1',catalogHash:await ruleCatalogHash(),reviewerId:args[0],ruleIds:[],reviewedAt:now.toISOString(),validThrough:new Date(now.getTime()+30*86400000).toISOString(),scope:'component-preparation',rationale:'REPLACE: identify reviewed sources, applicability, rounding, assumptions and uncovered obligations.'},args[1]);return;}
 if(command==='review-sign'&&args.length===4&&args[3]==='--acknowledge-reviewed-rules'){
  const claims=json(args[0]) as RuleReviewClaims;if(!claims.ruleIds?.length||claims.rationale?.includes('REPLACE'))throw new Error('Complete the source/applicability review before signing');const fd=openSync(args[1],constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let key;try{const st=fstatSync(fd);if(!st.isFile()||st.size>8192||(st.mode&0o077)||(process.getuid&&st.uid!==process.getuid()))throw new Error('Reviewer key must be an owner-only regular file');key=createPrivateKey(readFileSync(fd));if(key.asymmetricKeyType!=='ed25519')throw new Error('Use an Ed25519 reviewer key');}finally{closeSync(fd);}
  const artifact={claims,signature:sign(null,Buffer.from(ruleReviewMessage(claims)),key).toString('base64')},publicKey=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64'),trust={format:'core-rule-trust-v1',reviewers:[{id:claims.reviewerId,publicKey,validFrom:claims.reviewedAt.slice(0,10),validThrough:claims.validThrough.slice(0,10)}],revokedReviewHashes:[]};const rule=ruleCatalog().rules.find(r=>r.id===claims.ruleIds[0]);if(!rule)throw new Error('Unknown reviewed rule');await verifyRuleReview(artifact,trust,await sha256(canonical(trust)),rule);output(artifact,args[2]);return;
 }
 if(command==='evaluate'&&args[1]==='preview'&&[2,3].includes(args.length)){output(await evaluateRules(json(args[0],32768),{mode:'preview'}),args[2]);return;}
 if(command==='evaluate'&&args[1]==='reviewed'&&[5,6].includes(args.length)){output(await evaluateRules(json(args[0],32768),{mode:'reviewed',review:json(args[2]),trust:json(args[3]),trustedPolicyHash:args[4]}),args[5]);return;}
 if(command==='verify'&&[1,3].includes(args.length)){output(await verifyRuleResult(json(args[0]),args.length===3?{trust:json(args[1]),trustedPolicyHash:args[2]}:{}));return;}
 throw new Error('Use catalog [OUT], catalog-hash, policy-hash TRUST, review-template REVIEWER OUT, review-sign CLAIMS KEY OUT --acknowledge-reviewed-rules, evaluate INPUT preview [OUT], evaluate INPUT reviewed REVIEW TRUST PIN [OUT], or verify REPORT [TRUST PIN]');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Rule command failed');process.exitCode=1;});
