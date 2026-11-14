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
const store = new OrganizationStore(filename, audience, Date.now, keys);
const server = createOrganizationApi({ store, identity, allowedOrigins: origins });
server.listen(port, process.env.CORE_ORGANIZATION_HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'organization_service_started', network: 'testnet', port })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); setTimeout(() => server.closeAllConnections(), 5000).unref(); });
server.once('close', () => store.close());
