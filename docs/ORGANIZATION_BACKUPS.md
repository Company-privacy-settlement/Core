# Organization backup and access recovery

[Organization service](ORGANIZATIONS.md) · [Hosting](HOSTING.md) · [Service overview](SERVICE.md) · [Roadmap](ROADMAP.md)

Organization data uses its own SQLite database. The index backup commands do not accept it. These commands provide a consistent online snapshot and a deliberately separate access-review step: **backup → digest-pinned quarantined restore → current authority review → activation into a new database → controlled cutover**.

A historical membership table cannot tell you who was removed, demoted or replaced after the snapshot. Clearing sessions alone would let those accounts sign in again with their old roles. This workflow therefore never starts the service from a backup or restored file, and never prefills an access approval with historical owners or members. If current authority cannot be established independently, leave the restored database quarantined.

## Backup a running service

Build once from Core and configure the exact Organization API audience and original live database. No settlement policy, wallet key, note, password or RPC call is needed for maintenance.

```sh
npm run build:service
export CORE_ORGANIZATION_ORIGIN=https://organization-api.example.com
export CORE_ORGANIZATION_DB=/srv/core-organizations/live/organizations.sqlite
npm run organizations:backup -- /srv/private-backups/organizations-20261113.sqlite
```

The SQLite online backup interface captures a transactionally consistent snapshot, including committed WAL data, while the live service continues. It does not revoke sessions on the live database. The snapshot is checked for integrity, foreign keys, exact organization schema, testnet audience and the single-owner invariant. Sessions/challenges are removed, free pages compacted, a fresh recovery ID added and journal mode changed to DELETE for a portable single-file artifact. The resulting file is quarantined even if someone tries to open it directly as a service database. Corporate payment requests and call reservations are included when present. Pending, approved and dispatched requests become permanently invalidated; restoring memberships never restores those payment approvals. Reservation history remains available for reconciliation.

The command prints file size, SHA-256 and non-secret counts/recovery metadata. Transfer the expected SHA-256 through an independently trusted channel. Keep the database and access-review records on protected encrypted storage; files use mode `0600`, new directories `0700`. Business names, memberships and historical audit data remain inside the snapshot and are not application-encrypted. Copying a live `.sqlite` file alone is not a consistent backup.

## Restore into quarantine

Select a new destination. Existing main files, SQLite sidecars and symlink destinations are never overwritten. Keep the original volume and live database until recovery and cutover are verified.

```sh
export CORE_ORGANIZATION_DB=/srv/core-organizations/recovery/quarantined.sqlite
npm run organizations:restore -- \
  /srv/private-backups/organizations-20261113.sqlite INDEPENDENT_BACKUP_SHA256
npm run organizations:review-template -- /srv/private-reviews/current-access.json
```

Restore copies and hashes the exact staged bytes before inspection. It accepts only portable, quarantined organization backups for the same audience, rejects raw live/index/unrelated databases, removes authentication state again and gives this restore a new recovery ID. A review for a different restore cannot authorize it. No network/RPC call, original-file mutation or live-database replacement occurs.

Quarantine uses metadata version 2, which older version-1 service binaries also refuse. Only reviewed activation returns the staged output to live schema version 1. This recovery envelope prevents an older binary from bypassing the newer recovery-state gate.

The server refuses to start from a quarantined database. The generated review template contains only organization IDs and the exact recovery/file binding; `ownerAccount`, `currentVersion`, `members` and `reviewedAt` are deliberately blank. A template is not an approval.

## Independently review current access

Reconcile **every** restored organization against the latest trusted authorization records. Do this while the old service is stopped for cutover, or under an independently enforced access-change freeze. A snapshot's own roles, audit history, modified time, checksum and a fresh wallet login do not establish current organizational authority.

Complete the private review file:

