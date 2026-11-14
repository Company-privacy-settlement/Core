# Testnet cover-traffic experiment

[Privacy model](PRIVACY.md) · [Baseline measurement](PRIVACY_BASELINE.md) · [Proof relay](RELAY.md)

This opt-in operator tool measures **declared artificial activity**. It runs a small native-NEAR note cycle on testnet: deposit → zero or more proof-based internal transfers → withdrawal to the same operator. Principal stays in the existing distributed vault system. It neither enrolls customers nor generates invoices, sales, independent identities or an established anonymity set.

Every operation publishes a disclosure marker:

```text
SHA-256("core:declared-synthetic:v1|" + experiment UUID + "|" + sequence)
```

The marker deliberately makes this experiment recognizable. Filtering those outputs is a measured scenario, not an attempt to disguise operator activity. More outputs alone do not demonstrate better privacy against funding, signer or timing analysis.

## Limits and signing boundary

The strict configuration permits testnet native NEAR only, an operator `.testnet` account, one independently pinned shared policy and its child vault. Mainnet, FT/USDC and arbitrary recipients/actions are rejected. The maximum is ten transactions, at least 60 seconds between the latest observed FINAL result and the next intent, at most 1 NEAR reserved, and an initial expiry no more than 24 hours away.

The journal binds the complete configuration, public key and note commitments. Changing limits, notes or signer after initialization fails. SQLite reservations are atomic across processes and durable across restart. Before starting, the whole deposit/transfer/withdrawal cycle must fit the transaction and conservative cost ceilings. Capacity and deployed code/key/verifier bindings are checked through existing vault discovery.

For each operation the reservation is:

```text
attached NEAR + 300 Tgas × configured gas-price ceiling
```

Principal, additive 0.15% deposit/withdrawal fees, action storage and gas are included. Refunds and returned principal never replenish the cumulative budget. An unresolved intent continues consuming its full reservation. The RPC gas price is checked before signing; the budget is a conservative dispatch reservation, not a network-level future gas-price cap.

Only exact deposit, transfer and same-operator withdrawal calls are signed. Output commitment, proof context, marker, fixed denomination, fees, contract, method, attachment and gas are bound. Keys and notes are local owner-only files; the journal contains public call/proof material, never private note witnesses. Use a dedicated funded operator key with no concurrent signer, in a mode-0700 directory outside the repository. This process is separate from the public API, relay sponsor and browser wallet.

## Run a bounded experiment

Use Node.js 22.16+ and installed Core dependencies. Review [the runtime template](../examples/cover-traffic.template.json), replace its invalid placeholders with independently verified testnet policy/code/verifier hashes, choose a fresh UUID, and set `expiresAt` to an explicit millisecond timestamp within the next 24 hours. Provide the matching development proving artifacts. The bundled setup remains `UNSAFE_LOCAL_DEVELOPMENT_ONLY`.

The key JSON must contain exactly `{account_id, public_key, private_key}` and match the configured operator. Keep it mode 0600. Notes and journal paths must be new; retain them for recovery. RPC must be explicit HTTPS with no credentials, query or fragment; there is no silent provider fallback.

```bash
npm run cover:traffic -- init /secure/cover/runtime.json
npm run cover:traffic -- baseline /secure/cover/runtime.json /secure/cover/before.json
npm run cover:traffic -- step /secure/cover/runtime.json
npm run cover:traffic -- status /secure/cover/runtime.json
```

`step` executes **one** operation. Invoke subsequent steps after `nextEligibleAt`, until `state: complete`. An operator scheduler may invoke this command periodically; frequency/count/budget/expiry checks remain inside the persistent runner. Nothing starts automatically with the application, no scheduler is installed, and no background signer is left running. Scheduling more often produces `COVER_RATE_LIMIT` without a new intent or nonce. Exiting the scheduler prevents future invocations; keep the journal if a transaction is in flight.

`COVER_RECONCILIATION_REQUIRED` blocks new work after an uncertain result. Use:

```bash
npm run cover:traffic -- reconcile /secure/cover/runtime.json
```

Reconciliation reads the original signed hash and requires FINAL successful receipts and the expected contract state. It never allocates a replacement nonce, rebroadcasts, resets budget or changes destination. An intent interrupted before a transaction was prepared requires operator review. A failed on-chain operation, expiry, depleted capacity/liquidity or lost local files can require separate note/recovery handling; there is no automatic budget/expiry exception. Never delete the journal to bypass a limit. Back up notes before running and retain the original configuration for recovery.

## Capture and reproduce measurements

After all intended steps, collect a new immutable after file:

```bash
npm run cover:traffic -- snapshot /secure/cover/runtime.json /secure/cover/after.json
```

Collection pins canonical FINAL state and calls the registry's immutable `get_records` journal, not its vault catalog. It independently rechecks every finalized experiment transaction's exact signed intent, signature and successful receipt tree. Synthetic rows are matched by fingerprint, executor, event kind, public marker and canonical receipt-block height/time. Unattributed older history remains `unclassified` with unknown signers; it is not relabelled as real customer activity.

Collect the baseline before sending. If that collection was interrupted, `baseline` can reconstruct the canonical block immediately preceding the first finalized transaction. Its output explicitly reports `archivalPreTransactionReconstruction: true`; describe that provenance in the evidence instead of presenting it as a live earlier capture. An RPC without the required historical state fails collection.

