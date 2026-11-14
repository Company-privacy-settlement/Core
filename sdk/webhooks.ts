import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPaymentWebhook, type PaymentWebhookEvent, type WebhookHeaders } from './client/webhooks.js';

/** Receiver-owned inbox. Business writes and event receipt commit in the same synchronous SQL transaction. */
export class PaymentWebhookInbox {
  readonly db:DatabaseSync;
  constructor(filename:string,private organizationId:string) {
    if(filename!==':memory:'){filename=resolve(filename);mkdirSync(dirname(filename),{recursive:true,mode:0o700});try{closeSync(openSync(filename,'wx',0o600));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const st=lstatSync(filename);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw new Error('Webhook inbox requires an owner-only regular file');}
    this.db=new DatabaseSync(filename);this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS core_webhook_inbox(event_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,payload_hash TEXT NOT NULL,received INTEGER NOT NULL)');
  }
  async accept(body:string,headers:WebhookHeaders,secrets:string[],apply:(db:DatabaseSync,event:PaymentWebhookEvent)=>void,now=Date.now()) {
    const event=await verifyPaymentWebhook(body,headers,secrets,{organizationId:this.organizationId,now}),hash=createHash('sha256').update(body).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');try{const old=this.db.prepare('SELECT * FROM core_webhook_inbox WHERE event_id=?').get(event.id);if(old){if(old.payload_hash!==hash||old.organization_id!==this.organizationId)throw new Error('WEBHOOK_EVENT_CONTENT_CONFLICT');this.db.exec('COMMIT');return {duplicate:true,eventId:event.id};}
      if(apply.constructor.name==='AsyncFunction')throw new Error('Webhook business handler must be synchronous');
      const result=apply(this.db,event) as unknown;if(result&&typeof (result as Promise<unknown>).then==='function')throw new Error('Webhook business handler must be synchronous');
      this.db.prepare('INSERT INTO core_webhook_inbox VALUES(?,?,?,?)').run(event.id,this.organizationId,hash,now);this.db.exec('COMMIT');return {duplicate:false,eventId:event.id};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
