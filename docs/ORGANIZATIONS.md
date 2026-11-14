# Organizations, members and roles

[Service overview](SERVICE.md) · [CI](CI.md) · [Hosting](HOSTING.md) · [Roadmap](ROADMAP.md)

[English web guide](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/organizations/) · [Organization workspace](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/organization/). Both retain the existing owner-private Site audience. Web Docs also cover the separate service under SDK/API and organization-specific recovery; no deployed public Organization API is bundled.

Core now has a separate authenticated organization service and an English-first `/organization/` workspace. It provides persistent organization names, wallet-account membership, targeted invitations, fixed roles, ownership transfer, immediate application authorization checks and an organization-scoped audit log. It does not turn a wallet signature into verified corporate identity or grant authority over settlement contracts.

## Identity and service boundary

The browser authenticates to the **Organization API**, independently of the public read-only settlement API. It uses an off-chain [NEP-413 message signature](https://github.com/near/NEPs/blob/master/neps/nep-0413.md). A five-minute random challenge binds the testnet account, service audience, frontend Origin, nonce and expiration. Its recipient is the configured API host. Callback URLs and redirect-return signing are not supported by this flow: choose a wallet returning a signed message directly. The API receives the signature and public key; no payment transaction or private signing key is submitted.

The service verifies Ed25519 over the NEP-413 digest and reads the selected key at a recent finalized block from an HTTPS **testnet** RPC. The key response must report the exact requested block hash and height. A function-call key cannot authenticate. A synchronizing, stale, wrong-network, inconsistent or unavailable RPC fails closed. Starting identity transport with `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused. The response is bounded to 128 KB; requests have a ten-second deadline and eight active work slots. A noncancellable identity adapter retains its slot until it settles.

Successful redemption atomically consumes the challenge and issues a random one-hour bearer session. SQLite stores only its SHA-256 digest, account, public key, approved origin and expiry. Up to ten sessions per account remain active. Every private request rechecks the signing key at finalized chain state, then re-reads the session and current organization membership. Removal of a key takes effect once observed in finalized chain state; a temporarily unavailable RPC denies access rather than using a cached authorization. Role and membership changes apply immediately to the next application check. Expiry/logout during an RPC check wins over the earlier snapshot.

Browser response validation allows up to one minute of clock skew when bounding future expirations. The server's five-minute challenge and one-hour session lifetimes are not extended.

Explicit logout needs only the valid origin-bound session, so an identity RPC outage cannot block revocation. The browser keeps the bearer in memory, never a URL, localStorage or sessionStorage. Editing the service origin, page-hide/history-cache return, unmount and expiry clear credentials/private views and cancel pending work. They do not undo a request already committed by the service. Explicit Sign out revokes the server token; if transport fails, local credentials are still cleared and the unconfirmed server session expires within one hour. Mutations are not automatically retried.

The browser client bounds each request to 25 seconds and preserves HTTP status when a proxy returns non-JSON. Any failed workspace request clears the cached organization, members, invitations, audit and role controls. A failed initial access load also clears the newly established local session. Refresh access and explicitly reselect the organization before another mutation; a timeout or lost response does not establish whether an earlier write committed.

Site access remains independently owner-private. Joining an organization does not add a visitor to the hosted Site, bypass ChatGPT sign-in or change its audience. Authentication here establishes a wallet principal only: `legalIdentityVerified`, `kybVerified` and `walletSigningAuthorityGranted` are never asserted true.

## Roles

| Capability | Owner | Admin | Operator | Viewer | Auditor |
| --- | --- | --- | --- | --- | --- |
| View organization | Yes | Yes | Yes | Yes | Yes |
| Edit workspace name | Yes | Yes | No | No | No |
| Read member directory | Yes | Yes | Yes | No | Yes |
| Manage permitted members/invitations | Yes | Limited | No | No | No |
| Read audit log | Yes | Yes | No | No | Yes |
| Transfer ownership | Yes | No | No | No | No |

An Owner can assign Admin, Operator, Viewer or Auditor. An Admin can invite/change/remove only Operators, Viewers and Auditors, and cannot revoke an Admin invitation. Admins cannot change themselves, other Admins or the Owner. Members other than the Owner may explicitly leave using their own membership version. The server applies these checks, including the target member's current role, within the same SQLite write transaction as the change and audit append.

The role matrix is fixed and frozen in the shared SDK. Operator can read the directory and corporate requests, create a request and execute their own independently approved payment. Owner/Admin can approve another wallet account’s payment. See [corporate payment approval](CORPORATE_PAYMENTS.md) for immutable content, reviewed costs and one-use dispatch. Custom roles, SSO, contract-enforced corporate multisig and wallet execution delegation remain separate work. No payment API silently treats these organization roles as invoice signatures, deployment trust or note ownership.

## Organizations and membership

1. Sign in at `/organization/` using an independently supplied Organization API origin.
2. Select an existing organization or create one with a 2–120 character workspace name. A name is not KYB evidence. Each account may own ten organizations and hold 100 active memberships.
3. Open **Invitations**, enter a NEAR testnet account and a permitted role. No email, Telegram message or anonymous bearer invitation link is sent. The intended account sees a personal invitation inbox after authentication.
4. The recipient explicitly accepts or declines. An invitation expires after seven days. Acceptance rechecks the inviter's active membership, its exact version and permission to grant the role. Changing/removing an inviter or transferring ownership revokes affected unexpired pending invitations and appends the revocation audit in the same transaction. Re-adding an inviter cannot resurrect old authority. The recipient inbox also filters invalid records retained by older server versions, preventing access to later organization names; issuing a replacement cleans up those stale grants.
5. Use **Members** to change a role or remove access. Each organization supports 100 active members and 100 unexpired pending invitations; an account's pending inbox is bounded to 100. Duplicate pending invitations and already-active members are rejected. Rejoining creates a new membership version rather than resetting an old one.
6. An organization has exactly one active Owner. The Owner cannot be removed or demoted through member editing. Explicitly transfer ownership to an active member; the former Owner becomes an Admin. Both membership versions and the organization version advance atomically. There is no lost-wallet or platform-admin owner reset.

Mutations that edit existing records require their returned `version`. Stale versions return `409 VERSION_CONFLICT`; refresh and review before retrying. A successful response means an off-chain access change, not a finalized payment. There is no automatic mutation replay/idempotency key or organization deletion/archive in this version.

## Corporate payment approval

The **Payments** tab provides immutable testnet FT payout requests. Owner/Admin/Operator can prepare their own fee-payer request; a different current Owner/Admin must approve it. Viewer has no financial-request access; Auditor can read. Exact policy, principal, 0.15% fee, proof/recipient/reference and prerequisite calls are bound to the approval digest. Changed terms require cancellation and a new independent approval. Both membership revisions and exact calls are rechecked at final wallet dispatch, with durable one-use reservations and conservative reconciliation. [Workflow, API and limits](CORPORATE_PAYMENTS.md).

Approval applies to the organization API, SDK and supported browser flow. The underlying proof protocol retains permissionless fixed-destination execution; a holder of a public withdrawal plan may relay it separately. Corporate identity, custody and contract-enforced dual approval are not established by an application approval.

## API

All private routes require `Authorization: Bearer <session>` and the exact approved `Origin`. The browser supplies Origin; nonbrowser clients must set it explicitly. No cookies or forwarding headers establish identity. Missing/foreign membership returns the same `404 ORGANIZATION_NOT_FOUND` without disclosing whether a tenant exists. No organization ID or role from a header/body is accepted as authority.

| Method/path | Input / behavior |
| --- | --- |
| `GET /healthz` | Process liveness only; does not establish current identity RPC readiness |
| `POST /v1/auth/challenge` | `{accountId}` → challenge; approved Origin required |
| `POST /v1/auth/login` | `{challengeId, accountId, publicKey, signature}` → one-hour session |
| `POST /v1/auth/logout` | `{}` → revoke the supplied session |
| `GET /v1/me` | Wallet principal/expiry; no verified business claim |
| `GET /v1/me/invitations` | Unexpired pending invitations addressed to this account |
| `POST /v1/me/invitations/:id/accept` or `/decline` | `{version}`; target-account authorization |
| `GET /v1/organizations` | Only this account's active memberships |
| `POST /v1/organizations` | `{name}` → organization with the current principal as Owner |
| `GET /v1/organizations/:id` | Organization, current role/permissions, organization and membership versions |
| `PATCH /v1/organizations/:id` | `{name, version}` |
| `GET /v1/organizations/:id/members` | Active members; role permission required |
| `PATCH /v1/organizations/:id/members/:account` | `{role, version}` |
| `DELETE /v1/organizations/:id/members/:account` | `{version}`; remove or leave |
| `GET` / `POST /v1/organizations/:id/invitations` | List / create `{accountId, role}` |
| `DELETE /v1/organizations/:id/invitations/:invite` | `{version}` |
| `GET /v1/organizations/:id/roles` | Fixed role/permission matrix for a member |
| `POST /v1/organizations/:id/ownership` | `{accountId, version}`; active successor required |
| `GET /v1/organizations/:id/audit?before=<sequence>` | Up to 50 descending events and `nextCursor` |

JSON inputs reject extra fields; bodies are limited to 8 KB. Peer admission is 120 points/minute, authentication routes cost five points, and tracked peers are bounded to 1,024. Forwarded client headers are ignored: clients behind a proxy share its peer budget. Use edge admission controls when qualifying real multiuser hosting. Responses use exact-origin CORS, no-store, nosniff and no-referrer. No request body, signature or bearer is logged by the application or supplied Caddy configuration.

Audit sequences are **per organization**, so gaps do not expose another tenant's activity. Creation, renaming, invitation creation/revocation/acceptance/decline, membership changes/leaving and ownership transfers append in the same transaction. Failed/stale changes roll back their audit append. Audit access is role-gated and paginated. This is an application append-only history; a database administrator can alter it. It is not an independently anchored or tamper-proof tax receipt.

## Run locally

Use Node 22.16+ for the shared compiled service package. From Core:

```sh
export CORE_ORGANIZATION_ORIGIN=http://localhost:3002
export CORE_ORGANIZATION_DB="$PWD/data/organizations/organizations.sqlite"
export CORE_ORGANIZATION_ALLOWED_ORIGINS=http://localhost:3000
export CORE_ORGANIZATION_RPC_URL=https://rpc.testnet.near.org
npm run serve:organizations
```

Use the exact frontend origin actually opened in the browser: `localhost` and `127.0.0.1` differ. In a second process run Front, enter `http://localhost:3002` in Organization, and sign in with a supported funded/existing testnet account. There is no simulated identity fallback in the CLI. Core's settlement policy/RPC and index database are not used by this process.

For compiled execution:

```sh
npm run build:service
npm run serve:organizations:compiled
```

## Hosted configuration and recovery

The [standalone Compose configuration](../ops/organizations.compose.yaml), [environment example](../ops/organizations.env.example) and [Caddy config](../ops/Organizations.Caddyfile) run the compiled organization process using the existing service image, a separate persistent volume and optional HTTPS. From Core:

```sh
docker compose --env-file /absolute/path/organizations.env -f ops/organizations.compose.yaml --profile https up --build -d
```

This standalone proxy owns ports 80/443; on a host already running the settlement proxy, instead integrate the organization service into the existing reverse proxy/network. No host, domain, certificate or public backend is provisioned by these templates. Docker execution and a real public-wallet sign-in must be observed separately before claiming a live service.

The database is separate from the public activity index, protected by owner-only file permissions, WAL and full synchronous transactions. Schema/network/audience metadata rejects an unrelated database or another API audience. Business names, wallet membership and audit metadata are **not encrypted by the application**. Protect the host and use encrypted volumes/backups. Do not send identity documents, beneficial-owner records, salaries, private notes, private keys or passphrases to these routes.

Use the [organization backup and recovery commands](ORGANIZATION_BACKUPS.md) for a consistent online SQLite snapshot. Backups/restores discard sessions and challenges and remain quarantined: the service refuses to start until an independently reviewed current-access file explicitly authorizes every owner/member. Historical grants never become the default approval. Activation revokes all prior memberships and pending invitations, advances reviewed revisions, appends recovery audit and publishes a new file with a one-use activation intent. Missing current authority leaves the data quarantined. A changed audience needs a separate migration; encrypted off-host storage, backup schedules and retention remain operator configuration. The public index backup tool does not accept this different schema.

## Validation scope

Regression tests cover tenant isolation, all five role boundaries, directed/replayed/expired/revoked invitations, nonresurrection after re-adding an inviter, immediate membership/role revocation, stale-write rollback, atomic ownership transfer, per-tenant audit pagination, persisted state and hashed sessions. Authentication uses independently serialized NEP-413 signatures and exercises replay/concurrent redemption, account/origin substitution, expiry, key revocation, cancellation and identity-provider failures. HTTP tests exercise strict schemas, access denial and bounded deadline behavior.

The compiled runtime smoke check covers required audience configuration, health, unauthenticated rejection, persistent database restart and shutdown without a chain call. Front browser fixtures cover role-aware controls, invitation acceptance, role edits, audit display, access revocation, page-hide cancellation and origin changes. Fixtures do not establish a real public-wallet or public-hosting qualification. See [CI](CI.md) for exact-source integration.

Initial organization-access validation on 2026-11-13: Core **256 tests**, including **24 organization regressions**, Front **120 desktop/mobile cases** and three unit cases, type checks, SDK/static builds and both compiled-service runtime harnesses passed. The standalone Compose schema and Caddy configuration were validated; Docker execution and a public Organization API deployment were not performed.

Subsequent [organization recovery validation](ORGANIZATION_BACKUPS.md) passed all **303 Core tests**, the compiled maintenance/service harness, SDK builds and **32 targeted desktop/mobile Docs and organization cases** with Front type/static-build checks. Recovery tests are local and do not establish a live deployment or Docker execution.

Corporate payment validation: all 320 Core tests passed, including 17 approval regressions. The compiled service rehearsal also approves/reserves a payment and verifies that recovery invalidates its approval while preserving the reservation. Browser validation and the exact authority boundary are recorded in [Corporate payments](CORPORATE_PAYMENTS.md).

## Organization invoice storage

[Organization invoice API](ORGANIZATION_INVOICES.md) adds authenticated organization-owned immutable signed invoices, idempotent creation and AES-256-GCM encryption at rest. Set `CORE_ORGANIZATION_INVOICE_KEYS_FILE` to a separately protected key ring; absent keys disable invoice storage. Database backups preserve ciphertext and retry indexes, never keys. Reviewed recovery and fresh sessions remain required. Existing organization metadata is outside this invoice encryption boundary.

## Payment management dashboard

[Organization payment dashboard](PAYMENT_DASHBOARD.md) provides complete-snapshot search, state/asset/group/date filters, CSV/JSON export and finalized-index payment observations in Front `/organization/` → Invoice payments. Signed JSON can be explicitly saved to organization storage. Local creation remains independent. Unknown, stale and incomplete observations remain explicit; exports require current read access.

## Payment webhooks

[Signed payment webhooks](WEBHOOKS.md) provide an encrypted durable outbox, stable event IDs, HMAC signatures, bounded retries/dead letters and receiver-side atomic deduplication. The optional worker consumes a pinned local finalized index and only approved HTTPS callback origins. Organization → Webhooks manages callback pause/rotation and failure history. Recovery pauses callbacks and holds outstanding deliveries until current-admin review.

## Worker and contractor payout batches

[Payout batches](PAYOUT_BATCHES.md) group independently approved public requests with resumable/idempotent staging, per-recipient additive fee review, one encrypted journal, individual fixed-destination recovery and observational CSV/JSON settlement reports. Existing corporate note/dispatch reservations and reviewed restore invalidation remain in force; there is no implicit whole-run replay or contract custody.

[Sumsub business/beneficial-owner verification](VERIFICATION.md) adds provider-hosted company/owner review, supplementation, authenticated invalidation, fixed review-date expiry and irreversible local reliance revocation. Restored cases are revoked and need new review; organization roles and permissionless contract execution remain separate.

[US/Abu Dhabi rule engine](RULES.md) adds seven source-checked component candidates, strict date/jurisdiction/relationship selection, deterministic minor-unit arithmetic and independently pinned reviewer signatures. Front Rules and the local CLI keep calculations separate from payment execution, complete tax liability and filing. No professional approval is bundled.

## Source-bound tax preparation drafts

[AI tax and procedure drafts](TAX_DRAFTS.md) connect verified rule reports and exact selected-receipt bindings to cited English preparation, encrypted organization storage and independent versioned review. AI only arranges verified statement IDs; deterministic outlines are labelled separately. Source/policy/membership expiry suspends internal approval. Restore invalidates all draft reviews and abandons pending generations. No statutory filing or payment is authorized. See the guide for permissions, API, provider configuration and independently pinned reviewer policy.

## Live server acceptance

[Production hosting and HTTPS acceptance](PRODUCTION_HOSTING.md) documents the combined API/indexer/organization stack and external verification command. Organization `/readyz` checks fresh testnet RPC and current storage recovery state without exposing business records; `/healthz` remains liveness only. Infrastructure account, domains and independently verified deployed policy are required. Configuration/local tests are not a live deployment.
