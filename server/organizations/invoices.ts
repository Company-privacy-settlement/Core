import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical } from '../../sdk/client/crypto.js';
import { verifySignedInvoice, type SignedInvoice } from '../../sdk/client/invoices.js';
import type { OrganizationInvoice, OrganizationInvoicePage, OrganizationInvoiceResult } from '../../sdk/client/organization-invoices.js';
import type { OrganizationPermission } from '../../sdk/client/organizations.js';
import type { OrganizationIdentitySource } from './auth.js';
import { Id, OrganizationError } from './model.js';
import { keyedHash, type InvoiceKeys } from './invoice-keys.js';

export const organizationInvoicesSchema = `
 CREATE TABLE IF NOT EXISTS organization_invoices(id TEXT PRIMARY KEY,org TEXT NOT NULL REFERENCES organizations(id),sequence INTEGER NOT NULL,created INTEGER NOT NULL,key_id TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,natural_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,UNIQUE(org,sequence),UNIQUE(org,natural_hash));
 CREATE TABLE IF NOT EXISTS organization_invoice_requests(org TEXT NOT NULL REFERENCES organizations(id),request_hash TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES organization_invoices(id),payload_hash TEXT NOT NULL,PRIMARY KEY(org,request_hash));
 CREATE TABLE IF NOT EXISTS organization_invoice_key_checks(purpose TEXT NOT NULL,key_id TEXT NOT NULL,check_value TEXT NOT NULL,PRIMARY KEY(purpose,key_id));`;
type Row = { id:string; org:string; sequence:number; created:number; key_id:string; nonce:Uint8Array; ciphertext:Uint8Array; tag:Uint8Array; natural_hash:string; payload_hash:string };
type Context = { db:DatabaseSync; audience:string; now:()=>number; keys?:InvoiceKeys;
  atomic<T>(action:()=>T):T; authorize(org:string,actor:string,permission:OrganizationPermission):unknown;
  audit(org:string,actor:string,action:string,target:string,detail:Record<string,unknown>):void };
