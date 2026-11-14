import { canonical } from '../../sdk/client/crypto.js';
import { invoiceStatusRequest } from '../../sdk/client/invoices.js';
import { invoiceDashboardObservation } from '../../sdk/client/invoice-dashboard.js';
import { indexedInvoiceStatus } from '../../sdk/invoices.js';
import type { ActivityReader } from '../../sdk/indexer/store.js';
import type { OrganizationStore } from './store.js';
import type { WebhookTransport } from './webhook-transport.js';

export class OrganizationWebhookWorker {
  private after:string|undefined;
  private running=false;
  constructor(private store:OrganizationStore,private index:ActivityReader,private transport:WebhookTransport) {}
  async tick(signal:AbortSignal) {
    if(this.running)return;this.running=true;
    try {
      let scanError:unknown;
      try {
      const records=this.store.invoices.webhookRecords(this.after);this.after=records.length===25?records[24].id:undefined;
      for(const record of records){signal.throwIfAborted();if(canonical(record.invoice.invoice.policy)!==canonical(this.index.policy))continue;
        const status=await indexedInvoiceStatus(this.index,this.index.policy,await invoiceStatusRequest(record.invoice.invoice),this.store.now());signal.throwIfAborted();
        await invoiceDashboardObservation(record,this.index.policy,this.store.audience,status,this.store.now());signal.throwIfAborted();this.store.webhooks.enqueue(record,status);
      }
      }catch(error){signal.throwIfAborted();scanError=error;}
      for(let n=0;n<10;n++) {signal.throwIfAborted();const claim=this.store.webhooks.claim();if(!claim)break;
        let result;try{result=await this.transport.send(claim.url,claim.headers,claim.body,signal,()=>{signal.throwIfAborted();this.store.webhooks.beforeSend(claim);});}catch{result={status:null,error:'TRANSPORT_INTERRUPTED',retryable:true};}
        this.store.webhooks.finish(claim,result);
      }
      if(scanError)throw scanError;
    } finally {this.running=false;}
  }
}
