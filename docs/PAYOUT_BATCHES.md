# Worker and contractor payout batches

Front `/organization/` → **Payouts** groups 1–20 immutable public corporate withdrawal requests into a run. Each row spends a distinct funded note under one independently trusted testnet FT policy and fee payer. A different Owner/Admin approves **each recipient's exact content**. The creator signs each prerequisite/payment separately and can recover accepted failures at their original destination. Batch dispatch is non-atomic: a failed or uncertain row does not undo completed recipients and never triggers a replay of the whole run.

The service does not hold principal, private notes or wallet keys. Existing independent vault payouts, note/global-nullifier rules and 0.15% additive deposit/withdrawal fees retain their behavior. Worker/contractor categories are declarations, not verified employment, tax withholding, KYB or legal qualification. The current protocol supports fixed-denomination note payments; repeat a recipient with different notes for multiple units and split larger runs into more batches. Arbitrary decimal salary amounts/fiat conversion and automatic withholding are outside this version.

## Prepare and approve

1. Generate each recipient-bound public FT withdrawal plan with Local proofs or the Core CLI using a **different funded note**. Keep the original group policy and encrypted note backups. The manifest contains public calls only, never note secrets/witnesses or wallet keys.
2. Save a public `core-payout-manifest-v1` file with a stable batch `requestId`, a reference/title and up to 20 entries: `{intentId: UUID, category: 'worker'|'contractor', content: CorporateContent}`. Use a stable, distinct intent ID for each row. Every content uses the same creator/policy; principal and 0.15% fee derive from the exact fixed denomination, not a client amount field. [Template](../examples/payout-manifest.template.json) contains intentionally unusable policy/proof placeholders.
3. Sign in as the fee payer, select the organization and open Payouts. Under Payout source, independently import the trusted policy and enter its matching Core API. Import the manifest and choose **Prepare recipient requests**. Each request is durably staged with idempotency before the immutable batch links are committed. A lost response/partial preparation can resume the same saved file without a second payment request. No wallet transfer occurs during preparation.
4. Another current Owner/Admin selects the run and a recipient. Review the full principal, added token fee, exact calls, maximum reviewed attachments, recipient and creator, then **Approve recipient payment**. Readiness and presently required prerequisite charges must fit the immutable permitted calls. A problem with one recipient does not approve/reject another. The creator cannot self-approve, including when they are an Owner/Admin. The original 24-hour row expiry and maker/approver membership-revision checks remain active.
5. Return to the creator's wallet and refresh the run. Unlock/create the original group's encrypted payout journal once. Select an approved recipient, review its next exact call and approve it in the wallet. Review each next recipient in the same unlocked batch journal. Changing organization/source, page-hide, logout, role change or unmount locks the journal. No batch action submits all recipients implicitly.

The category/reference are operational metadata. Use wallet addresses and non-sensitive references; no employee name, identification or tax-document schema is accepted. Like the pre-existing corporate approval requests, public calls, titles, batch/category relationships and approval history are stored without application encryption in the owner-only organization DB. This differs from the separately encrypted invoice/webhook stores; do not treat this as end-to-end encrypted payroll. Browser sessions and unlocked journal keys remain in memory, with only encrypted journal operations persisted.

### Storage and fee review

Recipient principal is paid from its funded vault note. The creator wallet sends the **additional** withdrawal token fee (`floor(denomination × 15 / 10000)`), so recipients receive full principal. Prior deposit fees, recipient token registration, storage-credit/bond attachments, variable network gas and recovery attachments are separate.

Independent rows may need different storage prepayments as the shared sender ledger initializes. If both are applicable, explicitly include and review the initial `0.025 NEAR` and subsequent `0.02 NEAR` `prepay_storage` alternatives in each public content before approval. They are distinct allowed calls, each reserved at most once per row; approval never silently adds or increases one. Preflight chooses the presently required call. If a token registration minimum or another prerequisite changes outside the reviewed set, the old approval cannot dispatch it. Prepare replacement content with new independent approval before any dispatch; do not edit an approved request.

The maximum reviewed attachment is the **sum of permitted calls**, including alternatives that may not all be needed. It is not an actual gas/expense report or a total lifetime cap on recovery. The supported review enforces exact canonical calls and charges again immediately before provider dispatch through the existing [corporate guards](CORPORATE_PAYMENTS.md).

## Individual failures and settlement

**Reconcile recipient payouts** reads the matching Core API's finalized, recipient/vault/reference-bound withdrawal state independently for every row. One unavailable result does not erase other confirmations. The table shows approval and chain state separately: `dispatched` is a durable reservation, not a payment. Missing records are `unobserved`, never an instruction to resend. Recent observations become stale after five minutes in the browser; current-chain freshness is not asserted by this view.

