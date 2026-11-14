import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,lstatSync} from 'node:fs';
import {canonical} from '../../sdk/client/crypto.js';
import {RelayRequest,RelayLimits,relayRequestId,type RelayWithdrawal,type Limits} from './protocol.js';
import type{ContractCall}from'../../sdk/ft.js';
import {Timing, controlDigest, sameControl, sampleReady, schedulingConfig, type TimingChoice, type Schedule} from './scheduling.js';
export type Prepared={hash:string;unsignedTransaction:string};
export type Execution={id:number;requestId:string;sequence:number;kind:'withdraw'|'retry';state:string;call:ContractCall;prepared:Prepared|null};
export class RelayStore{
 private db:DatabaseSync;readonly limits:ReturnType<typeof RelayLimits.parse>;
 constructor(file:string,identity:unknown,limits:Limits){
  this.limits=RelayLimits.parse(limits);
  if(file!==':memory:'){try{closeSync(openSync(file,'wx',0o600));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==(process.getuid?.()??s.uid))throw Error('RELAY_PRIVATE_JOURNAL_REQUIRED');}
  this.db=new DatabaseSync(file);try{this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
   const tables=this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();if(tables.length&&!tables.some(t=>t.name==='relay_identity'))throw Error('RELAY_UNRELATED_DATABASE');
   this.db.exec(`CREATE TABLE IF NOT EXISTS relay_identity(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS relay_requests(id TEXT PRIMARY KEY,nullifier TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS relay_executions(id INTEGER PRIMARY KEY,request_id TEXT NOT NULL REFERENCES relay_requests(id),sequence INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,call TEXT NOT NULL,prepared TEXT,near_budget TEXT NOT NULL,token_budget TEXT NOT NULL,UNIQUE(request_id,sequence));`);
   this.db.exec(`CREATE TABLE IF NOT EXISTS relay_schedules(request_id TEXT PRIMARY KEY REFERENCES relay_requests(id),body TEXT NOT NULL,control_digest TEXT NOT NULL);`);
   const body=canonical({format:'core-relay-journal-v1',identity,limits:this.limits}),old=this.db.prepare('SELECT body FROM relay_identity WHERE id=1').get();if(old&&old.body!==body)throw Error('RELAY_JOURNAL_IDENTITY_MISMATCH');this.db.prepare('INSERT OR IGNORE INTO relay_identity VALUES(1,?)').run(body);
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 private transaction<T>(f:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const r=f();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 request(id:string):RelayWithdrawal|null{const row=this.db.prepare('SELECT * FROM relay_requests WHERE id=?').get(id);if(!row)return null;const value=RelayRequest.parse(JSON.parse(String(row.body)));if(relayRequestId(value)!==id||value.spend.public_inputs[0]!==row.nullifier)throw Error('RELAY_JOURNAL_CORRUPT');return value;}
 existing(request:RelayWithdrawal){const row=this.db.prepare('SELECT id FROM relay_requests WHERE nullifier=?').get(request.spend.public_inputs[0]);if(!row)return null;if(row.id!==relayRequestId(request))throw Error('RELAY_NULLIFIER_CONFLICT');this.request(String(row.id));return String(row.id);}
 executions(id:string):Execution[]{return this.db.prepare('SELECT * FROM relay_executions WHERE request_id=? ORDER BY sequence').all(id).map(r=>({id:Number(r.id),requestId:String(r.request_id),sequence:Number(r.sequence),kind:r.kind as Execution['kind'],state:String(r.state),call:JSON.parse(String(r.call)),prepared:r.prepared?JSON.parse(String(r.prepared)):null}));}
 schedule(id:string,now=Date.now()):Schedule|null {const s=this.rawSchedule(id);if(s&&(s.state==='waiting'||s.state==='blocked')&&now>=s.expiresAt){const expired:Schedule={...s,state:'expired',error:null};const result=this.db.prepare('UPDATE relay_schedules SET body=? WHERE request_id=? AND body=?').run(canonical(expired),id,canonical(s));return result.changes===1?expired:this.schedule(id,now);}return s;}
 private rawSchedule(id:string):Schedule|null {const row=this.db.prepare('SELECT body FROM relay_schedules WHERE request_id=?').get(id);return row?JSON.parse(String(row.body)):null;}
 private writeSchedule(s:Schedule){this.db.prepare('UPDATE relay_schedules SET body=? WHERE request_id=?').run(canonical(s),s.requestId);}
 private authorize(id:string,token:string){const row=this.db.prepare('SELECT control_digest FROM relay_schedules WHERE request_id=?').get(id);if(!row||!sameControl(token,String(row.control_digest)))throw Error('RELAY_SCHEDULE_CONTROL_DENIED');}
 enqueue(request:RelayWithdrawal,timing:TimingChoice,token:string,now:number){return this.transaction(()=>{
  timing=Timing.parse(timing);const digest=controlDigest(token),id=relayRequestId(request),known=this.existing(request);
  if(known){this.authorize(id,token);return this.schedule(id,now)!;}
  const rows=this.db.prepare('SELECT request_id FROM relay_schedules').all();
  if(rows.length>=schedulingConfig.maxRecords||rows.filter(r=>['waiting','blocked'].includes(this.schedule(String(r.request_id),now)!.state)).length>=schedulingConfig.maxPending)throw Error('RELAY_QUEUE_FULL');
  this.db.prepare('INSERT INTO relay_requests VALUES(?,?,?)').run(id,request.spend.public_inputs[0],canonical(request));
  const s:Schedule={requestId:id,revision:1,state:'waiting',createdAt:now,readyAt:sampleReady(now,timing),expiresAt:now+timing.expiresInSeconds*1000,timing,error:null};
  this.db.prepare('INSERT INTO relay_schedules VALUES(?,?,?)').run(id,canonical(s),digest);return s;
 });}
 control(id:string,token:string,revision:number,action:'cancel'|'resume'|'reschedule',now:number,timing?:TimingChoice){return this.transaction(()=>{
  this.authorize(id,token);const s=this.schedule(id,now)!;
  if(s.revision!==revision)throw Error('RELAY_SCHEDULE_REVISION_CHANGED');
  if(s.state==='executing'||this.executions(id).length)throw Error('RELAY_EXECUTION_ALREADY_STARTED');
  if(action==='cancel'){if(s.state==='waiting'||s.state==='blocked')this.writeSchedule({...s,state:'cancelled',error:null});}
  else if(action==='resume'){if(s.state!=='blocked')throw Error('RELAY_SCHEDULE_NOT_BLOCKED');this.writeSchedule({...s,state:'waiting',error:null});}
  else {
   if(!['cancelled','expired'].includes(s.state)||s.revision>schedulingConfig.maxReschedules)throw Error('RELAY_RESCHEDULE_NOT_AVAILABLE');
   const t=Timing.parse(timing),pending=this.db.prepare('SELECT request_id FROM relay_schedules').all().filter(r=>['waiting','blocked'].includes(this.schedule(String(r.request_id),now)!.state));
   if(pending.length>=schedulingConfig.maxPending)throw Error('RELAY_QUEUE_FULL');
   this.writeSchedule({...s,revision:s.revision+1,state:'waiting',createdAt:now,readyAt:sampleReady(now,t),expiresAt:now+t.expiresInSeconds*1000,timing:t,error:null});
  }
  return this.schedule(id,now)!;
 });}
 ready(now:number){return this.db.prepare('SELECT request_id FROM relay_schedules').all().map(r=>this.schedule(String(r.request_id),now)!).filter(s=>s.state==='waiting'&&s.readyAt<=now);}
 block(id:string,error:string,now:number,revision:number){this.transaction(()=>{const s=this.schedule(id,now);if(s?.state==='waiting'&&s.revision===revision)this.writeSchedule({...s,state:'blocked',error});});}
 unresolved(){return !!this.db.prepare("SELECT id FROM relay_executions WHERE state!='final' LIMIT 1").get();}
 begin(request:RelayWithdrawal,sequence:number,call:ContractCall,tokenBudget:string,scheduled?:{revision:number;now:number}){return this.transaction(()=>{
  const id=relayRequestId(request),known=this.existing(request),old=known?this.executions(id).find(e=>e.sequence===sequence):null;if(old)return{created:false,execution:old};
  if(!Number.isSafeInteger(sequence)||sequence<0||sequence>this.limits.maxRetries||(!known&&sequence!==0))throw Error('RELAY_RETRY_LIMIT');
  const s=this.schedule(id,scheduled?.now);
  if(sequence===0&&s){if(!scheduled||s.revision!==scheduled.revision||s.state!=='waiting'||scheduled.now<s.readyAt||scheduled.now>=s.expiresAt)throw Error('RELAY_SCHEDULE_NOT_READY');}
  if(this.db.prepare("SELECT id FROM relay_executions WHERE state!='final' LIMIT 1").get())throw Error('RELAY_SIGNER_BUSY_OR_UNRESOLVED');
  const rows=this.db.prepare('SELECT near_budget,token_budget FROM relay_executions').all(),near=BigInt(call.attachedYoctoNear)+BigInt(call.gas)*BigInt(this.limits.maxGasPriceYoctoNear),tokens=BigInt(tokenBudget);
  if(rows.length>=this.limits.maxExecutions||rows.reduce((a,r)=>a+BigInt(String(r.near_budget)),near)>BigInt(this.limits.maxNearYoctoNear)||rows.reduce((a,r)=>a+BigInt(String(r.token_budget)),tokens)>BigInt(this.limits.maxTokenAtomic))throw Error('RELAY_BUDGET_EXHAUSTED');
  if(!known)this.db.prepare('INSERT INTO relay_requests VALUES(?,?,?)').run(id,request.spend.public_inputs[0],canonical(request));
  const result=this.db.prepare("INSERT INTO relay_executions(request_id,sequence,kind,state,call,near_budget,token_budget)VALUES(?,?,?,'preparing',?,?,?)").run(id,sequence,sequence?'retry':'withdraw',canonical(call),near.toString(),tokens.toString());
  if(s&&sequence===0)this.writeSchedule({...s,state:'executing',error:null});
  return{created:true,execution:this.executions(id).find(e=>e.id===Number(result.lastInsertRowid))!};
 });}
 intent(e:Execution,prepared:Prepared){const result=this.db.prepare("UPDATE relay_executions SET state='intent',prepared=? WHERE id=? AND state='preparing'").run(canonical(prepared),e.id);if(result.changes!==1)throw Error('RELAY_STATE_CONFLICT');}
 submitted(e:Execution){if(this.db.prepare("UPDATE relay_executions SET state='submitted' WHERE id=? AND state='intent'").run(e.id).changes!==1)throw Error('RELAY_STATE_CONFLICT');}
 final(e:Execution){if(this.db.prepare("UPDATE relay_executions SET state='final' WHERE id=? AND state IN ('submitted','uncertain','intent')").run(e.id).changes!==1)throw Error('RELAY_STATE_CONFLICT');}
 uncertain(e:Execution){this.db.prepare("UPDATE relay_executions SET state='uncertain' WHERE id=? AND state!='final'").run(e.id);}
}