```json
{
  "format": "core-organization-access-review-v1",
  "network": "testnet",
  "audience": "https://organization-api.example.com",
  "recoveryId": "EXACT_ID_FROM_TEMPLATE",
  "databaseSha256": "EXACT_SHA256_FROM_TEMPLATE",
  "reviewedAt": "CURRENT_CANONICAL_UTC_TIME",
  "organizations": [
    {
      "id": "EXACT_ORGANIZATION_ID_FROM_TEMPLATE",
      "ownerAccount": "current-owner.testnet",
      "currentVersion": 7,
      "members": [
        { "accountId": "current-owner.testnet", "role": "owner", "currentVersion": 4 },
        { "accountId": "current-viewer.testnet", "role": "viewer", "currentVersion": 3 }
      ]
    }
  ]
}
```

The example is schematic; use real UUIDs/hashes from the template and authoritative current revisions. `currentVersion` on an organization is its latest organization revision; on a member it is the latest membership revision. Each organization must appear exactly once with unique members and exactly one explicitly approved Owner matching `ownerAccount`. Omitted historical members receive no access; there is no implied owner, role merge or fallback to backed-up grants. A current successor absent from the historical snapshot may be explicitly approved using independent current authority.

The file has an 8 MiB limit, supports at most 1,000 organizations and 100 active members each, preserves the ten-owned-organizations/100-memberships account limits, and rejects unknown fields/roles, duplicate accounts, missing organizations and revisions older than the backup. The review time must be within the previous 24 hours (at most one minute of forward skew). This time bound is an approval lifetime, **not proof that the chosen authority records are current**. Obtain the exact review-file SHA-256 through an independently approved channel after review; the operator is responsible for the approval authority. The file is not a wallet signature, KYB decision or public ledger attestation.

## Activate and cut over

Set the new active database path; it must not already exist. The quarantined file remains separate.

```sh
export CORE_ORGANIZATION_DB=/srv/core-organizations/recovered/organizations.sqlite
npm run organizations:activate -- \
  /srv/core-organizations/recovery/quarantined.sqlite \
  /srv/private-reviews/current-access.json INDEPENDENT_APPROVED_REVIEW_SHA256
```

Activation checks the review hash, exact database hash, audience and recovery ID. Inside a transaction on a staged copy it revokes every historical membership and pending invitation, clears sessions/challenges, and grants only the reviewed access. Organization/member revisions advance past the supplied current revisions, preventing old reviewed write versions from matching. Each organization receives a new `organization.recovered` audit event with the recovery ID and review digest. Historical audit entries remain; events lost after the snapshot are not invented or represented as recovered.

An exclusive, fsynced `<quarantined.sqlite>.activation.json` intent prevents competing/replayed activation of that recovery file. Do not delete, rewrite or restore that intent to reuse an old approval. A crash or uncertain result after intent creation stays consumed: inspect any published destination and, if another attempt is necessary, restore the original backup into a **new** quarantine and perform a fresh review. Output publication uses a non-overwriting link after validation/fsync; source snapshots are never edited. A success response includes the new active file and digest.

Stop all old API instances before directing traffic to the new database. A new database cannot revoke tokens still accepted by a forgotten old process. Configure the recovered file as `CORE_ORGANIZATION_DB`, retain the original API audience/approved origins, start the service, and require everyone to sign in again. Verify current owner/member permissions, revoked users, pending invitations, audit and organizational data before reopening access. No maintenance command starts a network service, changes DNS, overwrites a volume, migrates audiences or sends a payment.

The supported workflow prevents automatic authorization rollback. It does not provide a tamper-proof external revocation ledger or protect against a host administrator copying an old active database, removing recovery gates/intents, or deliberately approving historical permissions. Without independent current authority the safe result is quarantine, not a guessed owner reset. Browser backups cannot recover this server database; offline access activation is a reviewed disaster-recovery operation, not a self-service lost-wallet mechanism.

## Container operation

The existing image includes compiled maintenance and launcher entrypoints. The organization Compose service overrides the settlement image's healthcheck to use its own `/healthz`. Run online backup with the existing volume and a protected backup mount:

