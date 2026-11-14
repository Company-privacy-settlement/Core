/** Build a private, versioned runtime from locked production dependencies and public policy. */
import {execFileSync} from 'node:child_process';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync,chmodSync,lstatSync} from 'node:fs';
import {resolve,dirname,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(process.argv[2]??'/home/jiheon/.local/share/money-station/backend');
const demoValue=process.env.MONEY_STATION_DEMO_KYB??'false';
if(!['true','false'].includes(demoValue))throw Error('MONEY_STATION_DEMO_KYB must be true or false');
if(root.includes('\n')||root.includes('%'))throw Error('Unsupported deployment root');
mkdirSync(root,{recursive:true,mode:0o700});
if(lstatSync(root).isSymbolicLink()||statSync(root).uid!==process.getuid()||(statSync(root).mode&0o077))throw Error('Deployment root must be an owner-only directory');
const sha=b=>createHash('sha256').update(b).digest('hex');
const policy=readFileSync(resolve(repo,'docs/evidence/testnet-native-policy-2026-11-14.json'));
const policySha='f6ca5b87c5ae8140f791d84d9464aec60f32f0da58a9cf050b46ad30bd371595';
if(sha(policy)!==policySha)throw Error('Native policy pin changed; independent review is required');
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repo,encoding:'utf8'}).trim())throw Error('Commit the reviewed source before preparing a pinned runtime');
execFileSync(process.execPath,['scripts/build-service.mjs'],{cwd:repo,stdio:'inherit'});
mkdirSync(resolve(root,'releases'),{recursive:true,mode:0o700});
const staging=mkdtempSync(resolve(root,'releases/.prepare-'));
try{
 for(const n of ['package.json','package-lock.json','THIRD_PARTY_NOTICES.md'])copyFileSync(resolve(repo,n),resolve(staging,n));
 execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:staging,stdio:'inherit'});
 cpSync(resolve(repo,'dist/service'),resolve(staging,'dist/service'),{recursive:true});
 mkdirSync(resolve(staging,'scripts'),{recursive:true});
 for(const n of ['start-service.mjs','index-maintenance.mjs','organization-maintenance.mjs','organization-invoice-keys.mjs','service-health.mjs'])copyFileSync(resolve(repo,'scripts',n),resolve(staging,'scripts',n));
 mkdirSync(resolve(staging,'runtime'));copyFileSync(realpathSync(process.execPath),resolve(staging,'runtime/node'));chmodSync(resolve(staging,'runtime/node'),0o755);
 mkdirSync(resolve(staging,'config'));writeFileSync(resolve(staging,'config/policy.json'),policy);
 writeFileSync(resolve(staging,'config/passwd'),`money-station:x:${process.getuid()}:${process.getgid()}:Money Station:/tmp:/usr/sbin/nologin\n`);
 writeFileSync(resolve(staging,'config/group'),`money-station:x:${process.getgid()}:\n`);
 const files={};
 function inventory(dir){for(const e of readdirSync(dir,{withFileTypes:true})){
  const p=join(dir,e.name);if(e.name==='.bin'&&e.isDirectory()){rmSync(p,{recursive:true});continue;}
  if(e.isSymbolicLink())throw Error('Unexpected runtime symlink: '+relative(staging,p));
  if(e.isDirectory())inventory(p);else if(e.isFile())files[relative(staging,p)]=sha(readFileSync(p));
 }}
 inventory(staging);
 const manifest={format:'money-station-backend-runtime-v1',sourceCommit:source,nodeVersion:process.versions.node,policySha256:policySha,asset:'native NEAR testnet',files};
 const encoded=JSON.stringify(manifest,null,2)+'\n';const id=source.slice(0,12)+'-'+sha(encoded).slice(0,12);
 writeFileSync(resolve(staging,'runtime-manifest.json'),encoded,{mode:0o600});
 const release=resolve(root,'releases',id);
 if(readdirSync(resolve(root,'releases')).includes(id)){
  if(lstatSync(release).isSymbolicLink()||readFileSync(resolve(release,'runtime-manifest.json'),'utf8')!==encoded)throw Error('Existing runtime differs from the reviewed release');
  for(const [name,pin] of Object.entries(files))if(lstatSync(resolve(release,name)).isSymbolicLink()||sha(readFileSync(resolve(release,name)))!==pin)throw Error('Existing runtime asset differs: '+name);
 }else renameSync(staging,release);
 copyFileSync(resolve(repo,'ops/ubuntu/manage-backend.py'),resolve(root,'control.next'));chmodSync(resolve(root,'control.next'),0o700);renameSync(resolve(root,'control.next'),resolve(root,'control.py'));
 const config={format:'money-station-backend-config-v1',release,releaseId:id,rpc:'https://test.rpc.fastnear.com',frontOrigin:'https://moneystation.site',apiOrigin:'https://api.moneystation.site',apiPort:3331,organizationPort:3332,policySha256:policySha,demoKyb:demoValue==='true'};
 writeFileSync(resolve(root,'config.next'),JSON.stringify(config,null,2)+'\n',{mode:0o600});renameSync(resolve(root,'config.next'),resolve(root,'config.json'));
 console.log(JSON.stringify({status:'prepared',root,releaseId:id,sourceCommit:source,nodeVersion:process.versions.node,policySha256:policySha,files:Object.keys(files).length}));
}finally{rmSync(staging,{recursive:true,force:true});}
