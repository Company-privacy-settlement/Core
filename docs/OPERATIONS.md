# Settlement operations SDK and read-only API

[Supervised API/indexer hosting, HTTPS and backup/restore](HOSTING.md)

[Service overview](SERVICE.md) · [Development roadmap](ROADMAP.md)

These operations work with a caller-supplied, independently trusted shared v2/v3 policy. They do not sign, broadcast, generate a proof, or custody notes. Wallet execution is provided by Front’s configured testnet workspace through the browser SDK; private note creation and proof generation remain local CLI operations. See [wallet execution and recovery](WALLET.md).

For new-note selection across independently approved deployments, use the [group capacity SDK/CLI and Front selector](GROUPS.md). This HTTP service uses one pinned policy; the directory does not change an existing note or signed invoice's group. Each Front row needs the API for that specific policy.

## Organization API is separate

Team membership uses the authenticated [Organization API](ORGANIZATIONS.md), with its own origin, process and SQLite database. The local default is port 3002; the read-only settlement API defaults to port 3001. Organization routes and bearer sessions are not supported by this settlement service, and an organization role cannot replace a trusted group policy, invoice signature or private note. Use the organization guide for sign-in, invitations, member roles, ownership, audit history and versioned mutations.

## FT preflight

For CLI payment preparation, `discoverSharedVaultGroup` verifies all registry pages at one finalized block before automatic selection. The default scan budget is 1,000 records; a larger group fails rather than selecting from an incomplete catalog. An explicit withdrawal `action.vault`, or the optional final `vault-account` argument to `shared-deposit-args`, uses `get_vault` and verifies the corresponding single catalog record and contract. Direct selection keeps code, key, asset, fee and capacity/liquidity checks. SDK callers may set `maxRecords` (1–10,000). This limit concerns registry records, not the 256-output note-tree capacity.

```ts
import { NearRpcOperationsSource, preflightFt } from '../sdk/operations.js';

const source = new NearRpcOperationsSource(policy.network, policy.registry, trustedRpcUrl);
const result = await preflightFt(source, policy, {
  operation: 'withdraw', payer: feePayer, vault: payoutVault, recipient,
});
```

All discovery, token, account and credit reads use **one finalized block**. The registry and selected vault must have pinned code, no access keys, the expected asset/domain/fee policy, and available capacity/liquidity. `get_vault` locates the selected record directly, so vaults beyond the first catalog page are supported.

The result includes:

- Token identity, display metadata, exact token fee/principal quote, payer token balance, and the checked block.
- Missing native accounts, missing payer FT registration, or insufficient token balance as `blockers`.
- Ordered `prerequisites`: missing receiver registrations followed by an exact NEAR credit top-up for the token sender. Already registered accounts and sufficient credits produce no redundant call. The permanent first-use credit bond is charged only when the entry is absent.
- `canPrepare`: no reported blockers. `prerequisitesSatisfied`: no blockers and no prerequisite calls remain. Neither flag guarantees a wallet has enough spendable NEAR for gas or native storage stake.
- `requiredAttachedYoctoNear`: known registration/credit attachments plus the 1 yoctoNEAR token call deposit. Gas, native account activation and the principal/token fee are separate.

For withdrawal, receiver registrations cover the payout vault, forest fee receiver and recipient. Treasury registration is still required before fee collection; it is not charged to the payer as a prerequisite for the principal payout. An absent native account is reported for explicit activation, rather than guessing an activation amount or creating keys in the service.

A metadata symbol is not a trust anchor. Only the independently pinned Circle testnet token receives `nativeUsdc: true`, and its decimals must be 6. The sandbox fixture remains a test token even if its metadata says USDC.

This is a snapshot. Apply prerequisite calls through the actual payer wallet, wait for finality, **run preflight again**, and then build/sign the payment. Liquidity and balances can change. Proof generation stays local through `proveSpend`; use the existing `buildFtDeposit` / `buildFtWithdrawal` for the bound token call. Never send a private note, wallet key or password to this API.

## Finalized state and recovery

```ts
import { observeSettlement, waitForSettlement } from '../sdk/operations.js';

const reference = {
  kind: 'withdrawal' as const,
  nullifier,
  expectedVault: payoutVault,
  expectedRecipient: recipient,
  expectedDisclosureRoot: receiptRoot,
};
const status = await observeSettlement(source, policy, reference);
const watched = await waitForSettlement(source, policy, reference, {
  maxAttempts: 20, intervalMs: 1000, signal: abortController.signal,
});
```

A deposit reference uses `kind: deposit`, `vault`, `commitment`, optional `expectedOwner`, and optional `expectedDisclosureRoot`. Supply expected bindings from the locally prepared operation whenever available. Identifiers alone inspect existing public state; they do not prove that a newly submitted transaction caused that state.

