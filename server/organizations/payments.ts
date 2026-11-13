import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../../sdk/client/crypto.js';
import { corporateContent, type CorporateContent, type CorporatePayload, type CorporatePayment } from '../../sdk/client/corporate-payments.js';
import { ORGANIZATION_ROLE_PERMISSIONS, type OrganizationPermission, type OrganizationRole } from '../../sdk/client/organizations.js';
import { parseCall, preparedPayment } from '../../sdk/client/payment.js';
import { OrganizationError, versionMatches } from './model.js';

export const organizationPaymentsSchema = `
 CREATE TABLE IF NOT EXISTS organization_payments(id TEXT PRIMARY KEY,org TEXT NOT NULL REFERENCES organizations(id),payload TEXT NOT NULL,content_hash TEXT NOT NULL,maker TEXT NOT NULL,creator_version INTEGER NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL,approver TEXT,approver_version INTEGER,approved INTEGER,created INTEGER NOT NULL,spend_key TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS organization_payments_org ON organization_payments(org,created);
 CREATE UNIQUE INDEX IF NOT EXISTS organization_payment_spend ON organization_payments(org,spend_key) WHERE state IN ('pending','approved','dispatched','invalidated');
 CREATE TABLE IF NOT EXISTS organization_payment_dispatches(payment_id TEXT NOT NULL REFERENCES organization_payments(id),call_hash TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(payment_id,call_hash));`;
