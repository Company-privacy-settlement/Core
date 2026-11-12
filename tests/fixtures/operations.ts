import { domain, quoteFees, STORAGE_FEE, type Pool } from '../../sdk/core.js';
import { predictSharedVault, type SharedPolicy } from '../../sdk/shared.js';
import type { OperationsSource } from '../../sdk/operations.js';
export function operationsFixture(native = false) {
  const policy: SharedPolicy = { network: 'sandbox', registry: 'forest.test.near', denomination: native ? (10n**24n).toString() : '1000000', feeRecipient: 'treasury.test.near', registryWasmSha256: 'aa'.repeat(32), vaultWasmSha256: 'bb'.repeat(32), verifierSha256: 'cc'.repeat(32), ...(native ? {} : { tokenId: 'usdc.test.near' }) };
  const pool: Pool = native ? { network:policy.network,contract:policy.registry,denomination:policy.denomination,version:2 } : { network:policy.network,contract:policy.registry,denomination:policy.denomination,version:3,tokenId:policy.tokenId! };
  const vault = predictSharedVault(policy.registry,'alice.test.near','ab'.repeat(32)), payer = 'alice.test.near', recipient = 'receiver.test.near';
  const q = quoteFees(policy.denomination);
  const config = { protocol: native ? 'core-shared-registry-v2' : 'core-shared-ft-registry-v3', network:policy.network, denomination:policy.denomination, asset_token_id:policy.tokenId??null,
    deposit_token_amount:native?null:(BigInt(policy.denomination)+BigInt(q.depositProtocolFee)).toString(), withdrawal_token_fee:native?null:q.withdrawalProtocolFee, storage_credit_bond:'5000000000000000000000', fee_recipient:policy.feeRecipient,
    deposit_fee_bps:15,withdrawal_fee_bps:15,deposit_attached:native?q.depositAttached:STORAGE_FEE.toString(),withdrawal_attached:native?q.withdrawalAttached:STORAGE_FEE.toString(),withdrawal_received:policy.denomination,storage_fee:STORAGE_FEE.toString(),
    vault_wasm_sha256:policy.vaultWasmSha256,verifier_sha256:policy.verifierSha256,vault_count:1,creation_deposit:'450',vault_funding:'400',registration_fee:'50',domain:domain(pool),root:'1',leaf_count:2,capacity:256,outstanding_notes:2 };
  const local = { protocol:native?'core-shared-vault-v2':'core-shared-ft-vault-v3',registry:policy.registry,network:policy.network,denomination:policy.denomination,asset_token_id:policy.tokenId??null,deposit_token_amount:config.deposit_token_amount,storage_credit_bond:config.storage_credit_bond,
    fee_recipient:policy.feeRecipient,deposit_fee_bps:15,withdrawal_fee_bps:15,storage_fee:STORAGE_FEE.toString(),deposit_attached:config.deposit_attached,withdrawal_received:policy.denomination,available_notes:1,reserved_notes:0,pending_deposits:0,held_notes:1 };
  const record = { index:0, account_id:vault,state:'Ready',available_notes:1,reserved_notes:0 };
  const registrations = new Set([payer]); const missingAccounts = new Set<string>();
  const credits = new Map<string,{available:string;in_flight:string}>();
  const state: { height:number; balance:string; deposit:unknown; withdrawal:unknown; snapshots:number; onSnapshot?:()=>void } = { height:20,balance:'2000000',deposit:null,withdrawal:null,snapshots:0 };
  const reads: {method:string;account?:string;block:string}[]=[];
  const seen=(method:string,block:string,account?:string) => reads.push({method,account,block});
  const source: OperationsSource = {
    network:policy.network,factory:policy.registry,
    finalBlock:async()=>{ state.snapshots++;state.onSnapshot?.();return {hash:`block-${state.height}`,height:state.height}; },
    finalizedBlock:async()=>{throw new Error('Operations must pin one final block');},
    config:async b=>{seen('get_config',b,policy.registry);return config;},
    records:async(from,limit,b)=>{seen('list_vaults',b);return from===record.index&&limit===1?[record]:[];},
    vaultConfig:async(a,b)=>{seen('get_config',b,a);return local;},
    codeSha256:async(a,b)=>{seen('view_code',b,a);return a===policy.registry?policy.registryWasmSha256:policy.vaultWasmSha256;},
    accessKeys:async(a,b)=>{seen('keys',b,a);return [];},
    commitments:async b=>{seen('commitments',b);return [];},
    account:async(a,b)=>{seen('view_account',b,a);return missingAccounts.has(a)?null:{amount:'20000000000000000000000000',locked:'0',storage_usage:100};},
    contractView:async(a,m,args,b)=>{
      seen(m,b,a);
      if(m==='get_vault') return args.account_id===vault?record:null;
      if(m==='ft_metadata')return {spec:'ft-1.0.0',name:'Sandbox dollar',symbol:'USDC',decimals:6};
      if(m==='storage_balance_bounds')return {min:'1250000000000000000000',max:'1250000000000000000000'};
      if(m==='ft_balance_of')return state.balance;
      if(m==='storage_balance_of')return registrations.has(args.account_id as string)?{total:'1250000000000000000000',available:'0'}:null;
      if(m==='get_storage_credit')return credits.get(`${a}|${args.account_id}`)??null;
      if(m==='get_deposit')return state.deposit;
      if(m==='get_withdrawal')return state.withdrawal;
      throw new Error(`Unexpected read: ${m}`);
    },
  };
  return {policy,pool,vault,payer,recipient,config,local,record,source,registrations,credits,missingAccounts,state,reads};
}
