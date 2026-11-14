# Signed payment webhooks

The separate Organization API provides durable `invoice.payment_confirmed` notifications for encrypted saved invoices. An optional server worker reads the independently pinned **local finalized SQLite index**, creates immutable events and an outbox, then delivers to approved HTTPS callbacks. Browsers cannot submit payment events or set paid. Contract ABI, principal custody and 0.15% additive fees are unchanged.

## Enable the worker

First configure [organization invoice encryption](ORGANIZATION_INVOICES.md) and run the verified finalized indexer. Configure the organization service with:

```bash
export CORE_WEBHOOK_ALLOWED_ORIGINS=https://merchant.example
export CORE_WEBHOOK_INDEX_DB=/absolute/core-service-data/activity.sqlite
export CORE_WEBHOOK_POLICY_FILE=/absolute/independently-reviewed-policy.json
export CORE_WEBHOOK_POLICY_SHA256=INDEPENDENTLY_OBTAINED_SHA256
npm run serve:organizations
```

The policy file is public configuration, not a signing key; its independent SHA-256 and exact testnet policy must match the read-only index. Partial worker configuration fails startup. Without the index setting, management/storage remain available but no delivery worker runs. Without the separately protected organization invoice key ring, webhook storage is disabled. The service never generates a default key or uses browser-reported payment state.

For containers, combine `ops/organizations.compose.yaml`, `ops/organizations.invoices.compose.yaml` and `ops/organizations.webhooks.compose.yaml`. Supply `CORE_WEBHOOK_INDEX_DIRECTORY` including the SQLite WAL/SHM sidecars and `CORE_WEBHOOK_POLICY_PATH`; both mounts are read-only. The verified index writer must remain operational. Docker execution and public backend deployment require their external environments; the overlay itself does not deploy them.

One worker process supports one exact policy. It scans 25 saved invoices per round and delivers at most 10 jobs per round, every five seconds without overlapping its own ticks. Large collections catch up across rounds. Multiple processes share transactional delivery leases. An index outage blocks new event creation but does not prevent retries of already committed outbox jobs. No chain RPC or public HTTP status source can be supplied by an invoice/browser to the worker.

## Configure and manage

Front `/organization/` → **Webhooks** lists callbacks, paginated delivery history, attempt outcomes, next retry times and failures. Owners/Admins can create, pause/resume, rotate a secret and retry dead/recovery-held deliveries. Operators/Auditors can read; Viewers cannot load webhook data. Management uses current wallet-session/key and organization authorization. Page-hide, session/organization/role changes discard private UI state.

Prepare an independent random 32-byte base64url signing secret, configure it in your receiver, then create the callback. The browser can generate one with `createWebhookSecret()` and reveal it for copying into your own secret manager; it is never persisted by this UI. Store it before submitting: the API never returns the secret. A signing key fingerprint is safe to display. Secret rotation changes future signatures; receivers may retain the previous secret during a deliberate transition. The encrypted event body/event ID remains stable across rotation.

| Endpoint | Behavior |
| --- | --- |
| `GET/POST /v1/organizations/:org/webhooks` | List up to five callbacks; create with `{requestId: UUID, url, secret}` |
| `POST .../webhooks/:id/pause` or `/resume` | `{version}`; current-version optimistic update |
| `POST .../webhooks/:id/rotate` | `{version, secret}`; explicit new signing key |
| `GET .../webhooks/deliveries?before=N` | 50 newest per-org sequences, `{items,nextCursor}` |
| `GET .../webhooks/deliveries/:id` | Delivery, immutable event and up to 32 attempt records |
| `POST .../webhooks/deliveries/:id/retry` | `{version}`; only dead/held jobs, active endpoint and at most three manual redrive cycles |

Exact create retries return the same endpoint with `replayed: true`. Reusing a request ID with another configuration conflicts; an existing URL cannot silently acquire a different secret. After rotation an old configuration replay conflicts. Up to 1,000 create aliases and five immutable callback URLs are retained per organization. To change URL, create a new callback and pause the old one; pending jobs cannot be retargeted.

Callbacks must use an exact operator-approved HTTPS origin on port 443. Credentials, query parameters, fragments, IP literals and unapproved hosts are rejected. Before every send the worker resolves the hostname, rejects mixed/nonpublic DNS answers, pins a validated address for the socket, preserves hostname TLS verification, disables redirects/pooling and applies a five-second overall deadline. Private, loopback, link-local, CGNAT, documentation/reserved and IPv6 transition destinations are denied. The conservative IPv6 rule admits global 2000::/3 except 2001::/16, 2002::/16 and 3fff::/16. Deploy behind an appropriate outbound network policy as well; an allowlisted URL is a destination restriction, not merchant KYB.

## Events and signatures

