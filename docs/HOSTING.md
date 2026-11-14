# Core API and indexer hosting

[Service overview](SERVICE.md) · [Testnet deployment](DEPLOYMENT.md) · [Indexer](INDEXER.md) · [API operations](OPERATIONS.md)

This deployment runs the read-only API and one finalized-index writer together, using a persistent local SQLite volume. A supervised bootstrap catches the index up before starting the API. Unexpected exit of either process stops the other and exits nonzero so the hosting platform can restart the service. Neither process signs or broadcasts settlement transactions.

The repository provides a compiled Node runtime, Docker image, Docker Compose with optional Caddy HTTPS, and an optional Render blueprint. Files alone are not a live deployment: a selected host/account, writable persistent volume, verified deployed testnet policy and actual DNS/HTTPS endpoint are still required. The earlier sandbox releases and placeholder policies do not establish a funded public group.

## Organization service hosting

This guide's supervisor, index readiness, `CORE_DATA_DIR`, index backup/restore and Render blueprint concern the **public settlement API/indexer**. The authenticated [Organization API](ORGANIZATIONS.md#hosted-configuration-and-recovery) is a separate process and database. Its [standalone Compose stack](../ops/organizations.compose.yaml) uses the compiled service image with an organization-specific command, volume, origin and frontend allowlist. Organization membership does not change Site audience or settlement signing rights.

The organization `/healthz` endpoint is liveness only. The new `/readyz` checks fresh testnet identity RPC/finalized state and the database recovery gate. Do not use the public index restore tool for the organization database. A historical organization snapshot can restore revoked memberships or sessions; operator review, session/challenge invalidation and reconciliation are required before access is reopened. Organization backup/restore and reviewed access activation tooling are implemented. Actual public hosting still requires operator target/access and external acceptance.

## Prerequisites and configuration

- Hosted runtime: Linux, `flock`, **Node.js 22.16+** for the SQLite online-backup API. Individual SDK/API development keeps its existing engine requirement. The Docker image supplies the hosted runtime and runs application processes as `node`, not root.
- A policy obtained independently and checked against the keyless on-chain group. Use [deploy:verify](DEPLOYMENT.md) before hosting a new deployment.
- Exact SHA-256 of the policy file bytes, including whitespace/newlines. This is different from the backup metadata’s canonical-policy fingerprint.
- A matching HTTPS RPC, exact Front CORS origins and a writable persistent data directory. Public mode accepts testnet only and requires indexed readiness. Sandbox mode is explicitly restricted to loopback API/RPC for local tests.
- No deployer key file, note/receipt passwords or disabled TLS verification in the hosted process environment. Keep signing tools and business-document storage separate.

Use either `CORE_POLICY_FILE` or `CORE_POLICY_JSON`, never both. Inline JSON must have the exact bytes matching `CORE_POLICY_SHA256`. Startup verifies the digest/schema and copies the policy to a hash-named file in the data directory; child processes read this snapshot. Changing the original config file cannot silently change a running worker/API’s policy. Changing the group requires a separately reviewed database/data directory, not overwriting an existing index.

| Setting | Hosted behavior |
| --- | --- |
| `CORE_DATA_DIR` | Persistent directory; image defaults to `/data` |
| `CORE_INDEX_DB` | Fixed to `<CORE_DATA_DIR>/activity.sqlite`; conflicting paths are rejected |
| `CORE_POLICY_SHA256` | Required, independently reviewed policy file digest |
| `CORE_API_REQUIRE_INDEX` | Always true; explicitly disabling it is rejected |
| `CORE_ALLOWED_ORIGINS` | Required exact origins; HTTPS or loopback HTTP, no wildcard/path/credentials |
| `PORT`, `CORE_API_HOST` | Default 3001 / `0.0.0.0`; sandbox requires `127.0.0.1` |
| `CORE_SERVICE_BOOTSTRAP_MS` | Default 120,000 ms, maximum 900,000; bounded initial catch-up |
| `CORE_SERVICE_SHUTDOWN_MS` | Default 10,000 ms per child; API stops before writer |
| `CORE_BACKUP_INTERVAL_MS` | Default 21,600,000 ms (6 hours); explicit `0` disables automatic backups |
| `CORE_BACKUP_KEEP` | Default 7 complete snapshots, not 7 days; range 1–90 |
| `CORE_DISCOVERY_START_HEIGHT` | Optional reviewed existing start height; empty/invalid values are rejected |

