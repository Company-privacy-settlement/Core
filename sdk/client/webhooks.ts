import { account } from './payment.js';
import { organizationOrigin, type OrganizationClient } from './organizations.js';

export type PaymentWebhookEvent = {
  version:1; id:string; type:'invoice.payment_confirmed'; organizationId:string; createdAt:string; producer:string;
  data:{invoiceRecordId:string;invoiceId:string;invoiceHash:string;network:'testnet';registry:string;asset:string;recipient:string;amountTokens:string;nullifier:string;recordIndex:number;blockHeight:number;transaction:{hash:string;signer:string};index:{hash:string;height:number;updatedAt:string}};
};
export type WebhookEndpoint={id:string;url:string;state:'active'|'paused';version:number;keyId:string;createdAt:string};
export type WebhookDelivery={id:string;sequence:number;eventId:string;endpointId:string;state:'pending'|'sending'|'delivered'|'dead'|'held';version:number;attempts:number;redrives:number;nextAttemptAt:string|null;lastError:string|null;createdAt:string};
export type WebhookAttempt={number:number;startedAt:string;finishedAt:string|null;outcome:string;httpStatus:number|null;error:string|null};
export type WebhookHeaders={ 'core-event-id':string; 'core-webhook-timestamp':string; 'core-webhook-key-id':string; 'core-webhook-signature':string };
export function createWebhookSecret() { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function webhookSecret(value:string):Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Use a 32-byte base64url webhook signing secret');
  const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
  if(btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)throw new Error('Noncanonical webhook secret');return bytes;
}
export async function webhookKeyId(secret:string) { return 'whk_'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',webhookSecret(secret))),b=>b.toString(16).padStart(2,'0')).join('').slice(0,16); }
export function webhookSigningMessage(eventId:string,timestamp:string,keyId:string,body:string) { return `core:webhook:v1\n${timestamp}\n${eventId}\n${keyId}\n${body}`; }
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
/** Verify the exact raw UTF-8 body before JSON handling; receivers must atomically deduplicate event IDs. */
export async function verifyPaymentWebhook(body:string,headers:WebhookHeaders,secrets:string[],options:{now?:number;organizationId?:string}={}):Promise<PaymentWebhookEvent> {
  const now=options.now??Date.now(),time=headers['core-webhook-timestamp'],id=headers['core-event-id'],keyId=headers['core-webhook-key-id'],signature=headers['core-webhook-signature'];
  if(new TextEncoder().encode(body).length>16384||!uuid(id)||!/^\d{10}$/.test(time)||Math.abs(Math.floor(now/1000)-Number(time))>300||!/^whk_[a-f0-9]{16}$/.test(keyId)||!/^v1=[a-f0-9]{64}$/.test(signature)||secrets.length<1||secrets.length>16)throw new Error('Invalid webhook authentication');
  let valid=false;
  for(const secret of secrets) {
    if(await webhookKeyId(secret)!==keyId)continue;
    const key=await crypto.subtle.importKey('raw',webhookSecret(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    valid=await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.slice(3).match(/../g)!,b=>parseInt(b,16)),new TextEncoder().encode(webhookSigningMessage(id,time,keyId,body)));if(valid)break;
  }
  if(!valid)throw new Error('Invalid webhook authentication');
  const e=JSON.parse(body) as PaymentWebhookEvent,d=e.data;
  if(e.version!==1||e.id!==id||e.type!=='invoice.payment_confirmed'||!uuid(e.organizationId)||(options.organizationId&&e.organizationId!==options.organizationId)||typeof e.createdAt!=='string'||!Number.isFinite(Date.parse(e.createdAt))||organizationOrigin(e.producer)!==e.producer||!d||!uuid(d.invoiceRecordId)||!uuid(d.invoiceId)||!/^[a-f0-9]{64}$/.test(d.invoiceHash)||d.network!=='testnet'||!/^\d{1,42}$/.test(d.amountTokens)||BigInt(d.amountTokens)<=0n||!/^\d{1,77}$/.test(d.nullifier)||!Number.isSafeInteger(d.recordIndex)||d.recordIndex<0||!Number.isSafeInteger(d.blockHeight)||d.blockHeight<0||!d.transaction||!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(d.transaction.hash))throw new Error('Invalid authenticated payment event');
  const exact=(value:object,keys:string[])=>Object.keys(value).sort().join('|')===[...keys].sort().join('|');
  if(!exact(e,['version','id','type','organizationId','createdAt','producer','data'])||!exact(d,['invoiceRecordId','invoiceId','invoiceHash','network','registry','asset','recipient','amountTokens','nullifier','recordIndex','blockHeight','transaction','index'])||!exact(d.transaction,['hash','signer'])||!d.index||!exact(d.index,['hash','height','updatedAt'])||!/^[1-9][0-9]{0,41}$/.test(d.amountTokens)||!/^(0|[1-9][0-9]{0,76})$/.test(d.nullifier)||account(d.registry)!==d.registry||account(d.recipient)!==d.recipient||account(d.transaction.signer)!==d.transaction.signer||(d.asset!=='NEAR'&&account(d.asset)!==d.asset)||new Date(e.createdAt).toISOString()!==e.createdAt||!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(d.index.hash)||!Number.isSafeInteger(d.index.height)||d.index.height<d.blockHeight||typeof d.index.updatedAt!=='string'||!Number.isFinite(Date.parse(d.index.updatedAt))||new Date(d.index.updatedAt).toISOString()!==d.index.updatedAt)throw new Error('Invalid authenticated payment event');
  return e;
}
function id(value:string) {if(!uuid(value))throw new Error('Invalid webhook identifier');return value;}
export class OrganizationWebhookClient {
  private base:string;
  constructor(private client:OrganizationClient,org:string) {this.base=`/v1/organizations/${id(org)}/webhooks`;}
  endpoints(signal?:AbortSignal) {return this.client.request<{items:WebhookEndpoint[]}>(this.base,'GET',undefined,signal);}
  create(requestId:string,url:string,secret:string,signal?:AbortSignal) {webhookSecret(secret);return this.client.request<{endpoint:WebhookEndpoint;replayed:boolean}>(this.base,'POST',{requestId:id(requestId),url,secret},signal);}
  update(endpointId:string,action:'pause'|'resume'|'rotate',version:number,secret?:string,signal?:AbortSignal) {if(action==='rotate')webhookSecret(secret??'');return this.client.request<WebhookEndpoint>(`${this.base}/${id(endpointId)}/${action}`,'POST',{version,...(secret?{secret}:{})},signal);}
  deliveries(before?:number,signal?:AbortSignal) {if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new Error('Invalid webhook cursor');return this.client.request<{items:WebhookDelivery[];nextCursor:number|null}>(`${this.base}/deliveries${before===undefined?'':`?before=${before}`}`,'GET',undefined,signal);}
  delivery(deliveryId:string,signal?:AbortSignal) {return this.client.request<{delivery:WebhookDelivery;attempts:WebhookAttempt[];event:PaymentWebhookEvent}>(`${this.base}/deliveries/${id(deliveryId)}`,'GET',undefined,signal);}
  retry(deliveryId:string,version:number,signal?:AbortSignal) {return this.client.request<WebhookDelivery>(`${this.base}/deliveries/${id(deliveryId)}/retry`,'POST',{version},signal);}
}