type Row = { id:string;org:string;payload:string;content_hash:string;maker:string;creator_version:number;state:CorporatePayment['state'];version:number;expires:number;approver:string|null;approver_version:number|null;approved:number|null;created:number;spend_key:string };
type Member = { status:string;role:OrganizationRole;version:number };
type Context = {
  db:DatabaseSync; now:()=>number; atomic<T>(action:()=>T):T;
  authorize(org:string,actor:string,permission:OrganizationPermission):OrganizationRole;
  member(org:string,account:string):Member|undefined;
  audit(org:string,actor:string,action:string,target:string,detail:Record<string,unknown>):void;
};
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export class OrganizationPayments {
  constructor(private c:Context) {}
  private row(org:string,id:string):Row {
    const row=this.c.db.prepare('SELECT * FROM organization_payments WHERE org=? AND id=?').get(org,id) as Row|undefined;
    if(!row)throw new OrganizationError(404,'PAYMENT_NOT_FOUND');
    const p=JSON.parse(row.payload) as CorporatePayload;
    if(hash(p)!==row.content_hash||p.organizationId!==org||p.paymentId!==id||p.creatorAccount!==row.maker||p.creatorMembershipVersion!==row.creator_version||Date.parse(p.expiresAt)!==row.expires)throw new OrganizationError(409,'PAYMENT_CONTENT_CHANGED');
    return row;
  }
  private active(row:Row,account:string|null,version:number|null,permission:OrganizationPermission) {
    if(!account||version===null)return false;
    const m=this.c.member(row.org,account);return !!m&&m.status==='active'&&m.version===version&&ORGANIZATION_ROLE_PERMISSIONS[m.role].includes(permission);
  }
  private valid(row:Row) { return row.state==='approved'&&row.expires>this.c.now()&&row.approver!==row.maker&&this.active(row,row.maker,row.creator_version,'payments.create')&&this.active(row,row.approver,row.approver_version,'payments.approve'); }
  private view(row:Row):CorporatePayment {
    return {payload:JSON.parse(row.payload),contentHash:row.content_hash,state:row.state,version:row.version,approvedBy:row.approver,approverMembershipVersion:row.approver_version,approvedAt:row.approved===null?null:new Date(row.approved).toISOString(),approvalValid:this.valid(row),
      dispatches:this.c.db.prepare('SELECT call_hash,kind,created FROM organization_payment_dispatches WHERE payment_id=? ORDER BY created,call_hash').all(row.id).map(d=>({callHash:String(d.call_hash),kind:d.kind as 'payment'|'prerequisite',createdAt:new Date(Number(d.created)).toISOString()}))};
  }
  list(org:string,actor:string) {
    this.c.authorize(org,actor,'payments.read');
    return this.c.db.prepare('SELECT id FROM organization_payments WHERE org=? ORDER BY created DESC,id LIMIT 100').all(org).map(r=>this.view(this.row(org,String(r.id))));
  }
  get(org:string,actor:string,id:string) { this.c.authorize(org,actor,'payments.read');return this.view(this.row(org,id)); }
  async create(org:string,actor:string,input:unknown,check:()=>void=()=>{}) {
    this.c.authorize(org,actor,'payments.create');
    let content:CorporateContent;
    try {content=await corporateContent(input);}catch{throw new OrganizationError(400,'INVALID_PAYMENT_CONTENT');}
    if(content.payer!==actor)throw new OrganizationError(403,'PAYMENT_PAYER_MISMATCH');
    const prepared=await preparedPayment({tokenCall:content.payment},content.policy,actor);
    if(prepared.reference.kind!=='withdrawal')throw new OrganizationError(400,'INVALID_PAYMENT_CONTENT');
    const spendKey=hash({policy:content.policy,nullifier:prepared.reference.nullifier});
    return this.c.atomic(()=>{
      check();
      this.c.authorize(org,actor,'payments.create');
      if(Number(this.c.db.prepare('SELECT COUNT(*) n FROM organization_payments WHERE org=?').get(org)!.n)>=100)throw new OrganizationError(409,'PAYMENT_LIMIT');
      if(this.c.db.prepare("SELECT id FROM organization_payments WHERE org=? AND spend_key=? AND state IN ('pending','approved','dispatched','invalidated')").get(org,spendKey))throw new OrganizationError(409,'PAYMENT_NOTE_RESERVED');
      const id=randomUUID(),now=this.c.now(),member=this.c.member(org,actor)!;
      const payload:CorporatePayload={format:'core-corporate-approval-v1',organizationId:org,paymentId:id,creatorAccount:actor,creatorMembershipVersion:member.version,expiresAt:new Date(now+86400_000).toISOString(),content};
      const digest=hash(payload);
      this.c.db.prepare("INSERT INTO organization_payments VALUES(?,?,?,?,?,?,'pending',1,?,NULL,NULL,NULL,?,?)").run(id,org,canonical(payload),digest,actor,member.version,Date.parse(payload.expiresAt),now,spendKey);
      this.c.audit(org,actor,'payment.created',id,{contentHash:digest});return this.view(this.row(org,id));
    });
  }
  decide(org:string,actor:string,id:string,action:'approve'|'reject'|'cancel',version:number,contentHash:string) {
    return this.c.atomic(()=>{
      this.c.authorize(org,actor,'payments.read'); const row=this.row(org,id);
      versionMatches(row.version,version);if(row.content_hash!==contentHash)throw new OrganizationError(409,'PAYMENT_CONTENT_CHANGED');
      if(this.c.db.prepare('SELECT 1 FROM organization_payment_dispatches WHERE payment_id=?').get(id))throw new OrganizationError(409,'PAYMENT_EXECUTION_RESERVED');
      if(action==='cancel') {
        this.c.authorize(org,actor,actor===row.maker?'payments.create':'payments.approve');
        if(!['pending','approved'].includes(row.state))throw new OrganizationError(409,'PAYMENT_STATE_CHANGED');
      } else {
        this.c.authorize(org,actor,'payments.approve');
        if(actor===row.maker)throw new OrganizationError(403,'PAYMENT_SELF_APPROVAL_DENIED');
        if(row.state!=='pending'||row.expires<=this.c.now()||!this.active(row,row.maker,row.creator_version,'payments.create'))throw new OrganizationError(409,'PAYMENT_AUTHORITY_CHANGED');
      }
      if(action==='approve')this.c.db.prepare("UPDATE organization_payments SET state='approved',version=version+1,approver=?,approver_version=?,approved=? WHERE id=?").run(actor,this.c.member(org,actor)!.version,this.c.now(),id);
      else this.c.db.prepare('UPDATE organization_payments SET state=?,version=version+1 WHERE id=?').run(action==='cancel'?'cancelled':'rejected',id);
      this.c.audit(org,actor,`payment.${action==='approve'?'approved':action==='cancel'?'cancelled':'rejected'}`,id,{contentHash});
      return this.view(this.row(org,id));
    });
  }
  authorize(org:string,actor:string,id:string,contentHash:string,kind:'payment'|'prerequisite',rawCall:unknown) {
    let call;try{call=parseCall(JSON.parse(canonical(rawCall)));}catch{throw new OrganizationError(400,'INVALID_PAYMENT_CALL');}
    return this.c.atomic(()=>{
      this.c.authorize(org,actor,'payments.execute');const row=this.row(org,id),p=JSON.parse(row.payload) as CorporatePayload;
      if(actor!==row.maker)throw new OrganizationError(403,'PAYMENT_EXECUTOR_MISMATCH');
      if(contentHash!==row.content_hash)throw new OrganizationError(409,'PAYMENT_CONTENT_CHANGED');
      if(!this.valid(row))throw new OrganizationError(409,'PAYMENT_AUTHORITY_CHANGED');
      const allowed=kind==='payment'?[p.content.payment]:p.content.prerequisites;
      if(!allowed.some(c=>canonical(c)===canonical(call)))throw new OrganizationError(409,'PAYMENT_CALL_CHANGED');
      const callHash=hash(call);
      if(this.c.db.prepare('SELECT 1 FROM organization_payment_dispatches WHERE payment_id=? AND call_hash=?').get(id,callHash))throw new OrganizationError(409,'PAYMENT_CALL_RESERVED');
      const now=this.c.now();
      this.c.db.prepare('INSERT INTO organization_payment_dispatches VALUES(?,?,?,?,?)').run(id,callHash,kind,actor,now);
      this.c.db.prepare('UPDATE organization_payments SET state=?,version=version+1 WHERE id=?').run(kind==='payment'?'dispatched':'approved',id);
      this.c.audit(org,actor,'payment.dispatch_reserved',id,{contentHash,callHash,kind});
      return {contentHash,callHash,expiresAt:new Date(Math.min(now+15000,row.expires)).toISOString()};
    });
  }
}
