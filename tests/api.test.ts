import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadOnlyApi } from '../server/api.js';
import { operationsFixture } from './fixtures/operations.js';
async function api(t: { after(fn:()=>Promise<void>):void }) {
  const f=operationsFixture();const server=createReadOnlyApi({source:f.source,policy:f.policy,allowedOrigins:['http://localhost:3000'],maxConcurrent:1});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));});
  const url=`http://127.0.0.1:${address.port}`;
  const post=(path:string,value:unknown,extra:Record<string,string>={})=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(value)});
  return {...f,url,post};
}
test('API health is explicit about readiness, config excludes RPC secrets, and catalog uses verified reads',async t=>{
  const f=await api(t);const health=await(await fetch(f.url+'/healthz')).json();assert.equal(health.readOnly,true);assert.equal(health.chainReadinessChecked,false);
  const config=await(await fetch(f.url+'/v1/config')).json();assert.equal(config.signing,'client-wallet');assert.ok(!JSON.stringify(config).includes('rpcUrl'));
  const response=await fetch(f.url+'/v1/vaults');assert.equal(response.status,200);const result=await response.json();assert.equal(result.catalog.vaults[0].accountId,f.vault);assert.equal(result.checkedAtBlock.hash,'block-20');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await f.post('/v1/broadcast',{privateKey:'fake'})).status,404);
});
test('API preflight and finalized status return prerequisite calls and immutable recovery bindings',async t=>{
  const f=await api(t);let response=await f.post('/v1/ft/preflight',{operation:'deposit',payer:f.payer,vault:f.vault});assert.equal(response.status,200);assert.equal((await response.json()).prerequisites.length,2);
  f.state.withdrawal={vault:f.vault,recipient:f.recipient,disclosure_root:'ab'.repeat(32),state:'Complete',attempt:1,last_height:10};
  response=await f.post('/v1/settlements/status',{kind:'withdrawal',nullifier:'42',expectedRecipient:f.recipient});assert.equal((await response.json()).complete,true);
  response=await f.post('/v1/settlements/status',{kind:'withdrawal',nullifier:'42',expectedRecipient:'attacker.test.near'});assert.equal(response.status,409);assert.equal((await response.json()).error,'DESTINATION_MISMATCH');
});
test('API rejects accidental secret input, invalid JSON, oversized bodies and request-controlled RPCs',async t=>{
  const f=await api(t);const request={operation:'deposit',payer:f.payer,vault:f.vault};
  for(const extra of [{secret:'do-not-send'},{rpcUrl:'http://internal.local'},{note:{secret:'private'}}]) {const response=await f.post('/v1/ft/preflight',{...request,...extra});assert.equal(response.status,400);assert.ok(!(await response.text()).includes('do-not-send'));}
  assert.equal((await fetch(f.url+'/v1/ft/preflight',{method:'POST',headers:{'content-type':'application/json'},body:'{bad'})).status,400);
  assert.equal((await f.post('/v1/ft/preflight',{value:'x'.repeat(9000)})).status,413);
  assert.equal((await fetch(f.url+'/v1/ft/preflight',{method:'POST',body:'{}'})).status,415);
  assert.equal((await fetch(f.url+'/v1/vaults?maxRecords=51')).status,400);
});
test('API uses exact CORS origins and does not mask upstream errors as missing accounts or bad client input',async t=>{
  const f=await api(t);assert.equal((await fetch(f.url+'/healthz',{headers:{origin:'https://evil.example'}})).status,403);
  const allowed=await fetch(f.url+'/healthz',{headers:{origin:'http://localhost:3000'}});assert.equal(allowed.headers.get('access-control-allow-origin'),'http://localhost:3000');
  const original=f.source.contractView;f.source.contractView=async(a,m,args,b)=>m==='ft_metadata'?{invalid:true}:original(a,m,args,b);
  let result=await f.post('/v1/ft/preflight',{operation:'deposit',payer:f.payer,vault:f.vault});assert.equal(result.status,502);assert.equal((await result.json()).error,'CHAIN_READ_FAILED');
  f.source.finalBlock=async()=>{throw new Error('Sensitive RPC URL, token or stack');};result=await fetch(f.url+'/v1/vaults');assert.equal(result.status,502);assert.ok(!(await result.text()).includes('Sensitive'));
});
test('API caps simultaneous chain work while still serving health checks',async t=>{
  const f=await api(t);let release!:()=>void;let started!:()=>void;
  const entered=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});const original=f.source.finalBlock;
  f.source.finalBlock=async()=>{started();await gate;return original();};
  const first=fetch(f.url+'/v1/vaults');await entered;
  try{assert.equal((await fetch(f.url+'/v1/vaults')).status,429);assert.equal((await fetch(f.url+'/healthz')).status,200);}finally{release();await first;}
});
