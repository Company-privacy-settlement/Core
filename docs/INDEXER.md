# Finalized settlement journal index

The Core indexer copies the configured shared registry's append-only `get_records` journal into local SQLite. It verifies the same immutable code, keyless-account, verifier, asset, denomination and fee policy used by the operations SDK. It supports native shared v2 and FT/USDC v3, without changing Contract or Front.

This is a **registry journal index**, not an assertion of complete company history. A withdrawal request, failure or retry is an event, not proof that principal arrived. Only the corresponding successful settlement state/event establishes completion. Legal identity, tax classification and filing are separate claims.

## Run

Requires **Node.js 22.13.0 or later**. This implementation uses built-in `node:sqlite`; Node 22 still labels that module experimental and can print its standard warning. No external database service or additional runtime dependency is required.

```sh
npm ci
export CORE_POLICY_FILE=/absolute/path/to/independently-trusted-policy.json
export CORE_RPC_URL=https://your-archival-testnet-rpc.example
export CORE_INDEX_DB="$PWD/data/activity.sqlite"

npm run index -- once
npm run index -- watch
npm run index -- status
```

Supply an actual deployment policy, including reviewed code/verifier hashes. There is no simulated-chain fallback. Each sync pins a finalized block and reads the authoritative record count and pages at that hash. A cycle copies up to ten pages of 50 records; the next cycle resumes from the committed index. `watch` waits five seconds between cycles; `CORE_INDEX_INTERVAL_MS` accepts 1,000–60,000 ms. The SDK allows explicit bounded page/transaction budgets.

The database is initialized for **one exact policy**. A different policy, unsupported schema or unrelated existing SQLite database is rejected. New database files use mode 0600; the default `data/` location and SQLite sidecars are Git-ignored. Store the database on a local disk with SQLite-compatible locking; the worker is not designed for a shared network filesystem or horizontally distributed database.

## Durable checkpoints and finality

A checkpoint records `{block:{hash,height},nextIndex,sourceRecordCount,updatedAt}`. A page's records and its checkpoint commit in the same SQLite transaction, using WAL and `synchronous=FULL`. A malformed, incomplete, reordered, wrong-asset or invalid-fee page cannot partially advance its checkpoint. SQLite write transactions hold no RPC calls. Compare-and-swap rejects another worker's stale checkpoint; read-only API requests use a consistent read transaction.

On resume, the worker checks the previously finalized height/hash, verifies that the final head has not regressed, compares the last indexed record, and refuses a decreasing record count. It never indexes optimistic state. A temporary stale provider leaves the database unchanged. A changed finalized block or immutable journal stops watch mode with `FINALITY_CONFLICT`; preserve the database, investigate the RPC/chain, and rebuild into a separate file only after establishing the correct chain. There is no silent rollback or checkpoint reset.

Historical checkpoint/receipt checks require access to older blocks. RPC `UNKNOWN_BLOCK`, pruned data or provider failures do not mean an empty record page. Use an archival provider with suitable retention. The indexer trusts the configured RPC; it does not implement a cryptographic light client. Local database files and their integrity are an operator trust boundary.

## Transaction and receipt correlation

The contract journal does not contain originating transaction hashes. This version indexes every registry record from zero, then **independently enriches records using operator-supplied public transaction references**. It does not scan every NEAR shard for transaction discovery or infer a hash from an address/timestamp.

Write a public JSON array containing only existing transaction hashes and signers:

```json
[
  {"hash":"<actual NEAR transaction hash>","signer":"payer.testnet"}
]
```

```sh
export CORE_INDEX_TX_REFS=/absolute/path/to/public-transaction-references.json
npm run index -- once
```

Replace the placeholder with an actual base58 hash. The strict manifest accepts at most 1,000 references and 200,000 characters. The database retains a deduplicated queue of at most 10,000 candidates. Wallet journal exports are encrypted and contain a different format: extract only the public `{hash,signer}` references locally, and never send passphrases, keys or private notes to the worker.