| Observed state | Result / next action |
| --- | --- |
| Deposit `Active` / withdrawal `Complete` | `complete: true`; no retry call |
| `NotFound` | No finalized record; no automatic resubmission |
| `Pending` | Remains pending; retry is offered only after the contract's 20-block delay |
| `Retryable` | Bound `retry_deposit` or `retry_withdrawal` call, 0.02 NEAR storage only |
| Deposit `Refundable` | `claim_deposit_refund`, 1 yoctoNEAR; original owner remains fixed |
| Deposit `RefundInFlight` | Wait; do not issue another refund |
| Deposit `Refunded` | `refunded: true`, not successful deposit completion |

Polling stops on completion, refunded state, an available recovery action, cancellation or the attempt limit. Cancellation is checked between read-only snapshots and during waits; an in-flight RPC read retains its provider timeout. `timedOut: true` reports only the observation limit. It does not mean payment failed, release a nullifier, or cause a retry. A contract retry can acknowledge a lost registry callback but cannot safely reset a permanently pending vault transfer.

## CLI

```bash
npm run cli -- ft-preflight trusted-policy.json https://rpc.testnet.near.org public-request.json
npm run cli -- settlement-status trusted-policy.json https://rpc.testnet.near.org public-reference.json
npm run cli -- settlement-wait trusted-policy.json https://rpc.testnet.near.org public-reference.json
```

Start from `examples/ft-preflight.json` and `examples/settlement-reference.json`; replace every placeholder with actual values. Existing `shared-*` commands still build notes and bound proof/payment payloads. The new commands inspect or prepare calls only. Treat `Pending` and `NotFound` as unresolved even after a CLI wait returns.

## HTTP service

Prepare a real policy with independently verified deployment hashes. Templates deliberately contain unusable placeholders. `.env.example` lists variables but is not loaded automatically.

```bash
export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

Default bind: `127.0.0.1:3001`. `CORE_API_HOST` and `PORT` can override it. There is no simulated-chain fallback. The service starts only with valid policy syntax; each chain operation verifies deployment state. `/healthz` explicitly does **not** assert chain readiness.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/healthz` | Process configuration, read-only flag; no readiness claim |
| GET | `/readyz` | Verified registry/first catalog member at one final block, plus attached index freshness and current journal count; returns non-200 when not ready |
| GET | `/v1/config` | Public trust policy; no RPC URL or secrets |
| GET | `/v1/group/capacity` | Pinned group policy, 256-output tree counts and first-member deposit observation at one final block |
| GET | `/v1/vaults?fromIndex=0&maxRecords=20` | Verified catalog at one final block; max 50 records per API request and explicit pagination |
| POST | `/v1/ft/preflight` | Strict public preflight request; prerequisite calls and blockers |
| POST | `/v1/deposits/prepare` | Public commitment/root and optional vault; bounded verified FT deposit plan; [browser notes](BROWSER_NOTES.md) |
| POST | `/v1/recipients/readiness` | Strict `{recipient}` request; account activation, token registration, exact public registration call; [recipient guide](RECIPIENTS.md) |
| POST | `/v1/settlements/status` | Strict settlement reference; finalized state and bound recovery calls |
| POST | `/v1/invoices/verify` | Public invoice digest/signature; current merchant FullAccess key check |
| POST | `/v1/invoices/status` | Public invoice commitment/recipient/units/expiry; confirmed indexed payout totals |
| POST | `/v1/transactions/verify` | `{transaction:{hash,signer},call}`; exact single reviewed action and finality, with accepted / not-accepted / unknown effect |
| GET | `/v1/index/status` | Optional SQLite index checkpoint, lag and provenance coverage; no current-chain readiness claim |
| GET | `/v1/activity` | Optional indexed record pages with stable cursors and explicitly nullable TX/receipt provenance |

```bash
curl http://127.0.0.1:3001/healthz
curl --fail http://127.0.0.1:3001/readyz
curl -H 'Content-Type: application/json' \
  --data-binary @public-request.json \
  http://127.0.0.1:3001/v1/ft/preflight
```

The API accepts one configured policy/RPC, not a request-selected RPC or arbitrary view method. JSON bodies are limited to 8 KiB; unknown fields, including accidental note/secret fields, are rejected. CORS uses exact configured origins. Responses are not cached, and request bodies/upstream error details are not logged or echoed.

## Request limits and readiness

