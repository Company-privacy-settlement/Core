import { corporateId } from './corporate-payments.js';
import type { OrganizationClient } from './organizations.js';
export type VerificationState='draft'|'in_review'|'needs_information'|'approved'|'rejected'|'review_required'|'expired'|'revoked'|'stale';
export type VerificationSubject={reference:string;kind:'company'|'individual';roles:string[];state:VerificationState};
export type VerificationCase={id:string;organizationId:string;jurisdiction:'US'|'AE-ADGM'|'AE-MAINLAND';environment:'sandbox'|'production';state:VerificationState;version:number;createdAt:string;checkedAt:string|null;expiresAt:string|null;subjects:VerificationSubject[]};
export type DemoKybApproval={mode:'hackathon';state:'approved';identityChecksPerformed:false;credentialIssued:false};
export type OrganizationVerification={configured:boolean;provider:'sumsub';environment:'sandbox'|'production'|null;case:VerificationCase|null;demo?:DemoKybApproval};
export function verificationState(c:VerificationCase,now=Date.now()):VerificationState {if(c.state==='revoked')return 'revoked';if(c.expiresAt&&Date.parse(c.expiresAt)<=now)return 'expired';if(c.state==='approved'&&(!c.checkedAt||now-Date.parse(c.checkedAt)>300000||Date.parse(c.checkedAt)>now+60000))return 'stale';return c.state;}
/** Private, current organization access is required. No provider key or identity document is persisted here. */
export class OrganizationVerificationClient {
  private base:string;
  constructor(private client:OrganizationClient,organizationId:string){this.base=`/v1/organizations/${corporateId(organizationId)}/verification`;}
  get(signal?:AbortSignal){return this.client.request<OrganizationVerification>(this.base,'GET',undefined,signal);}
  create(input:{requestId:string;jurisdiction:VerificationCase['jurisdiction'];acknowledged:true},signal?:AbortSignal){return this.client.request<OrganizationVerification>(this.base,'POST',input,signal);}
  refresh(version:number,signal?:AbortSignal){return this.client.request<OrganizationVerification>(this.base+'/refresh','POST',{version},signal);}
  link(version:number,signal?:AbortSignal){return this.client.request<{url:string;expiresAt:string;caseId:string}>(this.base+'/link','POST',{version},signal);}
  revoke(version:number,signal?:AbortSignal){return this.client.request<OrganizationVerification>(this.base+'/revoke','POST',{version},signal);}
}
