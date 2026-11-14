import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';

export type WebhookSendResult={status:number|null;error:string|null;retryable:boolean;retryAfterSeconds?:number};
export interface WebhookTransport {send(url:string,headers:Record<string,string>,body:string,signal:AbortSignal,beforeSend:()=>void):Promise<WebhookSendResult>}
export function webhookUrl(value:string,allowed:ReadonlySet<string>) {
  const u=new URL(value);
  if(value.length>1024||u.protocol!=='https:'||u.port||u.username||u.password||u.hash||u.search||!allowed.has(u.origin)||isIP(u.hostname)||!u.hostname.includes('.'))throw new Error('WEBHOOK_DESTINATION_DENIED');return u.href;
}
/** Conservative global-unicast allow rules; reject mixed public/private DNS answers. */
export function publicWebhookAddress(address:string):boolean {
  if(isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2||b===88&&c===99))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
  }
  if(isIP(address)!==6)return false;
  // Accept only 2000::/3; exclude transition/special/documentation prefixes.
  const s=address.toLowerCase(),first=parseInt(s.split(':')[0],16);
  return first>=0x2000&&first<=0x3fff&&!s.startsWith('2001:')&&!s.startsWith('2002:')&&!s.startsWith('3fff:');
}
export class SafeWebhookTransport implements WebhookTransport {
  constructor(private allowed:ReadonlySet<string>,private resolveHost=lookup,private httpsRequest=request) {}
  async send(url:string,headers:Record<string,string>,body:string,parent:AbortSignal,beforeSend:()=>void):Promise<WebhookSendResult> {
    const controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal]),timer=setTimeout(()=>controller.abort(),5000);
    try {
      const u=new URL(webhookUrl(url,this.allowed));
      const answers=await Promise.race([this.resolveHost(u.hostname,{all:true,verbatim:true}),new Promise<never>((_r,reject)=>{signal.addEventListener('abort',()=>reject(new Error('WEBHOOK_TIMEOUT')),{once:true});if(signal.aborted)reject(new Error('WEBHOOK_TIMEOUT'));})]);
      signal.throwIfAborted();
      if(!answers.length||answers.length>8||answers.some(a=>!publicWebhookAddress(a.address)))return {status:null,error:'DESTINATION_BLOCKED',retryable:false};
      const pinned=answers[0];beforeSend();signal.throwIfAborted();
      return await new Promise<WebhookSendResult>(resolve=>{
        const options:RequestOptions & {autoSelectFamily:boolean}={method:'POST',agent:false,autoSelectFamily:false,family:pinned.family,rejectUnauthorized:true,servername:u.hostname,maxHeaderSize:8192,signal,headers:{...headers,'content-type':'application/json; charset=utf-8','content-length':String(Buffer.byteLength(body)),'user-agent':'Core-Webhooks/1'},lookup:(_host,_options,cb)=>{cb(null,pinned.address,pinned.family);}};
        const req=this.httpsRequest(u,options,res=>{
          const status=res.statusCode??0,retry=res.headers['retry-after'];
          resolve({status,error:status>=200&&status<300?null:`HTTP_${status}`,retryable:status===408||status===425||status===429||(status>=500&&status<=599),...(typeof retry==='string'&&/^\d{1,4}$/.test(retry)?{retryAfterSeconds:Math.min(3600,Number(retry))}:{})});res.destroy();
        });
        req.on('error',()=>resolve({status:null,error:signal.aborted?'REQUEST_ABORTED':'NETWORK_ERROR',retryable:true}));req.end(body);
      });
    } catch(error) {const denied=error instanceof Error&&error.message==='WEBHOOK_DESTINATION_DENIED';return {status:null,error:signal.aborted?'REQUEST_ABORTED':denied?'DESTINATION_DENIED':'NETWORK_ERROR',retryable:!denied};}
    finally {clearTimeout(timer);}
  }
}
