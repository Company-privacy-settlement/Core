# Corporate payment approval

[Organizations](ORGANIZATIONS.md) · [Wallet execution](WALLET.md) · [Organization recovery](ORGANIZATION_BACKUPS.md) · [Service overview](SERVICE.md)

The Organization workspace's **Payments** tab connects an authenticated creator, a different approver and the creator's fee-payer wallet. It supports single-note testnet FT withdrawals with the existing fixed denomination, circuit and additive 0.15% withdrawal fee. Approval is a deliberate API action under a wallet-authenticated organization session; it does not silently request a wallet transaction or confer signing keys.

## Authority boundary

These controls apply to the authenticated Organization API, the settlement SDK guards and the supported Front wallet adapter. The underlying contracts retain their existing permissionless fixed-destination proof execution. A holder of a valid public withdrawal plan can relay it outside this workflow, including before an application approval. Organization approval is therefore not contract-enforced dual authorization or corporate treasury custody. A contract-enforced organization policy needs a separately reviewed/versioned contract and proof/action design; existing notes and groups are not changed here.

Separation is by **wallet account**, not verified real-world person. Different keys of one account cannot self-approve; two accounts are not proof of two independent people or a verified company. Current FullAccess ownership authenticates API requests. The server stores approval state and canonical content digests; these are not independent approver signatures or tamper-proof public attestations. Protect the organization service, database and release chain accordingly.

## Roles and payment flow

| Action | Owner | Admin | Operator | Viewer | Auditor |
| --- | --- | --- | --- | --- | --- |
| Read corporate payment requests | Yes | Yes | Yes | No | Yes |
| Create a request as its fee payer | Yes | Yes | Yes | No | No |
| Approve/reject another account's request | Yes | Yes | No | No | No |
| Execute own independently approved request | Yes | Yes | Yes | No | No |

1. Sign in at `/organization/`, choose the organization and open **Payments**. Configure the matching Core settlement API and import an independently trusted testnet FT policy.
2. Generate an FT withdrawal proof locally through Local proofs or the CLI. For an invoice reference, use its exact signed-derived action when preparing that proof. Under **Prepare a new payment**, import only its public withdrawal plan and enter a title. The signed-in creator must also be the configured fee payer. No private note, witness, password or wallet key is accepted.
3. Choose **Request independent approval**. The app verifies the API policy and current payout preflight, then records the normalized payment and exact allowed prerequisite calls. An unresolved readiness blocker prevents creation. The service fixes the request's 24-hour expiry and creator membership revision.
4. A different current Owner or Admin opens the request, independently trusts the same policy, reviews the title, recipient, token, full principal, 0.15% withdrawal fee, maximum attached NEAR, payment reference, expiry and exact calls, then chooses **Approve exact payment**. Rejection is explicit. All approvals recheck the displayed content hash and record version. An Owner/Admin cannot approve their own request.
5. The creator refreshes Payments and opens **Execute the approved payment** with the encrypted operation journal. The matching Core API is reverified. The journal uses the existing original-group namespace and can observe an existing matching operation without importing another intent. Preserve its encrypted backup and the separate private note backup.
6. Review and sign each exact prerequisite and payment separately. After fresh Core preflight and identity work, the supported wallet adapter calls the Organization API immediately before provider dispatch. The server rechecks creator/executor identity, both current memberships and their exact revisions, approval state/expiry, content digest and the complete canonical call. It durably reserves that call once. A changed storage/registration charge, token, recipient, proof, reference, policy, fee or attachment cannot use the old approval.
7. Follow the journal's finalized contract observation. A server reservation is not a transaction, payout or invoice confirmation. Read-only polling is bounded to ten attempts, two seconds apart. Unknown outcomes require original-transaction reconciliation and never automatically resend.

Corporate requests currently approve public withdrawal calls; they do not store signed invoice terms or automatically apply invoice checkout’s current-merchant, per-unit-status or deadline gates. Review those invoice terms independently when using an invoice-derived reference. Consumer invoice checkout remains its own guarded flow.

The amount display uses token atomic units. Principal comes from the funded private note; the creator's wallet pays the separate withdrawal protocol fee. Previously paid deposit fees, NEAR network gas and prerequisite attachments are distinct. The approved maximum attachment is the sum of the reviewed prerequisite calls and payment's one-yocto attachment; it is not an estimate or cap on variable network gas prices.

## Immutable requests and recovery

There is no payment-edit endpoint. A proposal includes a fresh ID, organization ID, creator account/membership revision, fixed expiry and normalized content. SHA-256 over canonical JSON binds all those fields. Derived amounts come from the trusted policy; client-supplied display quotes are not authority. Reads validate stored payload/hash bindings, and the SDK independently rechecks the returned content/hash before review or execution.

To change a request, cancel it before any dispatch reservation and create a new request requiring a new independent approval. Current authorized approvers can cancel; a creator can cancel their own request. A rejected/cancelled request retains its immutable content and audit history. Each organization keeps at most 100 requests; history is not deleted to free spent-note or approval reservations. A note cannot have another live/reserved/invalidated request in the same organization. Different organizations/devices and direct protocol users remain outside that local reservation boundary.

