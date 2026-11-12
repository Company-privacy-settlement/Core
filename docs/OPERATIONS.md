# Settlement operations SDK and read-only API

These operations work with a caller-supplied, independently trusted shared v2/v3 policy. They do not sign, broadcast, generate a proof, or custody notes. The frontend remains a separate repository; a real wallet connection is future work.

## FT preflight

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
| GET | `/v1/config` | Public trust policy; no RPC URL or secrets |
| GET | `/v1/vaults?fromIndex=0&maxRecords=20` | Verified catalog at one final block; max 50 records per API request and explicit pagination |
| POST | `/v1/ft/preflight` | Strict public preflight request; prerequisite calls and blockers |
| POST | `/v1/settlements/status` | Strict settlement reference; finalized state and bound recovery calls |
| POST | `/v1/invoices/verify` | Public invoice digest/signature; current merchant FullAccess key check |
| POST | `/v1/invoices/status` | Public invoice commitment/recipient/units/expiry; confirmed indexed payout totals |
| POST | `/v1/transactions/verify` | `{transaction:{hash,signer},call}`; exact single reviewed action and finality, with accepted / not-accepted / unknown effect |
| GET | `/v1/index/status` | Optional SQLite index checkpoint, lag and provenance coverage; no current-chain readiness claim |
| GET | `/v1/activity` | Optional indexed record pages with stable cursors and explicitly nullable TX/receipt provenance |

```bash
curl http://127.0.0.1:3001/healthz
curl -H 'Content-Type: application/json' \
  --data-binary @public-request.json \
  http://127.0.0.1:3001/v1/ft/preflight
```

The API accepts one configured policy/RPC, not a request-selected RPC or arbitrary view method. JSON bodies are limited to 8 KiB; unknown fields, including accidental note/secret fields, are rejected. CORS uses exact configured origins. Two concurrent chain requests are allowed by default; excess requests return 429. Responses are not cached, and request bodies/upstream error details are not logged or echoed.

Errors: 400 malformed/invalid input; 403 disallowed origin; 409 incompatible destination or unavailable vault/asset; 413 body limit; 415 content type/encoding; 429 concurrency limit; 502 chain read/validation failure. Only RPC `UNKNOWN_ACCOUNT` is treated as absence. Other RPC failures must not become misleading registration instructions.

This is a local/development read-only integration service. Wallet signing and encrypted client recovery are documented in [WALLET.md](WALLET.md). Authentication for future private data, durable jobs, deployment rate limits/telemetry and a production deployment remain in [ROADMAP.md](ROADMAP.md). CORS is not authentication. Direct SDK use avoids adding this service as an observer of payment preparation.

The optional [finalized journal index](INDEXER.md) runs as a separate worker. Set `CORE_INDEX_DB` after initializing it; the API opens that database read-only. Index routes return 503 when disabled/uninitialized, accept no ingestion/write calls, and report their observed checkpoint rather than implying fresh chain reads. Existing settlement status remains the source for current bound recovery decisions.

References: [NEAR FT integration](https://docs.near.org/integrations/fungible-tokens), [NEAR RPC query errors](https://docs.near.org/api/rpc/contracts), [Contract settlement behavior](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md).

Recipient-issued invoice architecture, privacy boundary and checkout limitations: [INVOICES.md](INVOICES.md). Invoice routes are public read-only queries; full business terms are rejected.