const Input = z.object({ requestId:Id, invoice:z.unknown() }).strict();
export class OrganizationInvoices {
  constructor(private c:Context) {
    if (!c.keys) return;
    c.atomic(() => {
      const check = (purpose:string,id:string,key:Buffer) => {
        const digest = keyedHash(key,canonical(['core:invoice:key-check:v1',c.audience,purpose,id]));
        const row = c.db.prepare('SELECT check_value FROM organization_invoice_key_checks WHERE purpose=? AND key_id=?').get(purpose,id);
        if (row && row.check_value !== digest) throw new Error('Invoice key material does not match this database');
        c.db.prepare('INSERT OR IGNORE INTO organization_invoice_key_checks VALUES(?,?,?)').run(purpose,id,digest);
      };
      check('index','stable',c.keys!.indexKey);
      for (const [id,key] of c.keys!.keys) check('data',id,key);
      for (const row of c.db.prepare('SELECT DISTINCT key_id FROM organization_invoices').all()) if (!c.keys!.keys.has(String(row.key_id))) throw new Error('Invoice decryption key missing');
    });
  }
  private keys() { if (!this.c.keys) throw new OrganizationError(503,'INVOICE_STORAGE_DISABLED'); return this.c.keys; }
  private blind(org:string,purpose:string,value:unknown) { return keyedHash(this.keys().indexKey,canonical(['core:organization-invoice:index:v1',this.c.audience,org,purpose,value])); }
  private aad(r:Pick<Row,'id'|'org'|'sequence'|'created'|'key_id'|'natural_hash'|'payload_hash'>) { return Buffer.from(canonical(['core:organization-invoice:aead:v1',this.c.audience,r.org,r.id,r.sequence,r.created,r.key_id,r.natural_hash,r.payload_hash])); }
  private view(row:Row):OrganizationInvoice {
    const keys=this.keys();
    try {
      const key=keys.keys.get(row.key_id); if(!key || row.nonce.length!==12 || row.tag.length!==16) throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',key,row.nonce); decipher.setAAD(this.aad(row)); decipher.setAuthTag(row.tag);
      const value=JSON.parse(Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8')) as OrganizationInvoice;
      if(value.id!==row.id || value.organizationId!==row.org || value.sequence!==row.sequence || value.createdAt!==new Date(row.created).toISOString() || this.blind(row.org,'payload',value.invoice)!==row.payload_hash) throw new Error();
      return value;
    } catch { throw new OrganizationError(503,'INVOICE_DECRYPTION_FAILED'); }
  }
  /** Internal trusted worker scan; never exposed as an unauthenticated route. */
  webhookRecords(after?:string):OrganizationInvoice[] {
    this.keys();return (this.c.db.prepare("SELECT i.* FROM organization_invoices i WHERE i.id>? AND EXISTS(SELECT 1 FROM organization_webhook_endpoints e WHERE e.org=i.org AND e.state='active') ORDER BY i.id LIMIT 25").all(after??'') as Row[]).map(r=>this.view(r));
  }
  get(org:string,actor:string,id:string):OrganizationInvoice {
    this.c.authorize(org,actor,'invoices.read'); this.keys();
    const row=this.c.db.prepare('SELECT * FROM organization_invoices WHERE org=? AND id=?').get(org,id) as Row|undefined;
    if(!row)throw new OrganizationError(404,'INVOICE_NOT_FOUND'); return this.view(row);
  }
  list(org:string,actor:string,before?:number):OrganizationInvoicePage {
    this.c.authorize(org,actor,'invoices.read'); this.keys();
    if(before!==undefined && (!Number.isSafeInteger(before)||before<1))throw new OrganizationError(400,'INVALID_CURSOR');
    const rows=this.c.db.prepare('SELECT * FROM organization_invoices WHERE org=? AND sequence<? ORDER BY sequence DESC LIMIT 51').all(org,before??Number.MAX_SAFE_INTEGER) as Row[];
    return { items:rows.slice(0,50).map(r=>this.view(r)),nextCursor:rows.length>50?rows[49].sequence:null };
  }
  async create(org:string,actor:string,input:unknown,identity:OrganizationIdentitySource,signal:AbortSignal,check:()=>void=()=>{}):Promise<OrganizationInvoiceResult> {
    this.c.authorize(org,actor,'invoices.create'); this.keys();
    const parsed=Input.safeParse(input); if(!parsed.success)throw new OrganizationError(400,'INVALID_INPUT');
    let invoice:SignedInvoice;
    try { invoice=await verifySignedInvoice(parsed.data.invoice); } catch { throw new OrganizationError(400,'INVALID_INVOICE_SIGNATURE'); }
    if(invoice.invoice.merchantAccount!==actor)throw new OrganizationError(403,'INVOICE_MERCHANT_MISMATCH');
    if(invoice.invoice.policy.network!=='testnet')throw new OrganizationError(400,'INVOICE_NETWORK_MISMATCH');
    const payload=this.blind(org,'payload',invoice),natural=this.blind(org,'natural',[actor,invoice.invoice.id]),request=this.blind(org,'request',parsed.data.requestId);
    const existing=() => {
      const alias=this.c.db.prepare('SELECT invoice_id,payload_hash FROM organization_invoice_requests WHERE org=? AND request_hash=?').get(org,request);
      if(alias && alias.payload_hash!==payload)throw new OrganizationError(409,'IDEMPOTENCY_CONFLICT');
      const row=this.c.db.prepare('SELECT * FROM organization_invoices WHERE org=? AND natural_hash=?').get(org,natural) as Row|undefined;
      if(row && row.payload_hash!==payload)throw new OrganizationError(409,'INVOICE_CONFLICT');
      if(alias && (!row || alias.invoice_id!==row.id))throw new OrganizationError(503,'INVOICE_DECRYPTION_FAILED');
      return row;
    };
    signal.throwIfAborted();check();this.c.authorize(org,actor,'invoices.create');
    const known=existing();
    // Historic exact retries remain available after merchant key rotation.
    if(!known && !await identity.currentFullAccessKey(actor,invoice.signature.publicKey,signal))throw new OrganizationError(403,'INVOICE_KEY_REVOKED');
    return this.c.atomic(() => {
      signal.throwIfAborted();check();this.c.authorize(org,actor,'invoices.create');
      let row=existing(); const replayed=!!row;
      const aliases=Number(this.c.db.prepare('SELECT COUNT(*) n FROM organization_invoice_requests WHERE org=?').get(org)!.n);
      if(aliases>=4000 && !this.c.db.prepare('SELECT 1 FROM organization_invoice_requests WHERE org=? AND request_hash=?').get(org,request))throw new OrganizationError(409,'INVOICE_REQUEST_LIMIT');
      if(!row) {
        const n=Number(this.c.db.prepare('SELECT COUNT(*) n FROM organization_invoices WHERE org=?').get(org)!.n);
        if(n>=1000)throw new OrganizationError(409,'INVOICE_LIMIT');
        const keys=this.keys();row={id:randomUUID(),org,sequence:n+1,created:this.c.now(),key_id:keys.activeKeyId,natural_hash:natural,payload_hash:payload,nonce:randomBytes(12),ciphertext:new Uint8Array(),tag:new Uint8Array()};
        const value:OrganizationInvoice={id:row.id,organizationId:org,sequence:row.sequence,createdAt:new Date(row.created).toISOString(),createdBy:actor,invoice};
        const cipher=createCipheriv('aes-256-gcm',keys.keys.get(keys.activeKeyId)!,row.nonce);cipher.setAAD(this.aad(row));
        row.ciphertext=Buffer.concat([cipher.update(canonical(value),'utf8'),cipher.final()]);row.tag=cipher.getAuthTag();
        this.c.db.prepare('INSERT INTO organization_invoices VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.id,org,row.sequence,row.created,row.key_id,row.nonce,row.ciphertext,row.tag,natural,payload);
        this.c.audit(org,actor,'invoice.created',row.id,{});
      }
      this.c.db.prepare('INSERT OR IGNORE INTO organization_invoice_requests VALUES(?,?,?,?)').run(org,request,row.id,payload);
      return { invoice:this.view(row),replayed };
    });
  }
}