Export only the `experiment` object into a public configuration file. The read-only offline analyzer requires no key, notes, journal or RPC:

```bash
npm run cover:measure -- experiment.json before.json BEFORE_FILE_SHA256 \
  after.json AFTER_FILE_SHA256 /tmp/new-cover-effect.json
```

Both exact file hashes must be independently established. Output files are created exclusively and never overwritten. Hash checks establish file integrity; the offline analyzer does not authenticate a chain source or reverify signatures. It rejects different policies/time windows, changed baseline rows, invalid experiment labels and uncontrolled concurrent activity. If other traffic arrives, use a separate reviewed observational study rather than misattribute it to this controlled experiment.

The report separates raw output/time-window candidates, candidates excluding declared synthetic outputs, artificial transaction/output counts, unknown signer attribution and known operator declarations. `independentParticipantsAdded` stays **0**; independently verified people remain **unknown**. A synthetic withdrawal is a controlled probe, not a customer-benefit measurement. Older withdrawals cannot gain candidates from later outputs. Funding concentration covers only attributed principal; upstream history remains uncollected.

## Recorded public-testnet run

The dated [experiment evidence](evidence/cover-native-testnet-2026-11-14.json) includes configuration, exact public signed intents, transaction hashes, canonical snapshots, reservations, gas burn, final state and restart/rate-limit checks. The [effect report](evidence/cover-native-effect-2026-11-14.json) and hash-pinned observation files make the calculation reproducible. Detailed results and validation are recorded with those artifacts. This native software-wallet experiment does not qualify public USDC, browser-wallet signing, production deployment or effective anonymity.

| Measurement | Observed result — 2026-11-14 |
| --- | --- |
| Operations | One deposit, two internal ZK note transfers, one same-operator withdrawal; all four FINAL |
| Principal | 0.1 NEAR returned; zero outstanding notes and vault reservations afterward |
| Budget ceiling / cumulative reservation | 0.35 / 0.3003 NEAR; principal refunds do not refill the reservation |
| Execution tokens burnt | 0.0232754624555808 NEAR |
| Historical operator balance debit | 0.1035754624555808 NEAR = 0.1803 attached − 0.1 returned + gas burnt |
| Protocol fees accrued | 0.0003 NEAR, additive; no principal deduction |
| Interval limit / minimum observed | 60 / 67.538 seconds from observed FINAL to next intent |
| Immediate restart attempt | `COVER_RATE_LIMIT`; intent count, reservations and nonce unchanged |
| Extra invocation / raised budget | Completed without another send / `COVER_IDENTITY_CHANGED`; nonce unchanged |
| Journal / total output count | 11 → 16 records / 3 → 6 outputs; three lifetime slots consumed |
| Synthetic controlled probe, all prior same-amount outputs | 6 raw candidates / 3 excluding declared synthetic outputs |
| Same probe, 60 / 300 / 3,600 / 86,400-second windows | Raw 0 / 2 / 3 / 6; excluding synthetic 0 / 0 / 0 / 3 |
| Added independent participants | **0**; total independent identities remain unknown |
| Older history | Eleven rows retain unknown signer attribution in this experiment collector |

The before file was **reconstructed from archival state immediately before the first deposit** after the initial live collector failed before writing. The public evidence preserves this provenance. The first deposit was already FINAL when the collector's vault-catalog/event-journal mix-up was corrected. Regression coverage checks both historical collection and restart reconciliation of original argument bytes.

Transactions: [deposit](https://testnet.nearblocks.io/txns/2errt4TyHvJ7vQ11Wss67v51TeaMUAc9P4vSE63z2rhz), [transfer 1](https://testnet.nearblocks.io/txns/7eQRpAvT5JfMCiq5r7npnQcxtZBTPHwEznKXKiiXCidk), [transfer 2](https://testnet.nearblocks.io/txns/7gFY4aG8ztzvawrpbZgpN7UAH4YT5t1BirgoMNQPuxcC), [withdrawal](https://testnet.nearblocks.io/txns/7SRQkBuYYw7GjSw3DcQCHfyd9W3HC9W2HwhnhFMKsUP3).

Reproduce the published calculation with no private files:

```bash
npm run cover:measure -- docs/evidence/cover-native-experiment-2026-11-14.json \
  docs/evidence/cover-native-before-2026-11-14.json \
  3629bbd4a610f8a5e3dd7168db566b9767e13e38e834bdcafc5d66da37e1efb3 \
  docs/evidence/cover-native-after-2026-11-14.json \
  049c330741151b80638507770382d824ef8657bf53cbca4db707bbc8c39faaac \
  /tmp/new-cover-effect.json
```

## Validation

Core types and **576 tests** pass, including eleven cover cases for whole-cycle cost bounds, mainnet/FT rejection, durable rate/count/expiry limits, identity changes, uncertain intent blocking, exact same-operator calls, restart reconciliation, historical journal capture and synthetic-metric separation. The compiled service CLI reads the completed journal. Offline reproduction matches the published report exactly and rejects incorrect hashes, symlinks and overwrite attempts. Output mode is 0600; public evidence was checked against the private key and all note witness values. The browser SDK inventory remains unchanged.

The public run verifies native software-wallet execution with development proving material. Production privacy, independent customer participation and hosted-wallet/USDC qualification remain open.
