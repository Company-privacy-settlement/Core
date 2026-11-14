# Live server deployment and HTTPS acceptance

[Hosting architecture](HOSTING.md) · [Organization service](ORGANIZATIONS.md) · [Deployment policy](DEPLOYMENT.md)

**Current status: not deployed.** On 2026-11-14 this workspace has no connected hosting account, SSH target, assigned API domains or independently verified public deployment policy. The existing Site URL hosts Front; it is not a persistent Node/SQLite API or indexer. Adding configuration and passing fixture tests do not complete live deployment. Work package R04 remains open.

## Required operator inputs

| Input | Required evidence |
| --- | --- |
| Hosting target | Connected Render account or an explicitly selected SSH host with access and persistent storage; agree actual service/disk cost before provisioning paid resources |
| API domains | Two distinct HTTPS origins for settlement and organization APIs, DNS access if using custom domains; platform-provided HTTPS names are acceptable |
| Deployment policy | Real deployed keyless testnet group, verified contract/verifier hashes, policy file and independently obtained exact **byte** SHA-256; example/sandbox policies are not sufficient |
| Front origin | Exact allowed Front origin, currently `https://core-private-settlement-0574c4.jiheon6768.chatgpt.site` |
| Protected keys | Organization encryption key ring, preserved separately from the database and readable only by the runtime owner |
| Operator verification | External HTTPS reachability, advancing finalized index, current test-wallet organization session and post-restart persistence evidence |

No hosting credentials, keys, secret files, sessions or paid accounts are created from placeholders. Provider connection is still needed. Never paste signing/private provider keys into issue bodies, repository files or deployment reports.

## One-host deployment

[production.compose.yaml](../ops/production.compose.yaml) runs the settlement API and its single supervised index writer, a separate organization API, and one Caddy gateway. Only Caddy publishes ports 80/443. The two databases and TLS state have separate named volumes. Both Node services use the existing compiled, unprivileged runtime image. Encryption keys are required by this stack, including when AI and KYB providers are disabled.

Use a fresh/reviewed target with Docker Engine and Compose v2. If an existing gateway owns ports 80/443, integrate the reviewed routes with that gateway before starting services. The two older standalone HTTPS stacks each publish those ports and cannot simply be started together on one host. This new stack has its own volume names; migration from an existing stack needs explicit volume mapping and verified backups.

1. Check out Core at the exact reviewed commit. Obtain the real policy through [testnet deployment verification](DEPLOYMENT.md); confirm its independent byte digest.
2. Prepare DNS A/AAAA records and inbound TCP 80/443 for the chosen domains. Confirm both names resolve to the chosen host. UDP 443 is optional for HTTP/3.
3. Copy [production.env.example](../ops/production.env.example) outside the repository and replace all target/path/digest placeholders. Domains must differ. Use the exact public Front origin; wildcard CORS is unsupported.
4. Provision the organization key ring with `npm run organizations:invoice-keys -- /secure/core/service.invoice-keys.json` on a controlled host. Preserve the separately backed-up file and provision runtime UID 1000 ownership/mode 0600. Protected provider/reviewer files follow the same owner requirement.
5. Validate, build and start on the actual host:

```bash
docker compose --env-file /secure/core/production.env -f ops/production.compose.yaml config --quiet
docker compose --env-file /secure/core/production.env -f ops/production.compose.yaml build
docker compose --env-file /secure/core/production.env -f ops/production.compose.yaml up -d
docker compose --env-file /secure/core/production.env -f ops/production.compose.yaml ps
```

Caddy uses automatic public HTTPS for both domains. [OrganizationRoutes.caddy](../ops/OrganizationRoutes.caddy) is shared with the standalone proxy: POST draft creation/revision permits exactly 131,072 bytes, the provider webhook 65,536 bytes and other requests 8,192 bytes. Backend admission, session, signature and permission checks still apply. Incoming spoofed peer headers are removed; do not trust arbitrary forwarded IP headers. No Caddy access log is enabled.

Provider integrations are optional and require their protected configuration. Existing verification/drafts overlays target the same `organization-api` service, but review the merged Compose configuration and host paths before use. The combined stack does not silently enable callbacks or share the public index volume with the organization API; enabling webhook observation requires the separately documented read-only index/policy mounts.

## Liveness and readiness

