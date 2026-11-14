# Ubuntu API and indexer deployment

Money Station runs two actual loopback services on the selected Ubuntu host (`64.227.151.164`): settlement API plus its single finalized index writer on `127.0.0.1:3331`, and Organization API on `127.0.0.1:3332`. Both passed `/readyz` against actual NEAR testnet RPC on 2026-11-14. The finalized checkpoint advanced and retained 16 indexed records through a controlled worker restart. This qualifies local runtime operation, not public HTTPS or a browser payment journey.

[Recorded local acceptance report](evidence/ubuntu-backend-2026-11-14.json) pins deployed Core `d6ab7c5a37796b26eeb85209a5e4bc18a1b9e319` and runtime `d6ab7c5a3779-b1d5111020f7`. The evidence-only documentation commit can follow that runtime commit; it does not imply a different deployed executable.

## Runtime and isolation

The owner is `jiheon`, not root. State lives outside the checkout under `/home/jiheon/.local/share/money-station/backend/` with mode 0700. Bubblewrap uses separate user, mount and PID namespaces, drops capabilities and mounts the release read-only. Each service sees only its own writable `/data`; neither sees the host home. Host networking allows actual RPC access, while listeners bind only to loopback.

| Path inside deployment root | Purpose |
| --- | --- |
| `releases/<source-prefix>-<manifest-prefix>/` | Compiled service, locked production dependencies, copied Node 22 runtime and per-file SHA-256 manifest |
| `config.json` | Exact origins, loopback ports, RPC and independent native-policy digest |
| `state/api/` | Finalized index, single-writer lock and automatic retained index backups |
| `state/organizations/` | Organization SQLite database; recovery controls remain active |
| `secrets/organizations/invoice-keys.json` | Mode-0600 encryption key ring, outside database backup paths and mounted read-only only in the Organization API |
| `run/`, `logs/` | Owner-scoped manager lock, process status and rotated worker logs |

No NEAR signing key, wallet account file, note secret or provider credential is copied into the runtime. Organization keys are generated once; never delete or regenerate them during an update. Preserve a separately protected backup of these keys before storing business invoices. Database backups alone cannot decrypt those invoices.

The owner supervisor restarts exited workers with bounded backoff. Each Node process has a 256 MiB V8 heap limit, 1,024 file descriptors, disabled core dumps and lower scheduling priority. These are not total-memory/CPU cgroup limits. An owner `@reboot` cron entry starts the manager without requiring a login; other cron entries are preserved. A host reboot has not been performed as part of this acceptance. Process exits are supervised; a service that remains alive but unready needs monitoring and investigation.

## Prepare and operate

Run as `jiheon`, from a clean committed Core checkout with Node 22.13+ and its locked development dependencies already installed. The host needs Python 3.11+, Bubblewrap with working unprivileged user namespaces, cron, `flock`, `nice` and `prlimit`.

```bash
node ops/ubuntu/prepare-backend.mjs
python3 /home/jiheon/.local/share/money-station/backend/control.py start
python3 /home/jiheon/.local/share/money-station/backend/control.py autostart
python3 /home/jiheon/.local/share/money-station/backend/control.py status
python3 ops/ubuntu/verify-backend.py --restart --output /tmp/new-backend-acceptance.json
```

Preparation compiles the service, installs only locked production dependencies without lifecycle scripts, verifies the independent policy digest, copies the current Node executable and atomically selects a versioned release. It never starts a payment signer. Preparation requires a clean committed tree so the manifest source pin is meaningful. Keep updates serialized. Preserve the previous `config.json` before preparing an update.

For runtime updates, `restart` signals the existing manager to gracefully stop its children, reload the prepared configuration, verify its manifest and start the workers using the existing databases and key ring. If `manage-backend.py` itself changed, use `stop`, wait for the old manager to exit, then `start`; a worker restart does not reload Python supervisor code. Rollback selects the previous retained release in `config.json` and restarts workers; never roll back a database schema without its documented migration/recovery procedure.

`verify-backend.py` checks actual RPC readiness, the exact policy, allowed/disallowed origins, missing-session denial, filesystem boundaries, the active writer lock, an advancing finalized checkpoint and optional worker restart with preserved database/key bytes. It does not sign in or write organization business data. Reports are created exclusively; choose a new output path on each run.

## Shared public API gateway

Front's reviewed Ubuntu HTTPS configuration uses a single API audience, `https://api.moneystation.site`, with disjoint paths:

| Public path | Loopback service |
| --- | --- |
| `/healthz`, `/readyz`, settlement/index routes | Settlement API `3331` |
| `/healthz/organizations`, `/readyz/organizations` | Organization probes `3332`, mapped to `/healthz` and `/readyz` |
| `/v1/auth/*`, `/v1/me`, `/v1/organizations` and child routes | Organization API `3332` |
| `/v1/providers/sumsub/webhook` | Organization API; actual provider remains disabled |

Both runtimes allow the exact browser origin `https://moneystation.site`. Organization signatures retain the exact shared API audience; no path or host rewriting changes that audience. Nginx strips untrusted peer headers and retains the existing 8,192-byte default, 65,536-byte provider and 131,072-byte draft-body limits. The static frontend installer does not launch these backend processes. The frontend has now been promoted to the root-installed systemd service on port 3330. The real HTTP domain route is installed, and both backend services stayed ready during promotion. The owner frontend reboot entry was removed; the backend entry remains.

The existing Docker/Caddy profile and `hosting:verify` continue to require two distinct API origins. They are a separate deployment profile; do not use their verifier as acceptance for this path-routed configuration. Front's `tests/manual/ubuntu-hosting.py --live-backends <archive> <sha256>` exercises the actual shared Nginx routes with a temporary explicitly trusted certificate and the real loopback services. This establishes local routing/CORS/auth behavior, not a public certificate.

## Remaining external acceptance

At the dated DNS check, both public lookup and the `.site` authoritative server returned NXDOMAIN. The root frontend service and HTTP host gateway are installed; API HTTP access requires TLS. Public ACME certificates and HTTPS activation still await working DNS. After both DNS names reach this host, `activate-https.sh` checks the frontend and both API readiness routes over normal HTTPS. Collect independent external HTTPS evidence and a current wallet-authenticated organization canary before closing hosted-service qualification.

The runtime uses the independently pinned native NEAR testnet policy, not the browser FT/USDC policy. Actual browser-wallet USDC payment/recovery, a funded relay, real KYB/tax/AI providers, full index provenance and production security review remain separate acceptance items. The service holds no user payment signing key.
