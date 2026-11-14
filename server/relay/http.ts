import{createServer,type ServerResponse}from'node:http';
import{z}from'zod';
import{RelayRequest,relayPolicyHash}from'./protocol.js';
import type{ProofRelay}from'./service.js';
import {Timing, ControlToken, ScheduleCommand, schedulingConfig} from './scheduling.js';
const Retry=z.object({expectedAttempt:z.number().int().min(1).max(5)}).strict();
function json(res:ServerResponse,status:number,body:unknown){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));}
export function createRelayApi(relay:ProofRelay,origins:string[]=[]){
 let active=0;
 const server=createServer(async(req,res)=>{
  const origin=req.headers.origin;
  if(origin&&!origins.includes(origin)){json(res,403,{error:'RELAY_ORIGIN_DENIED'});return;}
  if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
  if(req.method==='OPTIONS'){res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('access-control-allow-headers','content-type');res.writeHead(204);res.end();return;}
  const url=new URL(req.url??'/', 'http://relay.local');
  if(url.search){json(res,400,{error:'RELAY_QUERY_NOT_ALLOWED'});return;}
  if(req.method==='GET'&&url.pathname==='/healthz'){json(res,200,{alive:true,service:'core-proof-relay',custody:'sponsor-key-only'});return;}
  if(req.method==='GET'&&url.pathname==='/v1/relay/config'){json(res,200,{policyHash:relayPolicyHash(relay.policy),policy:relay.policy,sponsor:relay.signer.accountId,sponsorship:'Gas, action storage and add-on withdrawal fee; recipient receives full principal.',limits:relay.store.limits,scheduling:schedulingConfig});return;}
  const match=/^\/v1\/relay\/requests\/([a-f0-9]{64})(?:\/(retry|reconcile|cancel|resume|reschedule))?$/.exec(url.pathname);
  if(active>=2){json(res,429,{error:'RELAY_BUSY'});return;}active++;
  try{
   if(req.method==='GET'&&match&&!match[2]){json(res,200,await relay.status(match[1]));return;}
   if(req.method!=='POST'||(!match&&!['/v1/relay/requests','/v1/relay/schedules'].includes(url.pathname))){json(res,404,{error:'RELAY_NOT_FOUND'});return;}
   if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Error('RELAY_JSON_REQUIRED');
   let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;if(size>8192)throw Error('RELAY_BODY_TOO_LARGE');parts.push(part);}const body=JSON.parse(Buffer.concat(parts).toString());
   if(url.pathname==='/v1/relay/schedules'){const b=z.object({request:RelayRequest,timing:Timing,controlToken:ControlToken}).strict().parse(body);json(res,200,await relay.enqueue(b.request,b.timing,b.controlToken));return;}
   if(!match){json(res,200,await relay.submit(RelayRequest.parse(body)));return;}
   if(match[2]==='retry'){json(res,200,await relay.retry(match[1],Retry.parse(body).expectedAttempt));return;}
   if(match[2]==='reconcile'){z.object({}).strict().parse(body);json(res,200,await relay.reconcile(match[1]));return;}
   if(match[2]&&['cancel','resume','reschedule'].includes(match[2])){const b=(match[2]==='reschedule'?ScheduleCommand.extend({timing:Timing}):ScheduleCommand).parse(body);json(res,200,await relay.scheduleControl(match[1],b.controlToken,b.expectedRevision,match[2] as 'cancel'|'resume'|'reschedule','timing' in b?b.timing as z.infer<typeof Timing>:undefined));return;}
   json(res,404,{error:'RELAY_NOT_FOUND'});
  }catch(error){const code=error instanceof Error&&/^RELAY_[A-Z_]+$/.test(error.message)?error.message:'RELAY_REQUEST_REJECTED';json(res,code==='RELAY_NOT_FOUND'?404:409,{error:code});}
  finally{active--;}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=30;return server;
}
