import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { OrganizationStore } from '../server/organizations/store.js';
import { createOrganizationApi } from '../server/organizations/api.js';
import { SumsubProvider } from '../server/organizations/sumsub.js';

const origin='https://front.example',audience='https://organizations.example',owner='owner.testnet';
const provider=()=>new SumsubProvider({format:'core-sumsub-config-v1',environment:'sandbox',apiOrigin:'https://api.sumsub.com',clientId:'demo-test',appToken:'sandbox-fixture-token',secretKey:'s'.repeat(32),webhookSecret:'w'.repeat(32),companyLevel:'company',individualLevel:'owners',validityDays:30});

async function fixture(t:{after(fn:()=>void):void},demoKyb=false,storedCase=false){
  const store=new OrganizationStore(':memory:',audience,Date.now,{activeKeyId:'test',indexKey:randomBytes(32),keys:new Map([['test',randomBytes(32)]])});
  const org=store.create(owner,'Hackathon example');
  if(storedCase)store.verifications.create(org.id,owner,{requestId:randomUUID(),jurisdiction:'US',acknowledged:true},provider());
  let currentKey=true;
  const server=createOrganizationApi({store,allowedOrigins:[origin],identity:{currentFullAccessKey:async()=>currentKey},demoKyb});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=(account:string)=>store.issueSession(store.challenge(account,origin).id,origin,'ed25519:'+'1'.repeat(32)).token;
  const read=(token?:string,path=`/v1/organizations/${org.id}/verification`)=>fetch(base+path,{headers:{origin,...(token?{authorization:'Bearer '+token}:{})}});
  return {store,org,base,session,read,revokeKey:()=>{currentKey=false;}};
}

test('hackathon KYB immediately returns a separate demo approval without provider or identity claims',async t=>{
  const f=await fixture(t,true),token=f.session(owner),response=await f.read(token),value=await response.json();
  assert.equal(response.status,200);assert.equal(value.configured,false);assert.equal(value.case,null);
  assert.deepEqual(value.demo,{mode:'hackathon',state:'approved',identityChecksPerformed:false,credentialIssued:false});
  assert.equal(f.store.list(owner)[0].claims.kybVerified,false);
  const identity=await (await f.read(token,'/v1/me')).json();assert.equal(identity.claims.legalIdentityVerified,false);assert.equal(identity.claims.kybVerified,false);
  assert.equal((await f.read(token)).status,200);
});

test('disabled demo mode never grants approval and client-selected decisions cannot enable it',async t=>{
  const f=await fixture(t),token=f.session(owner),value=await (await f.read(token)).json();assert.equal(value.demo,undefined);assert.equal(value.case,null);
  const response=await fetch(f.base+`/v1/organizations/${f.org.id}/verification`,{method:'POST',headers:{origin,authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({state:'approved',demoKyb:true})});
  assert.equal(response.status,503);assert.equal((await (await f.read(token)).json()).demo,undefined);
});

test('demo approval preserves session, tenant, role, membership and wallet-key boundaries',async t=>{
  const f=await fixture(t,true);assert.equal((await f.read()).status,401);assert.equal((await f.read(f.session('foreign.testnet'))).status,404);
  for(const role of ['viewer','admin'] as const){const account=role+'.testnet',invite=f.store.invite(f.org.id,owner,account,role);f.store.respondInvite(invite.id,account,true,invite.version);const token=f.session(account);
    assert.equal((await f.read(token)).status,role==='viewer'?403:200);
    const member=f.store.members(f.org.id,owner).find(m=>m.accountId===account)!;f.store.remove(f.org.id,owner,account,member.version);assert.equal((await f.read(token)).status,404);
  }
  f.revokeKey();assert.equal((await f.read(f.session(owner))).status,401);
});

test('demo mode cannot mask an existing provider case or revive a revoked decision',async t=>{
  const f=await fixture(t,true,true),token=f.session(owner),current=await (await f.read(token)).json();
  assert.equal(current.demo,undefined);assert.equal(current.case.state,'stale');
  f.store.verifications.revoke(f.org.id,owner,current.case.version);
  const revoked=await (await f.read(token)).json();assert.equal(revoked.demo,undefined);assert.equal(revoked.case.state,'revoked');
});

test('a real verification provider and hackathon approval cannot be configured together',t=>{
  const store=new OrganizationStore(':memory:',audience);t.after(()=>store.close());
  assert.throws(()=>createOrganizationApi({store,allowedOrigins:[origin],identity:{currentFullAccessKey:async()=>true},verificationProvider:provider(),demoKyb:true}),/cannot be enabled together/);
});