Removing, demoting, re-adding or transferring either principal changes its membership revision and invalidates the previous approval. An expired request cannot be newly approved or dispatched. The checks happen again in the same SQLite transaction as each dispatch reservation. Approval checking does not cancel a prompt already handed to an external wallet or provide a global on-chain revocation instant.

Reservations remain consumed after a lost HTTP response, rejected/closed wallet prompt, unknown provider response or a lifecycle lock. There is no reset/resend endpoint. Even an unused-looking reservation can be ambiguous. The original journal and bound chain record decide recovery; a server `dispatched` state only says the payment call was reserved. Fixed-recipient retry/refund paths for already accepted funds retain the existing SDK recovery behavior, including after expiry or role changes; they do not create a newly approved payout. Generic Settlements can restore/reconcile the original encrypted journal independently when organization access is unavailable.

Page-hide/cache entry, tab changes, logout, service-origin changes and unmount lock the embedded journal or clear the organization session/private views. Pending late authorization results cannot dispatch after a journal lock. Sessions stay in memory. Wallet adapters must advertise `supportsBeforeDispatch: true` and await `context.beforeDispatch()` once immediately before the provider call, then invoke the existing synchronous authorization callback. Adapters without this capability are rejected before a corporate signing intent is recorded. Claiming capability while ignoring its callback violates the wallet-adapter trust contract.

Organization backup/restore invalidates pending, approved and dispatched requests while preserving their content and call reservations for reconciliation. Reapproving memberships does not reapprove payments. Recovery cannot infer unrecorded later execution from an older snapshot. An invalidated note reservation is not silently released; original-chain/journal reconciliation remains necessary. Legacy databases/backups without payment tables remain supported, while new payment tables participate in the closed backup inventory.

## API and SDK

Private routes use the existing origin-bound bearer session, current FullAccess-key check, rate/work budgets, 8 KB body limit and no-store responses. Organization and payment IDs never grant authority. List/detail access is separately permission-gated; foreign tenants are not disclosed.

| Method/path, under `/v1/organizations/:org/payments` | Input / result |
| --- | --- |
| `GET /` | At most 100 immutable requests and computed current approval validity |
| `POST /` | `CorporateContent`: format, title, policy, payer, payment, prerequisites |
| `GET /:payment` | Payload, digest, state/version, approver metadata and reservation hashes |
| `POST /:payment/approve` or `/reject` | `{version, contentHash}`; another current Owner/Admin |
| `POST /:payment/cancel` | `{version, contentHash}`; creator or permitted approver, no reservation |
| `POST /:payment/authorize` | `{contentHash, kind, call}`; creator only; exact allowed call reserved once |

The short-lived authorization response binds content hash and call hash and expires within 15 seconds or at the proposal deadline. It is not a reusable bearer capability. The same call cannot be claimed twice; after the payment call is reserved, further new dispatch is blocked. Changed prerequisites need a different request and fresh approval, rather than an automatic increase to an existing approval.

`corporateContent()` normalizes/validates public terms; `verifyCorporatePayment()` checks payload/content bindings; `corporateQuote()` derives principal, fee and approved attachments. Install `corporateSettlementGuards(client, approvedPayment)` as the fifth `SettlementSession` argument and use a supporting wallet adapter. The API client never persists bearer tokens. The journal persists the exact call before final authorization and provider dispatch; failures remain conservative unresolved intents.

Creation, approval, rejection, cancellation and dispatch reservation append organization-scoped audit in their write transaction. Failed requests append no successful audit event. Titles, public proofs/calls, accounts and their approval relationship are stored off-chain without application encryption, like existing organization metadata. No signing key, private note or witness is stored. The database administrator remains able to alter application history; encryption/access/retention and independent attestations are separate work.

## Validation

Seventeen new Core regressions cover owner/admin self-approval denial, role/tenant isolation, immutable fields and derived fees, optimistic version/hash checks, membership revision revocation, expiry/cancellation, exact prerequisite matching, durable one-use reservations, asynchronous session invalidation, backup invalidation, SDK review/dispatch/finality, unsupported adapters, last-moment revocation, lost results and actual HTTP routes. The complete Core suite passes 320 tests. The complete Front run passes **164 desktop/mobile browser cases**, including all 16 new corporate cases and the existing actual browser-proving cases with reviewed local artifacts. Front type/static-build checks, three unit cases and Node/browser SDK builds also pass. Corporate browser regressions exercise creator/reviewer pages, fixed costs, separate storage/payment approvals, altered content, viewer restrictions, final-identity revocation, lost authorization/provider responses, changed storage costs and page-cache locking through injected wallet/public API fixtures. A compiled-service rehearsal includes corporate approval/reservation and verifies that restore invalidates the approval while retaining its reservation.

These are local service and browser validations. Public-network funded-wallet execution, live backend hosting, physical-device qualification and contract-enforced corporate approval remain separate work.
