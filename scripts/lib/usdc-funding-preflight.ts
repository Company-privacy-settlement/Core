import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { z } from 'zod';
import { USDC, quoteFtFees } from '../../sdk/ft.js';
import { AccountId, Atomic, Count, Sha256 } from '../../sdk/validation.js';

const RpcUrl = z.string().max(1024).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !['localhost','127.0.0.1','[::1]'].includes(u.hostname); } catch { return false; }
}, 'Use an explicitly selected HTTPS RPC without credentials');
const TestAccount = AccountId.refine(value => value.endsWith('.testnet') || /^[a-f0-9]{64}$/.test(value), 'Use a testnet or implicit account');
export const UsdcFundingInput = z.object({
  format: z.literal('core-usdc-funding-input-v1'), rpcUrl: RpcUrl, payer: TestAccount,
  denomination: Atomic.refine(value => BigInt(value) > 0n),
  depositCount: z.number().int().min(2).max(16).default(2),
  gasReserveYoctoNear: Atomic.refine(value => BigInt(value) > 0n),
  tokenCodeSha256: Sha256.optional(),
}).strict();
export type FundingInput = z.input<typeof UsdcFundingInput>;
export type PublicRpc = (method: 'status' | 'block' | 'query' | 'EXPERIMENTAL_protocol_config', params: unknown) => Promise<any>;
const Hash = z.string().refine(value => { try { return bs58.decode(value).length === 32 && bs58.encode(bs58.decode(value)) === value; } catch { return false; } });
const Block = z.object({ header: z.object({ height: Count, hash: Hash, timestamp_nanosec: z.string().regex(/^\d{1,20}$/) }) });
const Status = z.object({ chain_id: z.literal('testnet'), sync_info: z.object({ syncing: z.literal(false), latest_block_height: Count, latest_block_time: z.string().datetime({offset:true}) }) });
const Account = z.object({ amount: Atomic, locked: Atomic, code_hash: Hash, storage_usage: Count });
function demand(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function fresh(milliseconds: number, now: number) { return Number.isFinite(milliseconds) && now-milliseconds <= 120000 && milliseconds-now <= 30000; }
function resultHash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function decoded(value: any) {
  demand(Array.isArray(value?.result) && value.result.length <= 16384 && value.result.every((n: unknown) => Number.isInteger(n) && Number(n)>=0 && Number(n)<=255), 'INVALID_VIEW_RESULT');
  return JSON.parse(Buffer.from(value.result).toString('utf8')) as unknown;
}
export function loadUsdcFundingInput(file: string): FundingInput {
  const stat=lstatSync(file); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192,'BOUNDED_CONFIG_REQUIRED');
  return UsdcFundingInput.parse(JSON.parse(readFileSync(file,'utf8')));
}
export function publicUsdcRpc(url: string, transport: typeof fetch = fetch): PublicRpc {
  RpcUrl.parse(url);
  return async (method,params) => {
    demand(['status','block','query','EXPERIMENTAL_protocol_config'].includes(method),'READ_ONLY_RPC_REQUIRED');
    const r=await transport(url,{method:'POST',redirect:'error',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'core-usdc-funding',method,params}),signal:AbortSignal.timeout(15000)});
    demand(r.ok,'RPC_HTTP_FAILURE');
    const reader=r.body?.getReader(); demand(reader,'RPC_BODY_REQUIRED');
    const chunks:Uint8Array[]=[];let size=0;
    try { for (;;) { const item=await reader.read();if(item.done)break;size+=item.value.length;demand(size<=262144,'RPC_RESPONSE_TOO_LARGE');chunks.push(item.value); } }
    finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));demand(body?.jsonrpc==='2.0'&&body.id==='core-usdc-funding'&&!body.error&&body.result!==undefined,'RPC_READ_FAILED');return body.result;
  };
}
export async function inspectUsdcFunding(input: FundingInput, rpc?: PublicRpc, now=Date.now()) {
  const c=UsdcFundingInput.parse(input), read=rpc??publicUsdcRpc(c.rpcUrl), quote=quoteFtFees(c.denomination);
  // Two notes cover an invoice withdrawal and a separately failed/recovered withdrawal.
  const count=BigInt(c.depositCount),required=(BigInt(quote.depositTransferTokens)+BigInt(quote.withdrawalFeeTransferTokens))*count;
  demand(required < 1n<<128n,'TOTAL_EXCEEDS_U128');
  const status=Status.parse(await read('status',[]));demand(fresh(Date.parse(status.sync_info.latest_block_time),now),'STALE_RPC_HEAD');
  const final=Block.parse(await read('block',{finality:'final'})),snapshot=final.header;
  demand(snapshot.height<=status.sync_info.latest_block_height && status.sync_info.latest_block_height-snapshot.height<=10,'FINAL_BLOCK_LAG');
  demand(fresh(Number(BigInt(snapshot.timestamp_nanosec)/1000000n),now),'STALE_FINAL_BLOCK');
  const canonical=Block.parse(await read('block',{block_id:snapshot.hash}));demand(canonical.header.hash===snapshot.hash&&canonical.header.height===snapshot.height&&canonical.header.timestamp_nanosec===snapshot.timestamp_nanosec,'FINAL_SNAPSHOT_MISMATCH');
  async function query(account: string, request: Record<string,unknown>) {
    const value=await read('query',{...request,account_id:account,block_id:snapshot.hash});
    demand(value?.block_hash===snapshot.hash&&value.block_height===snapshot.height,'QUERY_SNAPSHOT_MISMATCH');return value;
  }
  const token=Account.parse(await query(USDC.testnet,{request_type:'view_account'})),payer=Account.parse(await query(c.payer,{request_type:'view_account'}));
  demand(token.code_hash!=='11111111111111111111111111111111','TOKEN_CODE_MISSING');
  const tokenCodeSha256=Buffer.from(bs58.decode(token.code_hash)).toString('hex');
  const view=async(method_name:string,args:unknown)=>decoded(await query(USDC.testnet,{request_type:'call_function',method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}));
  const metadata=z.object({spec:z.literal('ft-1.0.0'),name:z.literal('USDC'),symbol:z.literal('USDC'),decimals:z.literal(6)}).passthrough().parse(await view('ft_metadata',{}));
  const balance=Atomic.parse(await view('ft_balance_of',{account_id:c.payer}));
  const storage=z.object({total:Atomic,available:Atomic}).nullable().parse(await view('storage_balance_of',{account_id:c.payer}));
  if(storage)demand(BigInt(storage.total)>0n&&BigInt(storage.available)<=BigInt(storage.total),'INVALID_STORAGE_BALANCE');
  const storageBounds=z.object({min:Atomic,max:Atomic.nullable()}).parse(await view('storage_balance_bounds',{}));
  demand(BigInt(storageBounds.min)>0n&&(storageBounds.max===null||BigInt(storageBounds.max)>=BigInt(storageBounds.min)),'INVALID_STORAGE_BOUNDS');
  if(storage)demand(BigInt(storage.total)>=BigInt(storageBounds.min),'REGISTRATION_BELOW_MINIMUM');
  const blockers:string[]=[];
  if(!c.tokenCodeSha256)blockers.push('TOKEN_CODE_REVIEW_REQUIRED');else if(c.tokenCodeSha256!==tokenCodeSha256)blockers.push('TOKEN_CODE_HASH_MISMATCH');
  if(storage===null)blockers.push('PAYER_USDC_REGISTRATION_REQUIRED');
  if(BigInt(balance)<required)blockers.push('PAYER_USDC_FUNDING_REQUIRED');
  const protocol=z.object({runtime_config:z.object({storage_amount_per_byte:Atomic.refine(v=>BigInt(v)>0n)})}).parse(await read('EXPERIMENTAL_protocol_config',{block_id:snapshot.hash}));
  const stake=BigInt(payer.storage_usage)*BigInt(protocol.runtime_config.storage_amount_per_byte);
  const spendable=BigInt(payer.amount)>stake?BigInt(payer.amount)-stake:0n;
  if(spendable<BigInt(c.gasReserveYoctoNear))blockers.push('PAYER_NEAR_RESERVE_REQUIRED');
  return {format:'core-usdc-funding-preflight-v1',checkedAt:new Date(now).toISOString(),network:'testnet',fundingReady:blockers.length===0,
    rpcUrl:c.rpcUrl,snapshot:{height:snapshot.height,hash:snapshot.hash,timestampNanosec:snapshot.timestamp_nanosec},
    token:{accountId:USDC.testnet,source:USDC.source,metadata:{spec:metadata.spec,name:metadata.name,symbol:metadata.symbol,decimals:metadata.decimals},observedCodeSha256:tokenCodeSha256,codeReviewMatched:!!c.tokenCodeSha256&&c.tokenCodeSha256===tokenCodeSha256},
    payer:{accountId:c.payer,usdcAtomic:balance,nearGrossYoctoNear:payer.amount,storageStakeYoctoNear:stake.toString(),nearSpendableYoctoNear:spendable.toString(),storage},
    requirement:{notes:c.depositCount,principalPerNoteAtomic:c.denomination,depositPerNoteAtomic:quote.depositTransferTokens,withdrawalFeePerNoteAtomic:quote.withdrawalFeeTransferTokens,totalUsdcAtomic:required.toString(),minimumTokenRegistrationYoctoNear:storageBounds.min,nearReserveYoctoNear:c.gasReserveYoctoNear},
    blockers,inputSha256:resultHash(c),
    claims:{readOnly:true,browserWalletVerified:false,depositsVerified:false,proofVerified:false,invoicePaymentVerified:false,withdrawalVerified:false,recoveryVerified:false,usdcSettlementVerified:false},
    assurance:'Funding preflight only. All reads target one fresh FINAL testnet snapshot; provider responses are not light-client proofs. The NEAR reserve excludes current account storage stake, but does not establish funding for new group deployment, registration or other provisioning costs. Independently reviewed deployed FT policy, API/indexer, proving files and actual browser-wallet execution remain separate gates.'};
}
