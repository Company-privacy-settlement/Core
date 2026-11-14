# Organization payment dashboard

Front `/organization/` → choose an organization → **Invoice payments** provides a persistent-invoice payment dashboard. Signed terms are stored by the [encrypted Organization invoice API](ORGANIZATION_INVOICES.md); payment observations come from the separate public Core finalized index. A browser callback, wallet response, URL parameter, redirect or local storage value never sets paid.

## Workflow

1. Configure the Organization API and its separately protected invoice key ring. Sign in with a NEAR testnet wallet and select an organization.
2. Open **Invoice payments**. The browser retrieves the complete authorized invoice snapshot in descending sequence pages of 50, up to the existing 1,000-invoice organization limit. It verifies every merchant signature, creator, organization binding and cursor before displaying the snapshot. Newly saved invoices appear on Refresh invoices.
3. If needed, open **Save a signed invoice**, import the signed JSON downloaded from `/invoices/`, and choose **Save to organization**. The authenticated account must be its merchant. The signed invoice UUID is reused as the stable idempotency key; ambiguous/exact repeats cannot create a duplicate. The local invoice form/library does not automatically upload terms.
4. Open **Settlement source**, enter an independently approved Core API origin and import its independently trusted testnet policy. Policy/treasury/token/code/verifier pins must match the API. Sources remain in memory and are never taken from invoice-provided URLs.
5. Choose **Check payments**. It checks all loaded records matching the selected exact policy, irrespective of table filters/pages. Other groups remain unchecked. Checks run sequentially at most once per second to respect service budgets; large collections take longer and can be cancelled. Current private read permission is revalidated before publishing each result. Import another trusted policy/source to reconcile a different group; changing the source invalidates previous observations.
6. Search, filter, inspect confirmations or explicitly export the filtered snapshot. All amounts are exact integer asset atomic units. Asset counts are not combined into a fiat total.

Owners/Admins/Operators can save and read; Auditors can read/check/export; Viewers cannot load invoice data. Switching organization, source or session cannot reuse another organization's data. Page-hide/unmount/session expiry clears private state and cancels pending work; a late HTTP/file/crypto result cannot reopen the dashboard. Private authorization failures clear cached organization data. No browser plaintext invoice/status/token cache is created.

## Search, filters and export

Search matches normalized, case-insensitive invoice title/reference, signed/storage IDs, recipient, merchant, registry and asset. Filters cover payment state, asset, group and inclusive UTC issue-date range. Metadata search covers the complete loaded snapshot, not just the visible page. The table displays 20 records per page. A status filter applies only to observations actually checked; unchecked/unavailable records remain explicit choices, never implied unpaid.

CSV and JSON exports include **every filtered record across all display pages**, organization/storage/signed IDs, business fields, exact expected/observed amounts, status/observed status, finalized record indices/linked transaction hashes and checkpoint metadata. They recheck current private read access immediately before download. Exports are readable business data; protect the downloaded file. Merchant signatures, signing/payment nonces, bearer credentials and encryption keys are excluded. CSV quotes every cell, preserves Unicode and prefixes spreadsheet formula-like text. JSON retains exact amount strings and nullable unknown observations.

Exports describe an indexed snapshot, not complete business history, tax acceptance or current-chain freshness. A missing transaction link does not fabricate a transaction hash: final contract records remain visible while unavailable transaction provenance stays explicit in details.

## Finalized status model

The source uses the existing `POST /v1/invoices/status` lookup against verified finalized registry records. It counts only matching successful withdrawals for the exact asset, denomination, recipient and signed-derived unit references, deduplicated by nullifier. Requests, failed/retried attempts, other recipients/roots and unconfirmed wallet submissions do not count. [Index verification](INDEXER.md) and [invoice reference design](INVOICES.md) remain the underlying boundaries.

| Display | Meaning |
| --- | --- |
| Unchecked | No observation from the selected independently trusted source |
| Unavailable | A check failed; previous paid observations are discarded for that refresh |
| Stale index | Checkpoint or browser observation older than five minutes; freshness must be reviewed |
| Needs review | Incomplete indexed coverage or reused v2 payment-unit references |
| Awaiting payment / Partially paid / Paid | Exact matching finalized principal below/equal the signed amount within the indexed snapshot |
| Paid late / Expired / Partial · expired | Invoice time and observed finalized payment timestamps remain explicit |
| Overpaid | Observed finalized principal exceeds the signed expected amount; investigate reconciliation |

Every observation exposes its API origin, observed time, index hash/height/update time and `chainFreshnessChecked: false`. Future/invalid checkpoint times, substituted roots/policies, inconsistent totals, duplicate confirmations and malformed transaction references are rejected. Coverage gaps and repeated v2 unit references cannot appear as a definitive Paid state. Known historical successes remain visible in the raw observed amount even when the overall snapshot is stale or needs review.

`HttpGateway.invoiceHistory(signed, {signal})` verifies the original local signature and current API policy and reads indexed history **without requiring the historic invoice key to remain current**. This supports archives after merchant key rotation. Existing checkout `invoiceStatus` still requires the merchant's current FullAccess key; historical lookup never grants payment authority.

## SDK

```ts
const records = await loadOrganizationInvoices(invoiceClient, organizationId, signal);
const raw = await gateway.invoiceHistory(record.invoice, { signal });
const observation = await invoiceDashboardObservation(record, trustedPolicy, gateway.url, raw);
const rows = [{ record, observation, unavailable: false }];
const filtered = filterInvoiceDashboard(rows, { search: 'INV-', state: 'paid' });
const csv = exportInvoiceDashboard(filtered, 'csv');
```

Snapshot/signature/tenant checks, historical HTTP/current-checkout separation, search/date filters, status uncertainty, reused-unit references, formula-safe exports and actual finalized-index record selection have Core tests. Desktop/mobile browser tests cover API import, full pagination, filters/exports, stale/error/coverage states, role restrictions, cancellation, revocation, organization switching and page-hide. These browser service/wallet fixtures do not establish a live public-network deployment or KYB.

Webhooks/outbox, server-side reporting jobs, saved source directories, arbitrary fiat amounts, FX and corporate legal qualification remain separate work. This dashboard does not alter contract fees, fixed-denomination proof rules or the existing corporate approval workflow.