The worker processes 20 pending candidates per cycle. References persist across restarts; unknown/non-final transactions, transient RPC errors, and records not yet copied remain pending. Candidates rotate by last attempt so one missing transaction does not starve the queue. A finalized transaction unrelated to this registry is marked `unrelated`; proven malformed/mismatched provenance is marked `invalid`, without linking it or changing journal records. These states are visible as counts in status. Invalid candidates are not automatically retried; investigate the source before an operator-led rebuild/re-enrichment.

For every link, the worker checks:

- The original transaction hash/signer and `final_execution_status: FINAL`.
- A successful receipt executed by the pinned **registry**, with the exact `core_shared` version, event kind and complete record fingerprint.
- Agreement with the authoritative indexed record, including commitment/nullifier, vault, recipient, receipt root, amount, asset, fees, execution height and timestamp.
- A matching canonical receipt execution block no later than the verified checkpoint.

It stores only the transaction reference, successful receipt IDs/block hashes, verification checkpoint, and whether the **outer transaction** succeeded or failed. A successful nested receipt can have committed a journal record even if a later outer result failed; the API keeps that distinction. It does not treat transaction failure as proof that a payout failed or is safe to resend. Failed-receipt logs and logs from other executors cannot establish provenance.

Unenriched records remain available with `provenance: null`. Missing provenance never hides a real journal event or invents its source. Automatic chain-wide transaction/receipt discovery is a separate remaining task.

## Read-only HTTP integration

Run the API against the same policy and database after the first sync:

```sh
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
curl http://127.0.0.1:3001/v1/index/status
curl 'http://127.0.0.1:3001/v1/activity?limit=20&kind=withdrawal_succeeded'
```

The worker opens a writer connection; the API opens a **read-only** connection and cannot enqueue references, change a checkpoint or broadcast a transaction. Existing operations routes keep their behavior. When `CORE_INDEX_DB` is absent, index routes return 503 `INDEX_DISABLED`. An initialized but unsynced database reports its null checkpoint; activity returns 503 `INDEX_NOT_READY`.

| Route | Result |
| --- | --- |
| `GET /v1/index/status` | Policy, durable checkpoint, indexed/linked counts, remaining count at the last observed head, and candidate-state counts |
| `GET /v1/activity` | Descending immutable journal records, observed block, optional verified provenance, snapshot and next cursor |

Activity accepts `limit` (1–50, default 20), `cursor`, `kind`, `vault`, `recipient`, `nullifier` and `commitment`. Unknown/duplicate query fields and malformed/cross-filter cursors return 400. CORS, concurrency limits, no-store responses and redacted errors remain in effect. Index routes read local data and do not make chain RPCs; `chainFreshnessChecked: false` and the checkpoint make that limitation explicit. A previously healthy database can become stale if its worker/provider stops. Treat its height/time as observed history, not current chain readiness.

Pages use descending record indices and a fixed `upperExclusive` high-water mark. Later appends cannot shift the remaining pages. Cursors are bound to the database generation and filter set; recreating a database invalidates its old cursors. Cursors are public pagination state, **not authentication**. Provenance can be enriched between pages while record membership/order stays fixed. API responses do not certify complete business history or tax filing acceptance.

A returned record index plus its verified transaction reference can be used in Core's existing **selected-transactions** evidence bundle. Continue verifying the bundle against the chain; a database response is not a new tax certificate. Disclosure openings and business documents remain outside the public index.

## Verification

```sh
npm run check
npm test
npm run demo:ft
```

Tests cover restart/resume, atomic rollback, malformed pages, stale writers, finality conflicts, policy mismatch, stable pagination, invalid cursors, pending provenance, forged receipt logs, native v2 and FT v3, read-only API behavior and cancellation. The sandbox integration indexes real WASM/Groth16 settlement records, reopens the file without duplicates, links finalized transaction/receipt provenance, and paginates it through a separate read-only API connection. The sandbox token is a test fixture, not Circle-issued USDC, and no public testnet deployment is implied.

Primary references: [NEAR finalized transaction/receipt RPC](https://docs.near.org/api/rpc/transactions), [canonical block queries and archival errors](https://docs.near.org/api/rpc/block-chunk), [Node 22 SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html).