Existing API admission/RPC/readiness limits remain available through the environment. CORS is a browser-origin restriction, not authentication; current endpoints expose public settlement data, not merchant terms or KYB files.

## VPS: Docker Compose and HTTPS

Check out Core on the target host at a reviewed commit. Install Docker Engine/Compose v2 and point your API domain’s DNS to that host. Only Caddy’s 80/443 ports are published; the API’s 3001 port remains inside the Compose network.

```sh
cp ops/service.env.example /secure/path/core-service.env
# Fill the existing policy path, exact file digest, Front origins, API domain and TLS email.
sha256sum /absolute/path/trusted-policy.json

docker compose --env-file /secure/path/core-service.env --profile https config
docker compose --env-file /secure/path/core-service.env --profile https up -d --build
docker compose --env-file /secure/path/core-service.env logs --tail 100 api
```

The Node/Caddy base images are pinned by digest. The Docker build excludes notes, keys, `.env`, SQLite files, sandbox reports and generated proving artifacts; the final image contains compiled service code and locked production dependencies. It needs no TypeScript runner, Rust toolchain or local proving setup at runtime.

The data volume must be writable by UID/GID 1000. A fresh Docker named volume inherits `/data` ownership from the image. Existing bind/provider disks need appropriate ownership provisioned by their administrator; do not use world-writable permissions. Runtime intentionally does not perform root ownership changes. Do not start multiple writers or scale this SQLite service above one instance.

Caddy obtains HTTPS for the configured real domain, disables caching and checks `/readyz` before treating the upstream as healthy. Its certificate storage is separate from API data. Caddy access logging is not enabled. The API does not trust forwarded IP headers; callers behind a proxy share its direct-peer admission budget, so tune reviewed limits/edge controls for your expected traffic instead of trusting arbitrary `X-Forwarded-For` values.

Enable bounded all-shard discovery only with an appropriate archival RPC and reviewed start block:

```sh
CORE_DISCOVERY_START_HEIGHT=REVIEWED_HEIGHT docker compose \
  --env-file /secure/path/core-service.env \
  -f compose.yaml -f ops/discovery.compose.yaml --profile https up -d
```

Discovery configuration/coverage remains explicit and does not imply complete business history. Without discovery or supplied references, registry records are indexed while originating-transaction provenance may remain unresolved.

## Optional Render deployment

[render.yaml](../render.yaml) describes **one Docker web service with a paid persistent disk**, not separate web/worker services sharing a disk. Review the selected compute/disk cost before creating it. Supply exact policy JSON/digest and Front origins through the hosting account; no placeholder policy is auto-filled. Automatic deployments are off. The platform supplies HTTPS; Caddy is not used on this path.

Check disk permissions for the image’s UID 1000, mount it at `/data`, and require `/readyz` to pass. A persistent disk prevents multi-instance scaling and zero-downtime instance replacement. Do not run index writers or restores in one-off jobs that do not mount the service disk. Use the running instance’s administrative shell for online backups, and a deliberately provisioned empty destination/volume for restore.