Each matching finalized **successful** withdrawal with independently linked transaction provenance creates one event per saved invoice/nullifier. Requests, failures, unlinked records, stale/incomplete index coverage and repeated v2 payment-unit references do not generate confirmations. Historical valid payments catch up after registration. New callbacks can receive existing immutable events; previous successful deliveries are preserved. Event creation and per-endpoint delivery uniqueness commit together. The per-organization event cap is 10,000; exceeding it fails closed and requires an explicit retention/capacity decision, never silent dropping.

The version 1 body contains `id`, `type`, `version`, `organizationId`, `producer`, `createdAt`, and `data`: saved/signed invoice IDs/hash, exact policy registry/asset, recipient/principal atomic amount, nullifier, final record index/height, linked transaction and source checkpoint. `createdAt` is event observation time, not block time. Each event confirms **one payment**, not a mutable aggregate `invoice.paid` flag. A consumer can reconcile aggregate totals from final events or the existing indexed history. Titles/references, invoice signing/payment nonces and wallet/encryption keys are excluded.

Every attempt signs the exact UTF-8 body with HMAC-SHA-256 and sends:

```text
Core-Event-Id: <stable UUID>
Core-Webhook-Timestamp: <fresh Unix seconds>
Core-Webhook-Key-Id: whk_<first 16 hex of SHA-256(raw secret bytes)>
Core-Webhook-Signature: v1=<64 lowercase hex>
```

The signed message is `core:webhook:v1\nTIMESTAMP\nEVENT_ID\nKEY_ID\nRAW_BODY`. Never parse/re-serialize the body before verification. `verifyPaymentWebhook` checks a five-minute timestamp window, key ID, constant-time WebCrypto HMAC verification, body/event-ID binding, expected organization and the authenticated v1 event shape. Delayed retries keep their event body/ID but receive a fresh attempt timestamp/signature.

## Receiver deduplication

Delivery is **at least once**, including the crash after receiver commit but before sender acknowledgement. No distributed transport can promise exactly-once external side effects here. Return 2xx only after durable idempotent business work commits. A timeout may already have been accepted: deduplicate by event ID, never only by attempt signature/timestamp.

The Node SDK provides `PaymentWebhookInbox` (`dist/node/webhooks.js`):

```ts
const inbox = new PaymentWebhookInbox('/private/receiver.sqlite', organizationId);
inbox.db.exec('CREATE TABLE IF NOT EXISTS received_payments(event_id TEXT PRIMARY KEY, amount_tokens TEXT NOT NULL)');
const result = await inbox.accept(rawUtf8Body, lowerCaseWebhookHeaders, [currentSecret, previousSecret], (db, event) => {
  db.prepare('INSERT INTO received_payments VALUES(?,?)')
    .run(event.id, event.data.amountTokens);
});
// Acknowledge HTTP 200 only now, including result.duplicate === true.
```

Keep receiver secrets in protected runtime secret storage; they are not a URL parameter. The inbox file is owner-only. Verification precedes its immediate SQLite transaction. Receipt uniqueness and synchronous business writes commit/roll back together. Exact duplicates return success without reapplying the handler; conflicting content under an accepted event ID is rejected. Use synchronous DB work in this handler. Asynchronous/external fulfillment needs its own transactional outbox and idempotency key; do not make an external payment inside this transaction. The helper authenticates the sending integration and final-index claim; it is not independent light-client proof verification or tax/legal acceptance.

## Retry, failures and recovery

Only 2xx acknowledgements mark delivered. Network errors, 408/425/429 and 5xx retry up to eight attempts per cycle after 5s, 30s, 2m, 10m, 1h, 6h and 24h. Bounded numeric Retry-After for 429/503 can extend the delay. Other 4xx, redirects and blocked destinations become dead letters. Response bodies are neither retained nor logged. Errors are safe codes plus HTTP status; each reservation, completion, failure and abandoned lease remains in attempt history.

Thirty-second leased reservations and a final pre-send endpoint/version check prevent healthy concurrent workers and stale leases from issuing the same reservation. Expired reservations become unknown/WORKER_INTERRUPTED and retry with the same event ID. Pause/rotation fences sends that have not opened a socket yet; an already-sent request cannot be recalled. Manual retry preserves event identity/history and cannot resend a successfully delivered job. Optimistic versions prevent a double-click from spending another retry cycle.

The organization key ring encrypts endpoint URL/secret and complete event bodies using AES-256-GCM, with separate domain/AAD and keyed tenant-bound dedup indexes. IDs, counts, delivery states/times/status codes and existing organization/audit metadata remain visible in protected SQLite; plaintext secrets, callback paths and event bodies are not written to WAL/audit. Keep all data keys required by retained backups.

[Reviewed backup/recovery](ORGANIZATION_BACKUPS.md) preserves immutable events and dedup/attempt history, pauses every restored callback, and holds pending/in-flight sends. Current access must be reviewed first; a current Owner/Admin must explicitly resume a callback and retry held deliveries. Restoring a database cannot automatically reactivate historical outbound authority. Retained event IDs also let the receiver reject any duplicates across disaster recovery. Coordinate shutdown of the superseded deployment before promoting a recovered service.