```sh
docker compose --env-file /absolute/path/organizations.env \
  -f ops/organizations.compose.yaml run --rm \
  -v /srv/private-backups:/backups organization-api \
  node scripts/organization-maintenance.mjs backup /backups/new-organizations.sqlite
```

Use [the new-volume override](../ops/organizations.restore.compose.yaml) for recovery, setting `CORE_ORGANIZATION_RESTORE_VOLUME` to a new dedicated volume. Combine both Compose files and override `CORE_ORGANIZATION_DB=/data/quarantined.sqlite` for restore/template generation, then `/data/organizations.sqlite` for activation/startup. Mount private backup/review directories explicitly. Keep the activation intent with its quarantine volume and the approved digests outside rollback-prone copies. The new-volume name is explicit; templates do not change a running deployment or delete the original volume. Automatic schedules, encrypted off-host transport and retention/pruning are separate operator configuration.

## Validation — 2026-11-13

Fourteen new regressions cover consistent WAL snapshots, unchanged live sessions, quarantined direct-open denial, erased sessions/challenges, non-overwrite/permissions, digest/audience/schema substitution, blank approvals, post-snapshot removals/demotion/ownership transfer, fresh-login authorization, stale invitation and write-version rejection, incomplete/invalid/replayed reviews and concurrent one-use activation and interrupted legacy-gate initialization. Core's full suite passes **303 tests**.

The compiled runtime harness executes the real launcher/CLI through backup, bad-hash rejection, restore, refused quarantined startup, explicit reviewed activation, authentication disposal, omitted-admin/invitation revocation, replay denial and recovered-service health/shutdown. It also retains existing persistent-restart checks. Node/browser SDK builds, Front type/static-build checks and 32 targeted desktop/mobile Docs/organization browser cases also passed. Tests use local temporary data and identity fixtures; no public chain call, live backend deployment or Docker execution is claimed.

## Organization invoice storage

[Organization invoice API](ORGANIZATION_INVOICES.md) adds authenticated organization-owned immutable signed invoices, idempotent creation and AES-256-GCM encryption at rest. Set `CORE_ORGANIZATION_INVOICE_KEYS_FILE` to a separately protected key ring; absent keys disable invoice storage. Database backups preserve ciphertext and retry indexes, never keys. Reviewed recovery and fresh sessions remain required. Existing organization metadata is outside this invoice encryption boundary.

## Payment webhooks

[Signed payment webhooks](WEBHOOKS.md) provide an encrypted durable outbox, stable event IDs, HMAC signatures, bounded retries/dead letters and receiver-side atomic deduplication. The optional worker consumes a pinned local finalized index and only approved HTTPS callback origins. Organization → Webhooks manages callback pause/rotation and failure history. Recovery pauses callbacks and holds outstanding deliveries until current-admin review.

## Worker and contractor payout batches

[Payout batches](PAYOUT_BATCHES.md) group independently approved public requests with resumable/idempotent staging, per-recipient additive fee review, one encrypted journal, individual fixed-destination recovery and observational CSV/JSON settlement reports. Existing corporate note/dispatch reservations and reviewed restore invalidation remain in force; there is no implicit whole-run replay or contract custody.

[Sumsub business/beneficial-owner verification](VERIFICATION.md) adds provider-hosted company/owner review, supplementation, authenticated invalidation, fixed review-date expiry and irreversible local reliance revocation. Restored cases are revoked and need new review; organization roles and permissionless contract execution remain separate.

## Source-bound tax preparation drafts

[AI tax and procedure drafts](TAX_DRAFTS.md) connect verified rule reports and exact selected-receipt bindings to cited English preparation, encrypted organization storage and independent versioned review. AI only arranges verified statement IDs; deterministic outlines are labelled separately. Source/policy/membership expiry suspends internal approval. Restore invalidates all draft reviews and abandons pending generations. No statutory filing or payment is authorized. See the guide for permissions, API, provider configuration and independently pinned reviewer policy.
