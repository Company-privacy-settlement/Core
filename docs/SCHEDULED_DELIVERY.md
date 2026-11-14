# Optional delayed delivery and bounded batches

[Proof relay](RELAY.md) · [Wallet recovery](WALLET.md) · [Privacy baseline](PRIVACY_BASELINE.md)

The optional proof relay can durably queue a **public withdrawal proof** and spread submissions over a user-selected execution window. Immediate submission remains available. Principal stays in the original keyless vault until a proof-authorized payout. This is a delivery scheduler, not a contract timelock, anonymity guarantee, cover-traffic generator or atomic multi-recipient transaction.

## User flow

1. Run the separately configured relay as described in [RELAY.md](RELAY.md). The same protected, identity-pinned SQLite journal stores schedules and exact execution intents. Startup resumes unstarted jobs; no extra configuration or customer key is needed.
2. Open `/relay/` in Front. Import an independently trusted group policy and a public browser proof file (FT) or `relay:request` JSON (native/FT). Browser proof checksums, policy, asset/domain and recipient binding are checked locally; the relay verifies Groth16 using the policy-pinned key.
3. Select immediate delivery, a **30–180 second** window with a **600 second** deadline, or **300–900 seconds** with an **1800 second** deadline. Review the full principal, original recipient, sponsor and additive **0.15%** protocol fee. The sponsor pays gas, storage and this fee; the recipient receives the full denomination. Integer fees round down as in the contracts.
4. Save the recovery receipt **before confirming**. It contains public proof/destination metadata and a random capability for queue controls. Keep it private. The server stores only a SHA-256 digest of that capability and does not expose it in status. The receipt checksum detects edits; it is not a signature or proof revocation.
5. Confirm once. The server samples one millisecond execution time uniformly within the requested range, persists it, and returns the same time for duplicates and restarts. The UI shows eligibility and deadline, refreshes read-only status while visible, and keeps transaction acceptance separate from a finalized payout.
6. After a timeout or reload, import the same trusted policy and saved receipt, then **Check original request**. The UI never automatically submits or retries a payment. Only an explicit not-found response exposes **Submit saved request**, which resends the exact original request/capability. A changed policy or sponsor stops recovery.

The hosted frontend does not include a running public relay. HTTP loopback is for local development; a hosted HTTPS page needs an independently operated HTTPS relay and matching CORS origin. Receipts contain no note witness, note passphrase or wallet signing key. They are not a substitute for encrypted note backups.

## API

The existing `POST /v1/relay/requests` remains immediate. It cannot bypass an existing scheduled reservation. Queuing uses:

```json
POST /v1/relay/schedules
{
  "request": { "format": "core-relay-withdrawal-v1", "...": "original strict public request" },
  "timing": { "delayMinSeconds": 30, "delayMaxSeconds": 180, "expiresInSeconds": 600 },
  "controlToken": "<32 random bytes, lowercase hex>"
}
```

`delayMinSeconds` is 0–86400; `delayMaxSeconds` is 1–86400 and strictly greater than the minimum. Expiry is at least maximum delay + 30 seconds and at most 172800 seconds, relative to server acceptance. Invalid or unknown fields are rejected. The conceptual example above abbreviates the request; use a real proof request produced by the CLI/browser.

- `GET /v1/relay/requests/:id`: finalized settlement, original execution hashes, schedule state/revision/timestamps, and whether another unresolved sponsor transaction is blocking delivery.
- `POST .../:id/cancel`: `{ "controlToken": "…", "expectedRevision": 1 }` cancels only unstarted waiting/blocked work.
- `POST .../:id/resume`: same body; explicitly resumes blocked work within its original unexpired window, without sampling another time.
- `POST .../:id/reschedule`: adds `"timing": { ... }`; only expired/cancelled, never-started work can receive a new window. The original proof, request ID, destination and nullifier remain unchanged. Revision increments; stale commands fail. At most five reschedules are allowed.
- Existing `reconcile` reads the original signed hash; existing explicit `retry` recovers a finalized retryable payout to the same bound destination. Neither is available as a way to start a merely queued request.

