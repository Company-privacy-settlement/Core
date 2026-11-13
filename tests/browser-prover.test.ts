import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserProver, createProofBundle, decodeBrowserProof, encodeBrowserProof, encodeVerificationKeyBytes, parseProofBundle, parseProvingContext, spendWitness, verifyProvingAssets, type ProvingAssets, type ProvingRequest, type ProofBundle, type SpendProof } from '../sdk/client/prover.js';
import { canonical, sha256 } from '../sdk/client/crypto.js';
import { noteDomain, noteHash } from '../sdk/client/notes.js';
import { HttpGateway } from '../sdk/client/http.js';
import { contextHash, encodeProof, encodeVerificationKey, hash, NoteTree, shutdownProver } from '../sdk/core.js';
import { provingContext } from '../sdk/operations.js';
import { createReadOnlyApi } from '../server/api.js';
import { operationsFixture } from './fixtures/operations.js';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const vk = { protocol: 'groth16', curve: 'bn128', nPublic: 5, vk_alpha_1: ['1','2','1'], vk_beta_2: [['3','4'],['5','6'],['1','0']], vk_gamma_2: [['3','4'],['5','6'],['1','0']], vk_delta_2: [['3','4'],['5','6'],['1','0']], IC: Array.from({length:6}, () => ['1','2','1']) };
const proof = { protocol: 'groth16', curve: 'bn128', pi_a: ['1','2','1'], pi_b: [['3','4'],['5','6'],['1','0']], pi_c: ['7','8','1'] };
const keyBytes = new TextEncoder().encode(JSON.stringify(vk)), wasm = Uint8Array.from([0,97,115,109]), zkey = Uint8Array.from([1,2,3]);
const manifest = JSON.stringify({ protocol: 'core-v1', depth: 8, setup: 'UNSAFE_LOCAL_DEVELOPMENT_ONLY', hashes: { 'spend.r1cs': 'ab'.repeat(32), 'spend_js/spend.wasm': sha(wasm), 'spend.zkey': sha(zkey), 'verification_key.json': sha(keyBytes) } });
const assets: ProvingAssets = { manifest: new Blob([manifest]), manifestSha256: sha(manifest), wasm: new Blob([wasm]), zkey: new Blob([zkey]), verificationKey: new Blob([keyBytes]) };
async function fixture() {
  const f = operationsFixture(); f.policy.verifierSha256 = sha(encodeVerificationKeyBytes(vk)); f.config.verifier_sha256 = f.policy.verifierSha256;
  const domain = await noteDomain(f.policy), note = { version: 1 as const, domain, secret: '123', nullifier: '456', commitment: noteHash(['123','456',domain]) };
  const commitments = ['42', note.commitment, '43'], tree = await NoteTree.from(commitments);
  const request: ProvingRequest = { policy: f.policy, note, context: { version: 1, policy: f.policy, root: tree.root, commitments, vault: f.vault, checkedAtBlock: {hash:'block-20',height:20} }, action: {recipient:f.recipient,disclosureRoot:'cd'.repeat(32)} };
  return {...f,request,tree};
}
async function bundleFor(request: ProvingRequest) {
  const witness = await spendWitness(request);
  return createProofBundle(request, {manifestSha256:assets.manifestSha256,setup:'UNSAFE_LOCAL_DEVELOPMENT_ONLY'}, {proof:encodeBrowserProof(proof),public_inputs:witness.publicInputs});
}
async function reseal(bundle: ProofBundle) { const {digest:_,...payload}=bundle; return {...payload,digest:await sha256(canonical(payload))}; }
class FakeWorker extends EventTarget {
  sent: Record<string,unknown>[]=[]; terminated=0;
  postMessage(value: Record<string,unknown>) { this.sent.push(value); }
  terminate() { this.terminated++; }
  emit(value: Record<string,unknown>) { this.dispatchEvent(new MessageEvent('message',{data:{id:this.sent[0].id,...value}})); }
  asWorker() { return this as unknown as Worker; }
}
test.after(shutdownProver);

