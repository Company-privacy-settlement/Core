import assert from 'node:assert/strict';
import { test } from 'node:test';
import bs58 from 'bs58';
import { inspectUsdcFunding, publicUsdcRpc, UsdcFundingInput, type FundingInput, type PublicRpc } from '../scripts/lib/usdc-funding-preflight.js';
import { USDC } from '../sdk/ft.js';
const now=Date.parse('2026-11-14T08:00:00Z'),hash=bs58.encode(new Uint8Array(32).fill(1)),code=bs58.encode(new Uint8Array(32).fill(2));
function fixture(){
 const input:FundingInput={format:'core-usdc-funding-input-v1',rpcUrl:'https://test.rpc.fastnear.com',payer:'payer.testnet',denomination:'1000000',depositCount:2,gasReserveYoctoNear:'100000000000000000000000',tokenCodeSha256:'02'.repeat(32)};
 const state={chain:'testnet',syncing:false,age:0,future:0,finalLag:2,finalAge:0,canonicalHash:hash,metadataSymbol:'USDC',decimals:6,balance:'2006000',storage:true,available:'0',storageTotal:'1250000000000000000000',near:'1000000000000000000000000',usage:200,protocolStorage:'10000000000000000000',resultSnapshot:hash};
 const requests:{method:string;params:any}[]=[];
 const read:PublicRpc=async(method,params:any)=>{requests.push({method,params});
  if(method==='status')return{chain_id:state.chain,sync_info:{syncing:state.syncing,latest_block_height:100,latest_block_time:new Date(now-state.age+state.future).toISOString()}};
  if(method==='block')return{header:{height:100-state.finalLag,hash:params.block_id?state.canonicalHash:hash,timestamp_nanosec:String(BigInt(now-state.finalAge)*1000000n)}};
  if(method==='EXPERIMENTAL_protocol_config')return{runtime_config:{storage_amount_per_byte:state.protocolStorage}};
  const base={block_hash:state.resultSnapshot,block_height:100-state.finalLag};
  if(params.request_type==='view_account')return{...base,amount:state.near,locked:'0',code_hash:params.account_id===USDC.testnet?code:'11111111111111111111111111111111',storage_usage:state.usage};
  const values:Record<string,unknown>={ft_metadata:{spec:'ft-1.0.0',name:'USDC',symbol:state.metadataSymbol,decimals:state.decimals},ft_balance_of:state.balance,storage_balance_of:state.storage?{total:state.storageTotal,available:state.available}:null,storage_balance_bounds:{min:'1250000000000000000000',max:null}};
  return{...base,result:[...Buffer.from(JSON.stringify(values[params.method_name]))]};
 };
 return{input,state,requests,run:()=>inspectUsdcFunding(input,read,now)};
}
test('funding-only pass pins official USDC and one fresh snapshot without claiming any executed flow',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.fundingReady,true);assert.deepEqual(r.blockers,[]);assert.equal(r.requirement.totalUsdcAtomic,'2006000');assert.equal(r.payer.nearSpendableYoctoNear,'998000000000000000000000');assert.equal(r.token.accountId,USDC.testnet);
 for(const [name,value]of Object.entries(r.claims))assert.equal(value,name==='readOnly');
 for(const q of f.requests.filter(q=>q.method==='query'||q.method==='EXPERIMENTAL_protocol_config'))assert.equal(q.params.block_id,hash);
 assert.ok(f.requests.every(q=>['status','block','query','EXPERIMENTAL_protocol_config'].includes(q.method)));
});
test('funding blockers retain exact added-fee requirement and independently reviewed code requirement',async()=>{
 const f=fixture();delete f.input.tokenCodeSha256;f.state.balance='2005999';f.state.storage=false;f.state.near='0';const r=await f.run();
 assert.equal(r.fundingReady,false);assert.deepEqual(r.blockers,['TOKEN_CODE_REVIEW_REQUIRED','PAYER_USDC_REGISTRATION_REQUIRED','PAYER_USDC_FUNDING_REQUIRED','PAYER_NEAR_RESERVE_REQUIRED']);
 assert.equal(r.requirement.depositPerNoteAtomic,'1001500');assert.equal(r.requirement.withdrawalFeePerNoteAtomic,'1500');
 const other=fixture();other.input.tokenCodeSha256='03'.repeat(32);assert.deepEqual((await other.run()).blockers,['TOKEN_CODE_HASH_MISMATCH']);
});
test('NEAR balance after storage stake, rather than gross balance, gates the requested reserve',async()=>{
 const f=fixture();f.state.near='101000000000000000000000';const r=await f.run();assert.ok(r.blockers.includes('PAYER_NEAR_RESERVE_REQUIRED'));
});
test('wrong chain, syncing, stale/future head, stale/future final and snapshot mismatch fail closed',async()=>{
 const mutations=[(f:ReturnType<typeof fixture>)=>{f.state.chain='mainnet';},(f:ReturnType<typeof fixture>)=>{f.state.syncing=true;},(f:ReturnType<typeof fixture>)=>{f.state.age=120001;},(f:ReturnType<typeof fixture>)=>{f.state.future=30001;},(f:ReturnType<typeof fixture>)=>{f.state.finalLag=11;},(f:ReturnType<typeof fixture>)=>{f.state.finalAge=120001;},(f:ReturnType<typeof fixture>)=>{f.state.finalAge=-30001;},(f:ReturnType<typeof fixture>)=>{f.state.canonicalHash=code;},(f:ReturnType<typeof fixture>)=>{f.state.resultSnapshot=code;}];
 for(const change of mutations){const f=fixture();change(f);await assert.rejects(f.run);}
});
test('malformed token metadata, atomic values and registration records are rejected',async()=>{
 for(const [key,value]of [['metadataSymbol','TESTUSD'],['decimals',18],['balance','-1'],['balance','1.5'],['storageTotal','0'],['storageTotal','1'],['available','1250000000000000000001'],['protocolStorage','0']] as const){const f=fixture();Object.assign(f.state,{[key]:value});await assert.rejects(f.run);}
});
test('input rejects secret-bearing fields, mainnet names, insecure RPC and excessive/zero funding quantities',async()=>{
 const f=fixture();for(const value of [{...f.input,privateKey:'never accepted'},{...f.input,payer:'payer.near'},{...f.input,rpcUrl:'http://example.test'},{...f.input,rpcUrl:'https://u:p@example.test'},{...f.input,rpcUrl:'https://example.test/?key=secret'},{...f.input,depositCount:17},{...f.input,denomination:'0'},{...f.input,gasReserveYoctoNear:'0'}])assert.equal(UsdcFundingInput.safeParse(value).success,false);
 const overflow=fixture();overflow.input.denomination=((1n<<128n)-1n).toString();await assert.rejects(overflow.run);
});
test('RPC adapter rejects redirects, errors, huge bodies and non-read calls without exposing server details',async()=>{
 const seen:RequestInit[]=[];const transport=(async(_url:any,init:RequestInit)=>{seen.push(init);return new Response(JSON.stringify({jsonrpc:'2.0',id:'core-usdc-funding',result:{ok:true}}));}) as typeof fetch;
 const read=publicUsdcRpc(fixture().input.rpcUrl,transport);assert.deepEqual(await read('status',[]),{ok:true});assert.equal(seen[0].redirect,'error');assert.equal(seen[0].credentials,'omit');
 await assert.rejects(()=>read('send_tx' as any,{}));assert.equal(seen.length,1);
 for(const response of [new Response('no',{status:429}),new Response(JSON.stringify({jsonrpc:'2.0',id:'core-usdc-funding',error:{message:'private server details'}})),new Response('x'.repeat(262145))])await assert.rejects(()=>publicUsdcRpc(fixture().input.rpcUrl,(async()=>response) as typeof fetch)('status',[]));
});