For an accepted Pending/Retryable withdrawal, the recipient execution panel offers only the original `retry_withdrawal(nullifier)` with its original destination. It shows the additional 0.02 NEAR recovery attachment; the original token fee is not charged again by that recovery call. Already-accepted fixed-destination recovery retains the existing behavior after approval expiry or approver revocation. New payouts still require live independent approval. If organization access is unavailable, the original encrypted journal can be reconciled through generic Settlements/CLI.

An unknown wallet/authorization result must be reconciled with the original journal, bound final record or original transaction hash. The API never resets a consumed dispatch reservation merely because a response was lost or a prompt closed. A definitively failed pre-acceptance transaction, changed proof or destination is not silently converted into a new batch attempt. Preserve evidence and use the existing explicit original-plan recovery workflow; contracts remain permissionless and the original fixed recipient cannot be redirected by a retry. Do not create a second-note replacement for an uncertain payment.

The shared journal keeps each row's intent/attempts separate, preserves completed outcomes and refuses to reopen them if a later API read loses the record. Reconciliation keeps a last confirmed block when a current read is unavailable/inconsistent. The summary separates expected/quoted principal and fees, historically confirmed principal and **principal not yet confirmed**. The latter is a difference from observed evidence, not a verified outstanding debt or permission to pay it again.

CSV/JSON export rechecks current private batch access and includes all rows, declared category, batch/row references, recipient, exact atomic amounts, quoted fees, approval state/approver, observation/checkpoint/source and historical confirmation markers. CSV quotes/protects formula-like fields; unknowns stay explicit. Exports do not contain private note/wallet keys or the journal passphrase. Protect readable business exports. Fee quotes are not proof of actual charged/refunded protocol fees or network gas, complete business history or tax acceptance.

## API, SDK and durability

| Under `/v1/organizations/:org/payout-batches` | Behavior |
| --- | --- |
| `POST /stage` | `{intentId, category, content}` → immutable `CorporatePayment`; exact retries return the same row |
| `POST /` | `{requestId, title, intentIds}` → immutable batch; all 1–20 staged intents must belong to the creator and exact policy |
| `GET /` | Up to 25 retained runs with their live per-row approval metadata |
| `GET /:id` | Batch payload/hash, ordered immutable row links and current corporate requests |

Each request retains the existing 8 KiB private API body limit and current origin/session/full-access-key/role controls. Larger manifests stay local and are submitted as bounded individual rows. Owner/Admin/Operator may create as the payer; Owner/Admin approve another account's rows; Auditor may read/reconcile/export; Viewer cannot load payout data. An intent cannot be regrouped into another run, and active/reserved/invalidated notes cannot obtain another corporate reservation in that organization. Cross-organization/direct-protocol actors remain outside that local reservation boundary.

Staging inserts the corporate request, intent mapping and audit in one immediate SQL transaction. Batch creation validates all references before writing the header/ordered links together. Idempotency conflicts, membership changes, unknown intents and mixed policies do not partially commit a batch. The existing cap of 100 retained corporate requests per organization applies across standalone and batch rows; no history or note reservation is deleted to free capacity. Current limits are for the hackathon service; larger retention/capacity work needs explicit policy.

`parsePayoutManifest`, `PayoutBatchClient`, `verifyPayoutBatch` and `payoutBatchQuote` handle bounded public manifests, resumable staging, independent payload digests and exact fee totals. `PayoutBatchSession` shares an `OperationJournal` but creates independent guarded settlement sessions per row. It has `review`, `submitReviewed`, `reconcile` and `lock`; it never automatically loops wallet dispatches. `reconcilePayoutBatch` validates finalized source bindings, records uncertainty and supports cancellation; `payoutSettlementSummary` and `exportPayoutSettlement` produce bounded observational reports.

```ts
const batches = new PayoutBatchClient(organizationClient, organizationId);
const batch = await batches.create(savedManifest, signal);
// Another Owner/Admin approves each exact row through the existing payment API.
const run = new PayoutBatchSession(journal, gateway, wallet, organizationClient, batch);
const row = batch.payments[0].payload.paymentId;
const review = await run.review(row);
// Show the recipient, amounts and exact call before explicit user wallet approval.
await run.submitReviewed(row, review.callHash!);
const settlement = await reconcilePayoutBatch(batch, gateway, gateway.url, signal);
const report = exportPayoutSettlement(batch, settlement, 'json');
```

Corporate approval is an application/API/SDK policy, **not contract-enforced organization custody or dual authorization**. A holder of a valid public proof can relay it through the permissionless protocol outside this workflow. The declaration/approval relationship is not proof of two independent legal persons or a KYB result.

[Organization backup/recovery](ORGANIZATION_BACKUPS.md) preserves immutable batch/intent links and audit while invalidating old row approvals and keeping consumed/reserved-note claims. Restoring historical membership cannot reapprove a row or reset a dispatched call. The browser observations are not an authoritative paid-status database; reconcile the original policy/journal after activation.
