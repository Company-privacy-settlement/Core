import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SharedPolicySchema } from '../sdk/shared.js';
import { NearRpcOperationsSource } from '../sdk/operations.js';
import { createReadOnlyApi } from '../server/api.js';

const path = process.env.CORE_POLICY_FILE, rpc = process.env.CORE_RPC_URL;
if (!path || !rpc) throw new Error('Set CORE_POLICY_FILE and CORE_RPC_URL to a trusted deployed group and RPC. No simulated chain fallback is provided.');
const policy = SharedPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? '3001');
const host = process.env.CORE_API_HOST ?? '127.0.0.1';
const origins = (process.env.CORE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
const server = createReadOnlyApi({policy,source:new NearRpcOperationsSource(policy.network,policy.registry,rpc),allowedOrigins:origins});
server.listen(port,host,() => console.log(`Core read-only API listening on http://${host}:${port}; chain readiness is checked per operation.`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { server.close(); setTimeout(()=>server.closeAllConnections(),5000).unref(); });