test('browser Merkle witness and all five public inputs match the existing CLI circuit', async()=>{
  const f=await fixture(), value=await spendWitness(f.request), path=f.tree.path(f.request.note.commitment);
  assert.deepEqual(value.input.siblings,path.siblings); assert.deepEqual(value.input.pathIndices,path.pathIndices);
  const context=contextHash(f.pool,{kind:'withdraw',vault:f.vault,target:f.recipient,disclosureRoot:f.request.action.disclosureRoot});
  assert.deepEqual(value.publicInputs,[await hash(['456',f.request.note.domain]),await hash(['456',context]),f.tree.root,context,f.request.note.domain]);
});
test('missing, duplicate, reordered, malformed or foreign snapshots cannot produce a witness',async()=>{
  const {request}=await fixture();
  for(const change of [{commitments:['42']},{commitments:[request.note.commitment,request.note.commitment]},{commitments:[...request.context.commitments].reverse()},{root:'1'},{policy:{...request.policy,feeRecipient:'other.test.near'}},{vault:'other.test.near'}]) {
    await assert.rejects(()=>spendWitness({...request,context:{...request.context,...change}}));
  }
  assert.throws(()=>parseProvingContext({...request.context,secret:'never-send'},request.policy));
  assert.throws(()=>parseProvingContext({...request.context,commitments:Array(257).fill('1')},request.policy));
  await assert.rejects(()=>spendWitness({...request,note:{...request.note,secret:'999'}}));
});
test('a full 256-output original group still permits an existing-note withdrawal',async()=>{
  const {request}=await fixture(), commitments=[request.note.commitment,...Array.from({length:255},(_,i)=>String(i+1))], tree=await NoteTree.from(commitments);
  const value=await spendWitness({...request,context:{...request.context,commitments,root:tree.root}});
  assert.equal(value.publicInputs[2],tree.root);
});
test('portable proof and raw verification-key encodings match NEAR CLI byte order',async()=>{
  assert.equal(encodeBrowserProof(proof),encodeProof(proof));
  assert.deepEqual(decodeBrowserProof({proof:encodeProof(proof),public_inputs:['1','2','3','4','5']}),proof);
  assert.equal(Buffer.from(encodeVerificationKeyBytes(vk)).toString('base64'),encodeVerificationKey(vk));
  assert.throws(()=>encodeBrowserProof({...proof,pi_a:['-1','2','1']}));
  assert.throws(()=>encodeVerificationKeyBytes({...vk,nPublic:4}));
});
test('committed spend vectors round-trip without changing raw NEAR proof bytes or public inputs',()=>{
  const vector=JSON.parse(readFileSync(new URL('../test-vectors/shared-ft.json',import.meta.url),'utf8'));
  for(const spend of Object.values(vector.proofs) as SpendProof[]){assert.equal(encodeBrowserProof(decodeBrowserProof(spend)),spend.proof);assert.equal(spend.public_inputs[4],vector.domain);}
});
test('independent manifest, all three artifact hashes and policy verifier bytes are mandatory',async()=>{
  const {policy}=await fixture(); await verifyProvingAssets(assets,policy);
  for(const change of [{manifestSha256:'00'.repeat(32)},{wasm:new Blob(['different'])},{zkey:new Blob(['different'])},{verificationKey:new Blob(['{}'])},{wasm:new Blob([])}]) await assert.rejects(()=>verifyProvingAssets({...assets,...change},policy));
  await assert.rejects(()=>verifyProvingAssets(assets,{...policy,verifierSha256:'00'.repeat(32)}));
  await assert.rejects(()=>verifyProvingAssets({...assets,zkey:new Blob([new Uint8Array(16*1024*1024+1)])},policy));
});
test('a self-consistent substituted manifest still needs the independent pinned digest',async()=>{
  const {policy}=await fixture(), parsed=JSON.parse(manifest);parsed.hashes['spend.zkey']=sha('substituted');const substituted=JSON.stringify(parsed);
  await assert.rejects(()=>verifyProvingAssets({...assets,manifest:new Blob([substituted]),zkey:new Blob(['substituted'])},policy),/manifest hash/);
});
test('unsupported manifest depth, protocol or extra asset locations fail even with a valid descriptor hash',async()=>{
  const {policy}=await fixture();
  for(const change of [{depth:9},{protocol:'another-circuit'},{url:'https://untrusted.example'}]){
    const body=JSON.stringify({...JSON.parse(manifest),...change});
    await assert.rejects(()=>verifyProvingAssets({...assets,manifest:new Blob([body]),manifestSha256:sha(body)},policy));
  }
});
test('proof files contain only public values and reject checksum, policy and destination changes',async()=>{
  const {request}=await fixture(), bundle=await bundleFor(request);
  assert.deepEqual(await parseProofBundle(bundle,request.policy),bundle);
  const text=JSON.stringify(bundle); assert.ok(!text.includes('"secret"')); assert.ok(!text.includes('"nullifier"')); assert.ok(!text.includes('siblings'));
  await assert.rejects(()=>parseProofBundle({...bundle,digest:'00'.repeat(32)},request.policy));
  await assert.rejects(()=>parseProofBundle(bundle,{...request.policy,feeRecipient:'other.test.near'}));
  const swapped=await reseal({...bundle,action:{...bundle.action,recipient:'attacker.test.near'}});
  await assert.rejects(()=>parseProofBundle(swapped,request.policy),/bind/);
  const plan=await reseal({...bundle,plan:{...bundle.plan,tokenCall:{...bundle.plan.tokenCall,args:{...bundle.plan.tokenCall.args,amount:'1'}}}});
  await assert.rejects(()=>parseProofBundle(plan,request.policy),/plan/);
});
test('cancellation terminates the real job boundary and ignores a late result',async()=>{
  const {request}=await fixture(), fake=new FakeWorker(), abort=new AbortController(), prover=new BrowserProver(()=>fake.asWorker());
  const job=prover.prove(request,assets,{signal:abort.signal}); abort.abort();
  await assert.rejects(job,{name:'AbortError'}); assert.equal(fake.terminated,1);
  fake.emit({type:'result',bundle:await bundleFor(request),metrics:{elapsedMs:1,witnessMs:0,provingMs:0,verificationMs:0}});
  assert.equal(fake.terminated,1);
});
test('already cancelled calls start no worker and stalled jobs hit a deadline',async()=>{
  const {request}=await fixture(), abort=new AbortController();abort.abort();let created=0;
  const prover=new BrowserProver(()=>{created++;return new FakeWorker().asWorker();});
  await assert.rejects(prover.prove(request,assets,{signal:abort.signal}),{name:'AbortError'});assert.equal(created,0);
  const fake=new FakeWorker();await assert.rejects(new BrowserProver(()=>fake.asWorker()).prove(request,assets,{timeoutMs:5}),{name:'TimeoutError'});assert.equal(fake.terminated,1);
});
test('a signal aborted synchronously during worker construction dispatches no private input',async()=>{
  const {request}=await fixture(), abort=new AbortController(), fake=new FakeWorker();
  const prover=new BrowserProver(()=>{abort.abort();return fake.asWorker();});
  await assert.rejects(prover.prove(request,assets,{signal:abort.signal}),{name:'AbortError'});
  assert.equal(fake.sent.length,0);assert.equal(fake.terminated,1);
});
test('worker crashes, malformed results and substituted recipients cannot export a plan',async()=>{
  const {request}=await fixture();
  for(const fail of ['crash','malformed','substituted']) {
    const fake=new FakeWorker(), job=new BrowserProver(()=>fake.asWorker()).prove(request,assets);
    if(fail==='crash') fake.dispatchEvent(new Event('error'));
    else {const bundle=await bundleFor(fail==='substituted'?{...request,action:{...request.action,recipient:'other.test.near'}}:request);fake.emit({type:'result',bundle,metrics:fail==='malformed'?{}:{elapsedMs:1,witnessMs:0,provingMs:0,verificationMs:0}});}
    await assert.rejects(job);assert.equal(fake.terminated,1);
  }
});
test('success reports stages, closes its worker, and verification preserves the selected file',async()=>{
  const {request}=await fixture(), bundle=await bundleFor(request), fake=new FakeWorker(), stages:string[]=[];
  const job=new BrowserProver(()=>fake.asWorker()).verify(bundle,request.policy,assets,{onProgress:s=>stages.push(s)});
  fake.emit({type:'progress',stage:'verifying'});fake.emit({type:'result',bundle,metrics:{elapsedMs:3,witnessMs:0,provingMs:0,verificationMs:2}});
  assert.deepEqual((await job).bundle,bundle);assert.deepEqual(stages,['verifying']);assert.equal(fake.terminated,1);
});
test('cancellation during asynchronous result validation cannot resolve a late successful proof',async()=>{
  const {request}=await fixture(), bundle=await bundleFor(request), fake=new FakeWorker(), abort=new AbortController();
  const original=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const mock=test.mock.method(crypto.subtle,'digest',async(...args:Parameters<SubtleCrypto['digest']>)=>{entered();await gate;return original(...args);});
  try{
    const job=new BrowserProver(()=>fake.asWorker()).prove(request,assets,{signal:abort.signal});
    fake.emit({type:'result',bundle,metrics:{elapsedMs:1,witnessMs:0,provingMs:0,verificationMs:0}});await started;abort.abort();release();
    await assert.rejects(job,{name:'AbortError'});assert.equal(fake.terminated,1);
  }finally{release();mock.mock.restore();}
});
test('proving-file export verifies before writing and refuses to overwrite an existing directory',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'core-prover-export-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {policy}=await fixture(), source=join(directory,'source'),output=join(directory,'output'),policyFile=join(directory,'policy.json');await mkdir(join(source,'spend_js'),{recursive:true});
  for(const [name,value] of Object.entries({'manifest.json':manifest,'spend_js/spend.wasm':wasm,'spend.zkey':zkey,'verification_key.json':keyBytes}))await writeFile(join(source,name),value);
  await writeFile(policyFile,JSON.stringify(policy));
  const run=(pin:string,dest=output)=>execFileSync(process.execPath,['--import','tsx','scripts/prover-assets.ts',source,pin,policyFile,dest],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.throws(()=>run('00'.repeat(32)));assert.ok(!(await readdir(directory)).includes('output'));
  const result=JSON.parse(run(assets.manifestSha256));assert.equal(result.manifestSha256,assets.manifestSha256);
  assert.deepEqual((await readdir(output)).sort(),['README.txt','manifest.json','spend.wasm','spend.zkey','verification_key.json']);
  assert.throws(()=>run(assets.manifestSha256));assert.equal(readFileSync(join(output,'manifest.json'),'utf8'),manifest);
});
test('public proving context pins ordered commitments and payout eligibility to one final block',async()=>{
  const f=await fixture();f.config.root=f.tree.root;f.config.leaf_count=f.tree.leaves.length;
  const original=f.source.commitments;f.source.commitments=async b=>{await original(b);return f.tree.leaves;};
  const value=await provingContext(f.source,f.policy,{vault:f.vault});
  assert.equal(value.root,f.tree.root);assert.deepEqual(value.commitments,f.tree.leaves);assert.equal(f.state.snapshots,1);
  assert.ok(f.reads.every(r=>r.block==='block-20'));assert.ok(!JSON.stringify(value).includes('secret'));
  f.local.available_notes=0;await assert.rejects(()=>provingContext(f.source,f.policy,{vault:f.vault}));
});
test('public context rejects incomplete or substituted trees, native assets and unknown vaults',async()=>{
  const f=await fixture();await assert.rejects(()=>provingContext(f.source,f.policy,{vault:f.vault}));
  const native=operationsFixture(true);await assert.rejects(()=>provingContext(native.source,native.policy,{vault:native.vault}),/FT/);
  await assert.rejects(()=>provingContext(f.source,f.policy,{vault:'other.test.near'}));
});
test('HTTP context accepts only a public vault; secrets and request-controlled RPCs are rejected',async t=>{
  const f=await fixture();f.config.root=f.tree.root;f.config.leaf_count=f.tree.leaves.length;f.source.commitments=async()=>f.tree.leaves;
  const server=createReadOnlyApi({source:f.source,policy:f.policy,allowedOrigins:['http://localhost:3000']});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const url=`http://127.0.0.1:${addr.port}`, post=(value:unknown)=>fetch(url+'/v1/proofs/context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const response=await post({vault:f.vault});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).root,f.tree.root);
  for(const extra of [{note:f.request.note},{secret:'private'},{rpcUrl:'http://internal'}]) assert.equal((await post({vault:f.vault,...extra})).status,400);
  const context=await new HttpGateway(url).provingContext(f.policy,f.vault);assert.equal(context.vault,f.vault);
});