This repository does not provision a paid Render service simply by adding the blueprint. Actual deployment needs a connected hosting account and the reviewed policy. [Render disk constraints](https://render.com/docs/disks) and [blueprint reference](https://render.com/docs/blueprint-spec).

## Process supervision and readiness

`npm run build:service` emits `dist/service/`. `npm run serve:service` acquires an OS `flock` for the selected data directory before starting the supervisor. A stale lock file after a crash is harmless: the kernel releases the advisory lock. Unlike deployment signing journals, no manual lock-file deletion is needed here.

Startup verifies RPC network/freshness, runs bounded finalized indexing until the attached index is caught up, and then starts API and watch mode. API connections open the database read-only/query-only; the worker is the only writer. Shutdown stops the API first, cancels worker RPC transport, closes stores and bounds termination before force-killing a stuck child. A failed/finality-conflicting database is never reset automatically.

- `/healthz`: process liveness. Docker’s health check uses it.
- `/readyz`: independently pinned deployment and attached-index age/lag/count check. Caddy and Render use it for routing readiness.
- Worker/API exit: the supervisor stops its peer and exits; Docker `restart: unless-stopped` or the host restarts the container.
- RPC outage/index lag: readiness fails; watch mode retries bounded reads. Docker “unhealthy” alone does not restart a container, and liveness is not a liquidity/complete-provenance claim. Monitor readiness, lag, disk use, restart loops and backup-failure events externally.

Same-volume migration and rollback require review. Preserve the old data/backup, verify schema/policy compatibility, and avoid attaching an older image to a newer schema blindly. The initial bootstrap refuses mismatched policies/finality; there is no automatic destructive rollback.

## Online backup and protected restore

Automatic backups use Node’s SQLite online-backup API, not copying a live database without its WAL. Snapshots are checked with SQLite integrity and Core policy/checkpoint validation, then published with a digest and metadata. Only complete, verified service-owned files matching the configured policy are pruned. Unrelated/malformed files are retained.

```sh
# In the running service/container. Destination must be new.
node scripts/index-maintenance.mjs backup /data/backups/manual-snapshot.sqlite
```

The JSON returns file SHA-256, byte size, policy fingerprint and indexed status. Keep the digest through an authenticated channel independent of the backup file. Backups contain public indexed chain data; no private notes, signing keys or business terms are added. Same-disk snapshots do not protect against losing the entire disk: export verified snapshots to separately controlled storage. No off-host backup account/credentials are configured by this change.

Restore only into a **new index destination**, keeping the old volume untouched. It refuses an existing `.sqlite`, WAL or SHM file, verifies the independently trusted digest and copied snapshot’s Core policy/schema before publishing it. Restore acquires the same service lock and cannot run against a live service in that data directory.

```sh
# Stop the old instance, and provision/mount a new writable data directory or volume.
# Keep the original directory/volume intact. Set matching policy configuration first.
export CORE_DATA_DIR=/path/new-empty-service-data
npm run index:restore -- /path/manual-snapshot.sqlite INDEPENDENT_BACKUP_SHA256
npm run serve:service
```

For Compose, [the restore override](../ops/restore.compose.yaml) selects a new dedicated volume while preserving the original. Stop the old instance, choose a new `CORE_RESTORE_VOLUME` name, and mount the independently verified backup read-only:

```sh
docker compose --env-file /secure/path/core-service.env --profile https stop https api
export CORE_RESTORE_VOLUME=core-restore-REVIEWED_UNIQUE_NAME
docker compose --env-file /secure/path/core-service.env \
  -f compose.yaml -f ops/restore.compose.yaml run --rm \
  --volume /absolute/path/backups:/restore:ro api \
  node scripts/index-maintenance.mjs restore /restore/manual-snapshot.sqlite INDEPENDENT_BACKUP_SHA256
docker compose --env-file /secure/path/core-service.env \
  -f compose.yaml -f ops/restore.compose.yaml --profile https up -d
```

Retain the selected override/volume in subsequent commands; omitting it switches back to the original volume. Do not install build tools inside the runtime image. Validate `/readyz`, checkpoint/counts, activity and provenance after restoration before routing clients back. Provider disk snapshots are not a substitute for a consistent SQLite backup. [Node online-backup API](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html).

## Validation and current deployment state

`npm test` covers policy pinning/snapshot isolation, unsafe configuration, online WAL backup, checksum/policy-bound restore, safe retention, bootstrap failure, peer-process termination and API-before-writer shutdown.

```sh
npm run check
npm test
npm run build:service
npm run test:service-runtime
```

The compiled-process test uses a labelled local mock RPC, real API/indexer child processes and an actual persistent SQLite file. It checks readiness, new records, same-data restart, exclusive writer rejection, online backup, blocked live restore, new-destination restore and termination while an RPC is hanging. It is not public-chain/HTTPS hosting evidence.

Compose/discovery overrides and the Render blueprint are checked against their published schemas. CI additionally builds the Docker image and checks its unprivileged/fail-closed runtime. A live deployment still needs target credentials/access, an actual deployed testnet policy and a verified HTTPS URL; no such URL is fabricated from local tests or a configuration file.

Recorded on 2026-11-13: Core type checking and **223 tests** passed; Node/browser SDK and compiled-service builds passed. The actual compiled-process runtime test passed restart persistence, exclusive writer, online backup/protected restore and interrupted-RPC shutdown. Compose/discovery/restore and Render schemas were checked; the pinned Caddy 2.11.9 binary validated the HTTPS proxy configuration without starting a server. Docker is absent in the local workspace, so image build/runtime checks are delegated to the dedicated CI job. No external hosting target or actual deployed testnet policy was supplied during this work; no live public API URL or external deployment is claimed.

## Organization data recovery

The Organization API uses a separate database and [dedicated backup/recovery commands](ORGANIZATION_BACKUPS.md). Its snapshots are quarantined and cannot start a service until independently reviewed current access is applied to a new active file. Sessions/challenges and prior pending invitation authority are discarded; historical owners/members are not automatically reauthorized. Use the organization Compose healthcheck and [new-volume recovery override](../ops/organizations.restore.compose.yaml); settlement-index restore commands do not accept this schema.

## Organization invoice storage

[Organization invoice API](ORGANIZATION_INVOICES.md) adds authenticated organization-owned immutable signed invoices, idempotent creation and AES-256-GCM encryption at rest. Set `CORE_ORGANIZATION_INVOICE_KEYS_FILE` to a separately protected key ring; absent keys disable invoice storage. Database backups preserve ciphertext and retry indexes, never keys. Reviewed recovery and fresh sessions remain required. Existing organization metadata is outside this invoice encryption boundary.

## Payment webhooks

[Signed payment webhooks](WEBHOOKS.md) provide an encrypted durable outbox, stable event IDs, HMAC signatures, bounded retries/dead letters and receiver-side atomic deduplication. The optional worker consumes a pinned local finalized index and only approved HTTPS callback origins. Organization → Webhooks manages callback pause/rotation and failure history. Recovery pauses callbacks and holds outstanding deliveries until current-admin review.

[Sumsub business/beneficial-owner verification](VERIFICATION.md) adds provider-hosted company/owner review, supplementation, authenticated invalidation, fixed review-date expiry and irreversible local reliance revocation. Restored cases are revoked and need new review; organization roles and permissionless contract execution remain separate.

## Source-bound tax preparation drafts

[AI tax and procedure drafts](TAX_DRAFTS.md) connect verified rule reports and exact selected-receipt bindings to cited English preparation, encrypted organization storage and independent versioned review. AI only arranges verified statement IDs; deterministic outlines are labelled separately. Source/policy/membership expiry suspends internal approval. Restore invalidates all draft reviews and abandons pending generations. No statutory filing or payment is authorized. See the guide for permissions, API, provider configuration and independently pinned reviewer policy.

## Combined live deployment and acceptance

[Production hosting](PRODUCTION_HOSTING.md) provides the one-host, single-gateway stack, exact route-specific body limits, organization RPC/storage readiness and twelve external HTTPS acceptance checks. Hosting account/SSH target, actual domains and a verified deployed testnet policy are still missing; no backend has been publicly deployed from this workspace. R04 remains open.
