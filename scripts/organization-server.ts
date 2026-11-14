import { SumsubProvider, loadSumsubConfig } from '../server/organizations/sumsub.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { IndexStore } from '../sdk/indexer/store.js';
import { SharedPolicySchema } from '../sdk/shared.js';
import { OrganizationWebhookWorker } from '../server/organizations/webhook-worker.js';
import { SafeWebhookTransport, webhookUrl } from '../server/organizations/webhook-transport.js';
import { z } from 'zod';
import { loadInvoiceKeys } from '../server/organizations/invoice-keys.js';
import { organizationOrigin } from '../sdk/client/organizations.js';
import { OrganizationStore } from '../server/organizations/store.js';
import { NearOrganizationIdentity } from '../server/organizations/auth.js';
import { createOrganizationApi } from '../server/organizations/api.js';

const audience = organizationOrigin(z.string().parse(process.env.CORE_ORGANIZATION_ORIGIN));
const filename = z.string().min(1).parse(process.env.CORE_ORGANIZATION_DB);
const origins = (process.env.CORE_ORGANIZATION_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean).map(organizationOrigin);
if (!origins.length) throw new Error('Set CORE_ORGANIZATION_ALLOWED_ORIGINS');
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? '3002');
const identity = new NearOrganizationIdentity(process.env.CORE_ORGANIZATION_RPC_URL ?? 'https://rpc.testnet.near.org');
const keys = process.env.CORE_ORGANIZATION_INVOICE_KEYS_FILE ? loadInvoiceKeys(process.env.CORE_ORGANIZATION_INVOICE_KEYS_FILE) : undefined;
const destinations=(process.env.CORE_WEBHOOK_ALLOWED_ORIGINS??'').split(',').filter(Boolean);
const allowed=new Set(destinations);
for(const origin of destinations){if(new URL(origin).origin!==origin)throw new Error('Use exact webhook destination origins');webhookUrl(origin+'/',allowed);}
const enabled=process.env.CORE_WEBHOOK_INDEX_DB!==undefined;
if(!enabled&&[process.env.CORE_WEBHOOK_POLICY_FILE,process.env.CORE_WEBHOOK_POLICY_SHA256].some(Boolean))throw new Error('Configure all webhook index settings together');
let index:IndexStore|undefined;
if(enabled){
  if(!keys||!destinations.length||!process.env.CORE_WEBHOOK_POLICY_FILE||!process.env.CORE_WEBHOOK_POLICY_SHA256)throw new Error('Webhook worker needs invoice keys, allowed destinations, policy and its independent SHA-256');
  const path=process.env.CORE_WEBHOOK_POLICY_FILE,st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>8192)throw new Error('Invalid webhook policy file');
  const bytes=readFileSync(path);if(createHash('sha256').update(bytes).digest('hex')!==process.env.CORE_WEBHOOK_POLICY_SHA256)throw new Error('Webhook policy digest mismatch');
  const policy=SharedPolicySchema.parse(JSON.parse(bytes.toString('utf8')));if(policy.network!=='testnet')throw new Error('Webhook worker is testnet only');
  index=new IndexStore(process.env.CORE_WEBHOOK_INDEX_DB!,policy,true);
}
const verificationProvider=process.env.CORE_SUMSUB_CONFIG_FILE?new SumsubProvider(loadSumsubConfig(process.env.CORE_SUMSUB_CONFIG_FILE)):undefined;
if(verificationProvider&&!keys)throw new Error('Sumsub requires organization encryption keys');
let store:OrganizationStore;
try{store=new OrganizationStore(filename,audience,Date.now,keys,destinations);}catch(error){index?.close();throw error;}
const controller=new AbortController();let tick:Promise<void>|undefined;
const worker=index?new OrganizationWebhookWorker(store,index,new SafeWebhookTransport(allowed)):undefined;
const poll=()=>{if(worker&&!tick)tick=worker.tick(controller.signal).catch(()=>{if(!controller.signal.aborted)console.error(JSON.stringify({event:'webhook_worker_failed'}));}).finally(()=>{tick=undefined;});};
const interval=worker?setInterval(poll,5000):undefined;if(interval){interval.unref();poll();}
let verificationTick:Promise<void>|undefined;
const verificationPoll=()=>{if(verificationProvider&&!verificationTick)verificationTick=store.verifications.tick(verificationProvider,controller.signal).catch(()=>{if(!controller.signal.aborted)console.error(JSON.stringify({event:'verification_worker_failed'}));}).finally(()=>{verificationTick=undefined;});};
const verificationInterval=verificationProvider?setInterval(verificationPoll,30000):undefined;if(verificationInterval){verificationInterval.unref();verificationPoll();}
const server = createOrganizationApi({ store, identity, allowedOrigins: origins,verificationProvider });
server.listen(port, process.env.CORE_ORGANIZATION_HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'organization_service_started', network: 'testnet', port })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { controller.abort();if(interval)clearInterval(interval);if(verificationInterval)clearInterval(verificationInterval);server.close(); setTimeout(() => server.closeAllConnections(), 5000).unref(); });
server.once('close', () => {controller.abort();if(interval)clearInterval(interval);if(verificationInterval)clearInterval(verificationInterval);void Promise.allSettled([tick,verificationTick]).finally(()=>{index?.close();store.close();});});
