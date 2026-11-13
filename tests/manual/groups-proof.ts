// Local JSON-RPC fixture + real Groth16 CLI validation. No transaction is broadcast.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNote, NoteTree, sha256, domain, contextHash } from '../../sdk/core.js';
import { encryptPrivate } from '../../sdk/disclosure.js';
import { groupPool } from '../../sdk/groups.js';
import { groupFixture, groupDirectory } from '../fixtures/groups.js';
const old = groupFixture('old'), next = groupFixture('next');
const registryCode = Buffer.from('registry-code'), vaultCode = Buffer.from('vault-code');
for (const f of [old, next]) {
 f.policy.registryWasmSha256 = sha256(registryCode); f.policy.vaultWasmSha256 = sha256(vaultCode); f.config.vault_wasm_sha256 = f.policy.vaultWasmSha256;
}
old.group.depositsEnabled = false;
const note = await createNote(groupPool(old.group));
const leaves = [note.commitment, ...Array.from({length:255}, (_,i)=>String(i+1))];
const tree = await NoteTree.from(leaves);
old.config.root = tree.root; old.config.leaf_count = 256; old.config.outstanding_notes = 1;
const { directory } = groupDirectory(old, next), queried = new Set<string>();
const server = createServer(async (req,res) => {
 try {
  let raw = ''; for await(const chunk of req) raw += chunk;
  const { id, method, params:p } = JSON.parse(raw); let result:unknown;
  if(method==='block') result={header:{hash:'groups-final-block'}};
  else {
   queried.add(p.account_id); assert.ok([old.policy.registry, old.vault].includes(p.account_id));
   if(p.request_type==='view_code') result={code_base64:(p.account_id===old.policy.registry?registryCode:vaultCode).toString('base64')};
   else if(p.request_type==='view_access_key_list') result={keys:[]};
   else {
    const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString()); let value:unknown;
    if(p.method_name==='get_config') value=p.account_id===old.policy.registry?old.config:old.local;
    else if(p.method_name==='get_vault') value=args.account_id===old.vault?old.record:null;
    else if(p.method_name==='list_vaults') value=[old.record].slice(args.from_index,args.from_index+args.limit);
    else if(p.method_name==='get_commitments') value=leaves;
    else throw Error('Unexpected method');
    result={result:[...Buffer.from(JSON.stringify(value))]};
   }
  }
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({jsonrpc:'2.0',id,result}));
 } catch(e) {res.statusCode=500;res.end(String(e));}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert.ok(address&&typeof address!=='string');
const dir=await mkdtemp(join(tmpdir(),'core-group-proof-')), password='group proof local smoke password';
try {
 const policyFile=join(dir,'groups.json'), noteFile=join(dir,'note.encrypted.json'), actionFile=join(dir,'action.json'), outputFile=join(dir,'plan.json');
 const action={kind:'withdraw' as const,vault:old.vault,target:old.recipient,disclosureRoot:'ab'.repeat(32)};
 await writeFile(policyFile,JSON.stringify(directory));await writeFile(noteFile,encryptPrivate(note,password),{mode:0o600});await writeFile(actionFile,JSON.stringify(action));
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','scripts/cli.ts','group-spend-args',policyFile,`http://127.0.0.1:${address.port}`,noteFile,actionFile,outputFile],{env:{...process.env,CORE_NOTE_PASSWORD:password},timeout:120000});
 const metadata=JSON.parse(stdout), plan=JSON.parse(await readFile(outputFile,'utf8')), msg=JSON.parse(plan.tokenCall.args.msg);
 assert.equal(metadata.groupId,'old');assert.equal(plan.tokenCall.args.receiver_id,old.policy.registry);assert.equal(plan.tokenCall.args.amount,'1500');
 assert.equal(msg.recipient,old.recipient);assert.equal(msg.vault,old.vault);assert.equal(msg.public_inputs[2],tree.root);assert.equal(msg.public_inputs[3],contextHash(groupPool(old.group),action));assert.equal(msg.public_inputs[4],domain(groupPool(old.group)));assert.equal(Buffer.from(msg.proof,'base64').length,256);
 assert.ok(!JSON.stringify(plan).includes(note.secret));
 const report={realGroth16:true,fixtureRpc:true,chainExecution:false,fullTreeOutputs:256,depositsEnabled:false,groupId:metadata.groupId,registry:old.policy.registry,payoutVault:msg.vault,recipient:msg.recipient,principalTokens:plan.quote.recipientTokens,feeTokens:plan.tokenCall.args.amount,queried:[...queried]};
 await mkdir('demo-output',{recursive:true});await writeFile('demo-output/groups-proof-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
