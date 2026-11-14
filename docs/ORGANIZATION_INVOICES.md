# Organization invoice API

The private Organization API stores immutable merchant-signed invoices per organization. This service is separate from the public read-only settlement API. It holds no wallet signing key or principal, never creates a merchant signature, and never marks an invoice paid. Confirmations still come from the existing verified index/checkout flow.

## Configure encryption

Requires Node 22.13+ and the [organization service](ORGANIZATIONS.md). Generate keys once, outside the repository and database backup directory:

```bash
npm run organizations:invoice-keys -- /absolute/private/service.invoice-keys.json initial
export CORE_ORGANIZATION_INVOICE_KEYS_FILE=/absolute/private/service.invoice-keys.json
npm run serve:organizations
```

The generator refuses overwrites, uses independent random 256-bit data/index keys, writes mode 0600, and prints only the path/key ID. The service requires a regular file owned by its runtime user, mode 0600 or stricter, with no symlink. Provision it through protected operator storage; never send it to the browser, commit it or include it in DB backups. Without configuration, invoice endpoints return `503 INVOICE_STORAGE_DISABLED`; other organization features remain available. There is no plaintext fallback.

For Docker, combine `ops/organizations.compose.yaml` with `ops/organizations.invoices.compose.yaml` and set `CORE_ORGANIZATION_INVOICE_KEYS_PATH` to the absolute host file. Provision ownership for the image's `node` runtime user (UID 1000) and mode 0600. The overlay mounts an existing file read-only and refuses automatic directory creation. This is deployment configuration, not a deployed backend.

## Authentication and permissions

Use the existing NEP-413 login and memory-only bearer session. Send an exact allowed frontend `Origin` and JSON requests over HTTPS (loopback HTTP for development). Each request verifies the session's current finalized FullAccess key and current organization membership. Owners/Admins/Operators can read and create; Auditors can read; Viewers cannot access invoices. Being an organization member does not establish KYB, legal representation or on-chain signing authority.

New invoices must carry a valid NEP-413 merchant signature over their exact terms. The merchant account must equal the authenticated creator and its invoice signing key must be a current testnet FullAccess key. Another member cannot upload a different merchant's invoice. An organization owns the resulting record: authorized invoice readers within that organization can read it. The same signed request can be independently archived in another organization where that merchant has creation permission; IDs and deduplication are scoped to the organization.

## Endpoints

| Method and path | Request / response |
| --- | --- |
| `POST /v1/organizations/:org/invoices` | `{requestId: UUID, invoice: SignedInvoice}` → `{invoice: OrganizationInvoice, replayed: boolean}` |
| `GET /v1/organizations/:org/invoices` | `{items: OrganizationInvoice[], nextCursor: number \| null}`; at most 50, newest sequence first |
| `GET /v1/organizations/:org/invoices?before=51` | Next page with sequence strictly below the cursor; derive it from `nextCursor` |
| `GET /v1/organizations/:org/invoices/:id` | One authorized organization's record, by its opaque storage UUID |

`OrganizationInvoice` contains `id`, `organizationId`, `sequence`, canonical UTC `createdAt`, `createdBy`, and the original signed `invoice`. Storage UUID differs from the merchant's signed invoice UUID. Unknown POST fields and unsupported queries are rejected. Existing 8 KiB body, deadlines, concurrency/rate budgets and no-store response controls apply. Expired signed invoices can be archived; storage is not payment authorization. Checkout must independently verify current merchant ownership, trusted policy, expiry, amount/fees and finalized settlement.

Use a stable `requestId` for every retry of the same request, including timeouts. The first save returns 201. An exact retry returns 200 and `replayed: true`, preserving the original storage ID and timestamp. A different request ID for the exact same signed merchant invoice also returns that record and records a retry alias. Reusing a request ID with different content returns `409 IDEMPOTENCY_CONFLICT`; changing an existing merchant invoice's signed terms/signature returns `409 INVOICE_CONFLICT`. Canonical JSON ignores object field ordering. There is no update/delete endpoint. Exact historical replays remain readable after invoice signing-key rotation, while the caller's live session and permissions are always rechecked.

