/** Local HTTP proxy exercise only. This does not provision DNS, obtain public TLS, or qualify a live deployment. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const binary=process.env.CORE_CADDY_BIN;if(!binary)throw new Error('Set CORE_CADDY_BIN to the independently obtained pinned Caddy executable');
const dir=mkdtempSync(resolve(tmpdir(),'core-proxy-gate-'));
const port=(s:any)=>s.address().port as number;
async function freePort(){const server=createNetServer();server.listen(0,'127.0.0.1');await once(server,'listening');const n=port(server);await new Promise<void>(r=>server.close(()=>r()));return n;}
const received:{url:string;bytes:number;forwarded?:string}[]=[];
const upstream=createServer(async(req,res)=>{try{let size=0;for await(const c of req)size+=c.length;received.push({url:req.url!,bytes:size,forwarded:req.headers['x-forwarded-for'] as string|undefined});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ready:true,bytes:size}));}catch{res.destroy();}});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const apiPort=await freePort(),orgPort=await freePort();let processHandle:ReturnType<typeof spawn>|undefined;
try{
 const json=JSON.parse(execFileSync(binary,['adapt','--config','ops/Production.Caddyfile','--adapter','caddyfile'],{env:{...process.env,CORE_API_DOMAIN:`http://127.0.0.1:${apiPort}`,CORE_ORGANIZATION_DOMAIN:`http://127.0.0.1:${orgPort}`,CORE_TLS_EMAIL:'operator@example.com'},encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 json.admin={disabled:true};
 const adjust=(v:any)=>{if(!v||typeof v!=='object')return;if(v.dial==='api:3001'||v.dial==='organization-api:3002')v.dial=`127.0.0.1:${port(upstream)}`;for(const c of Object.values(v))if(typeof c==='object')adjust(c);};adjust(json);
 const config=resolve(dir,'config.json');writeFileSync(config,JSON.stringify(json));let errors='';processHandle=spawn(binary,['run','--config',config],{stdio:['ignore','ignore','pipe']});processHandle.stderr!.on('data',b=>{errors=(errors+b).slice(-8192);});
 const base=`http://127.0.0.1:${orgPort}`;let ready=false;for(let n=0;n<80;n++){if(processHandle.exitCode!==null)throw new Error(errors);try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await delay(50);}assert.equal(ready,true,errors);
 const id='00000000-0000-4000-8000-000000000000',draft=`/v1/organizations/${id}/tax-drafts`;
 async function send(path:string,size:number,status:number){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'spoofed-peer'},body:'x'.repeat(size)});await r.text();assert.equal(r.status,status,path+' '+size);}
 await send(draft,131072,200);await send(draft,131073,413);
 await send(draft+'/'+id+'/revise',12000,200);
 await send('/v1/providers/sumsub/webhook',65536,200);await send('/v1/providers/sumsub/webhook',65537,413);
 await send('/v1/auth/challenge',8192,200);await send('/v1/auth/challenge',8193,413);
 await send(draft+'/'+id+'/approve',12000,413);
 assert.ok(received.some(r=>r.url===draft&&r.bytes===131072));assert.ok(received.every(r=>r.forwarded===undefined));
 assert.equal((await fetch(`http://127.0.0.1:${apiPort}/readyz`)).status,200);
 console.log('Pinned Caddy local HTTP gate passed: dual origins, exact 128 KiB draft / 64 KiB provider / 8 KiB default limits, revision routing and spoofed-peer header removal. No public HTTPS deployment claimed.');
}finally{if(processHandle&&processHandle.exitCode===null){const exited=once(processHandle,'exit');processHandle.kill('SIGTERM');await exited;}upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