`GET /v1/relay/config` advertises scheduling bounds: 256 pending/blocked jobs, 10000 lifetime schedule records, batches of at most 8 transactions, and a one-second worker tick. The limits do not reserve sponsor funding at enqueue; every execution still passes current budget, gas price, available liquidity, asset prerequisites and chain freshness checks.

## State, failure and restart behavior

| State | Meaning and permitted recovery |
| --- | --- |
| `waiting` | Persisted; cannot execute before sampled `readyAt`. Cancel is available. Other users' unresolved signer intents can hold it until its deadline. |
| `blocked` | Preflight failed before execution. Safe reason is shown. No repeated automatic preflight loop; explicitly resume after correcting liquidity, funding or prerequisites. |
| `expired` | Deadline reached before execution began. Nothing was signed for this delivery. Explicitly reschedule the original request or use the direct contract path. |
| `cancelled` | This relay will not start it. Explicit rescheduling is available. Cancellation does **not** revoke a bearer proof or stop a direct on-chain spend. |
| `executing` | A transaction intent has been reserved. Cancel/reschedule/expiry no longer apply. Reconcile the original hash if uncertain; absence of an unsigned preparation requires operator review. |

Expiry is checked again **after asynchronous preflight**, in the same SQLite transaction that reserves the execution and changes the queue state. Cancellation racing preflight wins if it commits before that reservation. A crash after reservation never turns into an automatically re-signed transaction. An uncertain original hash blocks further sponsor nonce allocation until explicit reconciliation; retries keep the original recipient and nullifier. A definitive outer transaction failure does not establish that the intended payout completed.

Ready jobs are shuffled using cryptographic randomness, then delivered sequentially in batches of at most eight **separate transactions**. A failure before signing blocks that item and allows other eligible work; an ambiguous signed transaction pauses the signer. Each request has its own immutable transaction and recovery history. Batches do not merge funds, guarantee fairness/execution time, wait for minimum participants or make adjacent transactions unlinkable. Worker downtime, backlog and sponsor policy can cause expiry. Operators need a correct wall clock; large forward jumps expire jobs rather than extending authority.

## Historical proof roots

New deposits can append to the tree while a proof waits. The immutable forest accepts every root it recorded during append. The relay reconstructs the complete commitment list against the current **FINAL**, code-pinned root and incrementally rebuilds its append-prefix roots. An older proof is accepted only if its root appears in that verified history. An arbitrary caller/indexer root is never accepted. Proof verification, original vault liquidity and global spent-nullifier checks remain mandatory immediately before dispatch.

## Validation and limits

`npm test` covers timing persistence, no early dispatch, duplicates and immediate-path bypass, restart, deadline/cancellation races, capability authorization, same-request rescheduling, blocked recovery, uncertain-hash reconciliation, historical roots and batch bounds. `npm run test:relay-sandbox` also runs real native/FT WASM and Groth16 transactions, appends after proof generation, and checks cancellation, expiry, restart and original-request recovery with an injected scheduling clock. FT is local TESTUSD, not Circle-issued USDC. The required integration CI relay stage runs this harness.

[Recorded real WASM/Groth16 scheduling evidence](evidence/scheduling-sandbox-2026-11-14.json).

[Recorded UX validation](evidence/scheduling-ux-2026-11-14.json) · [Desktop screen](https://github.com/Company-privacy-settlement/Front/blob/main/docs/assets/scheduled-delivery-desktop.png) · [Mobile screen](https://github.com/Company-privacy-settlement/Front/blob/main/docs/assets/scheduled-delivery-mobile.png).

Front desktop/mobile browser tests exercise review, receipt-before-submit, waiting, cancellation, expiry, rescheduling, lost-response/reload recovery, uncertain signing, payout retry and immediate delivery. Those browser API responses are fixtures; they are not a live hosted relay or wallet qualification. The previous [public native relay transaction](RELAY.md#observed-validation--2026-11-14) remains historical evidence, not a public delayed-delivery test. Delays can reduce simple timing proximity but cannot create independent users or remedy concentrated funding.
