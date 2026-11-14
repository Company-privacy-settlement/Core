import type { SignedInvoice } from './invoices.js';
import type { OrganizationClient } from './organizations.js';

export type OrganizationInvoice = { id:string; organizationId:string; sequence:number; createdAt:string; createdBy:string; invoice:SignedInvoice };
export type OrganizationInvoicePage = { items:OrganizationInvoice[]; nextCursor:number|null };
export type OrganizationInvoiceResult = { invoice:OrganizationInvoice; replayed:boolean };
function id(value:string) { if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw new Error('Invalid organization invoice identifier');return value; }
/** Authenticated transport; no credentials or decrypted invoice terms are persisted. */
export class OrganizationInvoiceClient {
  constructor(private client:OrganizationClient,private organizationId:string) { id(organizationId); }
  private path() { return `/v1/organizations/${this.organizationId}/invoices`; }
  save(requestId:string,invoice:SignedInvoice,signal?:AbortSignal) { return this.client.request<OrganizationInvoiceResult>(this.path(),'POST',{requestId:id(requestId),invoice},signal); }
  get(invoiceId:string,signal?:AbortSignal) { return this.client.request<OrganizationInvoice>(`${this.path()}/${id(invoiceId)}`,'GET',undefined,signal); }
  list(before?:number,signal?:AbortSignal) {
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new Error('Invalid invoice cursor');
    return this.client.request<OrganizationInvoicePage>(this.path()+(before===undefined?'':`?before=${before}`),'GET',undefined,signal);
  }
}