Creation, uniqueness, retry aliases and the `invoice.created` audit event commit together in a SQLite immediate transaction. Concurrent attempts create one record and one creation event. Session cancellation, logout or membership removal while verification is pending cannot produce a late authorized write. Limits are 1,000 invoices and 4,000 retry aliases per organization; pagination avoids unbounded responses. Foreign organization IDs are hidden from nonmembers; foreign record IDs never escape the authorized organization scope.

## Browser SDK

```ts
import { OrganizationClient, OrganizationInvoiceClient } from '@company-privacy-settlement/core/client';
const invoices = new OrganizationInvoiceClient(new OrganizationClient(apiOrigin, session.token), organizationId);
const saved = await invoices.save(stableRequestId, signedInvoice, abortController.signal);
const firstPage = await invoices.list(undefined, abortController.signal);
const original = await invoices.get(saved.invoice.id, abortController.signal);
```

The helper transports signed terms and does not persist tokens or invoice plaintext. The existing `/invoices/` browser creation/library and checkout workflows remain usable; they do not automatically sync to this private API. [Persistent dashboard search/export (M02)](PAYMENT_DASHBOARD.md) is available; webhooks (M03) remain separate work.

## Encryption boundary and recovery

The full signed envelope, recipient, title/reference, policy, invoice nonces and creator fields are encrypted using AES-256-GCM with fresh 96-bit nonces and 128-bit tags. Authenticated additional data binds the service audience, organization, storage ID, sequence/time, key ID and blind indexes. Swapped ciphertext or changed bound metadata fails closed with `503 INVOICE_DECRYPTION_FAILED`.

Natural invoice IDs, request IDs and payload equality use domain-separated organization-bound HMAC-SHA-256 indexes with a separate secret index key. There are no public plaintext hashes enabling dictionary lookup of terms. The database still reveals organization IDs, record counts/order/timestamps, ciphertext lengths, key IDs and existing organization/member/audit metadata. The audit stores an opaque record ID, not signed terms. This is server-side encryption at rest: authorized API responses and the running service can access plaintext. It is not end-to-end encryption or concealment from the service operator. HTTPS and protected runtime/host storage remain required.

Key-file format:

```json
{"format":"core-organization-invoice-keys-v1","activeKeyId":"initial","indexKey":"<independent 32-byte base64url>","keys":{"initial":"<32-byte base64url>"}}
```

To rotate encryption keys, provision a new random data key under a new key ID, keep older keys, change `activeKeyId` and restart. New writes use the new key; old ciphertext still needs its original key. Startup checks refuse a changed index key, changed material under an existing key ID, or missing keys used by stored records. Never reuse a key ID. The stable index key cannot be rotated without a separately designed reindex/migration. No automatic re-encryption or key erasure is included. Protect all key versions required by retained backups; database backups alone cannot recover encrypted terms.

[Organization backup/recovery](ORGANIZATION_BACKUPS.md) preserves ciphertext and blinded idempotency indexes without copying keys. A restored snapshot remains quarantined and drops sessions/challenges; reviewed current ACL activation is still mandatory. Re-provision the correct key ring separately before serving invoices. A removed historical member cannot recover invoice access through restoration. A wrong/missing ring never causes plaintext restoration or new duplicate records.

Validation covers real Ed25519 signatures, HTTP/session/tenant isolation, concurrent idempotency, conflicts, at-rest plaintext absence, authenticated metadata tampering, key loading/rotation, bounded pagination, and encrypted backup/reviewed recovery. The compiled-runtime harness additionally generates a protected key file, starts/restarts the service and reads the encrypted invoice after CLI backup/restore/activation. Container image execution and public testnet backend deployment require their respective external environments.

## Payment management dashboard

[Organization payment dashboard](PAYMENT_DASHBOARD.md) provides complete-snapshot search, state/asset/group/date filters, CSV/JSON export and finalized-index payment observations in Front `/organization/` → Invoice payments. Signed JSON can be explicitly saved to organization storage. Local creation remains independent. Unknown, stale and incomplete observations remain explicit; exports require current read access.