- Settlement `/healthz`: local process liveness; `/readyz`: independently pinned deployment and attached finalized-index readiness. It does not establish complete history or payout liquidity.
- Organization `/healthz`: process liveness only. `/readyz`: bounded fresh testnet RPC status and finalized block reads, plus current database audience/schema and recovery-gate checks. It works without a wallet/session for infrastructure probes and reveals no organization records. Supplied disallowed browser origins are still denied. Identity-RPC failures, stale/syncing/wrong-network results and quarantined storage cannot return ready.
- Organization readiness does not claim actual person/company identity, provider setup, professional rule approval or business write availability. Provider-specific secrets and current wallet access need separate acceptance.

The combined organization container healthcheck uses `/readyz`; the standalone stack keeps its liveness healthcheck for compatibility. Monitor readiness externally. Restart policy recovers process exits, but Docker does not restart a merely unhealthy process automatically. A chain outage should fail readiness and protected identity actions, not erase data.

## External HTTPS verification

Run from an independent machine with normal certificate verification, using [hosting-verification.example.json](../ops/hosting-verification.example.json). Fill actual origins, policy path and independent byte digest. Configuration paths resolve relative to the configuration file. No tokens or signing secrets are accepted. A separately allowed Front origin can be selected for each verification run.

```bash
npm run hosting:verify -- /secure/core/verification.json /secure/core/new-https-report.json
# Compiled runtime, after build:service:
node dist/service/scripts/verify-hosting.js /secure/core/verification.json /secure/core/new-https-report.json
```

The report is exclusively created with mode 0600; existing evidence is never overwritten. Configuration/policy failures exit nonzero and may leave a reserved incomplete output, which is not a valid report. Probes use HTTPS, normal certificate verification, no redirects, bounded bodies and request deadlines. TLS verification disabled through `NODE_TLS_REJECT_UNAUTHORIZED=0` is rejected.

Twelve checks cover service identity, exact expected policy, attached-index readiness, two complete index snapshots with advancing block height/hash, organization RPC/storage readiness, allowed preflight, denied origins, missing-session denial and the larger draft path's upstream admission. Status/body/security-header failures make the report fail; no health-only fallback is accepted. Index sampling defaults to three seconds and can be increased up to thirty seconds for a slow network. A read-only report does not establish full provenance, business writes or successful restart persistence.

After passing external HTTPS probes:

1. Sign in through Front using a controlled testnet wallet. Create/read an organization canary and retain its ID/current membership version without exporting its session token.
2. Obtain consistent settlement and organization backups with the existing separate maintenance commands; store their independent digests and key ring separately.
3. Restart the actual services without replacing volumes, then run the external verifier into a **new** report. Check nonregressing index position and the unchanged canary identity/membership through a fresh authorized session.
4. Record host/provider service IDs, deployed Core commit, DNS names, both reports, restart observations and backup digests in operator-controlled release evidence. Never include session tokens, private documents or key contents.
5. Configure the actual API origins in the Front workspaces and check the browser's real HTTPS/CORS/login flow. Keep R04 open until these observations are collected.

## Local verification versus live qualification

`tests/hosting.test.ts` uses controlled HTTPS transport/RPC fixtures and real local organization HTTP servers. It covers false readiness, source-policy mismatch, stalled/stale/incomplete indexes, CORS/auth boundaries, redirects, deadlines and recovery quarantine. These checks validate behavior, not a reachable hosted backend.

`CORE_CADDY_BIN=/path/to/pinned/caddy node --import tsx tests/manual/hosting-proxy.ts` exercises the actual gateway with local HTTP upstreams: dual origins, exact body boundaries, revision/provider routing and forwarded-header stripping. Public ACME, DNS, Docker deployment, remote persistence and a live test-wallet session remain outside that local test. Official references: [Caddy request limits](https://caddyserver.com/docs/caddyfile/directives/request_body), [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Render disk constraints](https://render.com/docs/disks), [Render health checks](https://render.com/docs/health-checks).

Recorded local validation on **2026-11-14**: **504 Core tests** (16 new hosting/readiness cases), type checking, compiled service/indexer and organization restart/backup/quarantined-restore checks passed. Both changed Compose files passed the official Compose schema; pinned Caddy adapted/validated both configurations and passed the actual local HTTP route/body-limit test. Live read-only RPC readiness reached NEAR testnet finalized block **277609625**. No Docker daemon, external server, domain, public deployed policy or authenticated live business canary was supplied. No external API HTTPS acceptance report or live restart/persistence qualification is claimed.