Each direct socket peer receives **120 points per 60-second fixed window** by default. `/v1/vaults`, `/v1/group/capacity` and `/readyz` cost 5 points; public deposit planning also costs 5, FT preflight and recipient preparation cost 3, settlement/TX/merchant verification costs 2, and other requests (including allowed CORS preflights) cost 1. `/healthz` is exempt and makes no chain reads. Successful admissions include `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until reset). Rate/concurrency rejections include `Retry-After`; clients should wait and refresh state rather than automatically retrying wallet signatures.

Rate state is bounded to 1,024 peers. A full, unexpired peer table returns `503 RATE_LIMIT_CAPACITY` for new peers rather than evicting active counters. Forwarded/X-Forwarded-For headers are ignored. Behind a reverse proxy, all clients sharing its socket address share a budget; configure edge limits for individual clients. Counters and concurrency limits are process-local and reset on restart; distributed enforcement and authentication are separate concerns.

At most two work requests run concurrently. Each request has a **15-second deadline**, including JSON upload time. The CLI server creates a request-scoped RPC source, propagating cancellation to the actual HTTP transport on timeout or disconnect. Embedded servers should supply `sourceFactory(signal)` for equivalent transport cancellation. An adapter that ignores cancellation retains its concurrency slot until its real reads settle; a 504 response does not free space for orphaned background reads. Further source/database reads are blocked after cancellation. Synchronous SQLite/CPU work cannot be interrupted mid-call.

RPC budgets cap the number of source read calls **before** they start:

| Route | Maximum source reads |
| --- | --- |
| `/v1/vaults` | 160, including up to 50 member verifications |
| `/v1/ft/preflight` | 40 |
| `/v1/deposits/prepare` | 80 (5 rate points) |
| `/v1/recipients/readiness` | 16 (3 rate points) |
| `/v1/settlements/status` | 30 |
| `/readyz`, `/v1/group/capacity` | 10 |
| `/v1/invoices/verify` | 4 |
| `/v1/transactions/verify` | 1 |
| Config and indexed activity/invoice/status routes | 0 |

`CORE_API_MAX_RPC_READS` can reduce any route's ceiling; it does not raise the route's own budget. Existing catalog/page/body limits still apply. Configure the validated `CORE_API_*` settings in [.env.example](../.env.example); invalid numbers/booleans fail startup. `CORE_API_MAX_CONCURRENT` accepts 1–16, timeout accepts 100–60,000 ms, and rate windows accept 100–3,600,000 ms.

`/readyz` verifies the pinned registry's code, keys, asset/domain/fees/accounting and at most its first catalog member, at one finalized block. It does not scan every vault or guarantee that a particular payment has liquidity or capacity. If an index is attached, readiness requires a checkpoint within 60 seconds and 100 blocks by default, no same-height hash conflict, and an indexed record count equal to the registry's current journal count at that block. Thus a previously complete checkpoint missing a new payout returns `INDEX_BEHIND`. A checkpoint newer than the request's pinned block returns `INDEX_AHEAD`, allowing a new probe after a concurrent worker update. `CORE_API_REQUIRE_INDEX=true` also makes an absent index fail readiness. It does not check receipt provenance/discovery completeness, wall-clock freshness of the RPC's chain head, KYB or tax compliance; responses retain `chainFreshnessChecked: false`. Readiness is a snapshot, and every payment still receives its own fresh checks.

Errors: 400 malformed/invalid input; 403 disallowed origin; 409 incompatible destination or unavailable vault/asset; 413 body limit; 415 content type/encoding; 429 `RATE_LIMITED` or concurrent `TOO_MANY_REQUESTS`; 503 `RPC_BUDGET_EXCEEDED`, `RATE_LIMIT_CAPACITY`, or unavailable/stale/behind/conflicting index; 504 `REQUEST_TIMEOUT`; 502 chain read/validation failure (503 on `/readyz`). Only RPC `UNKNOWN_ACCOUNT` is treated as absence. Other RPC failures must not become misleading registration instructions.

This is a local/development read-only integration service. Wallet signing and encrypted client recovery are documented in [WALLET.md](WALLET.md). Authentication for future private data, distributed deployment limits/telemetry, durable jobs and a production deployment remain in [ROADMAP.md](ROADMAP.md). CORS is not authentication. Direct SDK use avoids adding this service as an observer of payment preparation.

The optional [finalized journal index](INDEXER.md) runs as a separate worker. Set `CORE_INDEX_DB` after initializing it; the API opens that database read-only. Index routes return 503 when disabled/uninitialized, accept no ingestion/write calls, and report their observed checkpoint rather than implying fresh chain reads. Existing settlement status remains the source for current bound recovery decisions.

References: [NEAR FT integration](https://docs.near.org/integrations/fungible-tokens), [NEAR RPC query errors](https://docs.near.org/api/rpc/contracts), [Contract settlement behavior](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md).

Recipient-issued invoice architecture, privacy boundary and checkout limitations: [INVOICES.md](INVOICES.md). Invoice routes are public read-only queries; full business terms are rejected.
