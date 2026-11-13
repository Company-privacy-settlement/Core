# Local encrypted invoice library

The merchant workspace can keep up to **100 signed invoice requests** in an encrypted browser library. This is optional client-held storage, separate from the encrypted wallet-operation journal. It does not create an invoice database on the Core API or store private notes.

## Merchant workflow

1. Connect the merchant's testnet wallet on Front `/invoices/`. The account selects a library namespace; the passphrase unlocks its contents.
2. In **Your invoice library**, enter a passphrase of 12–1,024 characters and choose **Create library**, or unlock the existing library.
3. Create or open a signed invoice, then choose **Save displayed invoice**. Saving is explicit. Signing an invoice alone does not persist it.
4. Search by title/reference and open an invoice to view its signed terms and payment link. Set its matching Core API before refreshing indexed settlement.
5. Export an encrypted library backup and retain its passphrase separately. Lock the library when finished. Reconnecting another merchant closes the previous account's library.

Full titles, references, policies, signatures and saved timestamps are encrypted at rest. The browser's storage key contains the public network/account namespace. Drafts remain in page memory until navigation/reload or a merchant-account change; a separately opened public signed JSON/link remains readable to its holder. Locking hides the library list and an invoice opened from it, and drops the library's in-memory passphrase reference. It does not erase external copies, browser backups or shared links.

No chain/API request is made to save, search, open, export, restore, merge or remove library entries. Opening a library entry does not automatically query payment status. Existing public merchant verification and invoice status requests are sent only when the existing invoice flow explicitly invokes them; they do not include titles or human references.

## Encryption and integrity

The `core-invoice-library` version-1 envelope uses PBKDF2-SHA256 with 250,000 iterations, a fresh 16-byte salt, AES-256-GCM and a fresh 12-byte IV. Associated data is `core:invoice-library:v1`, separate from the existing operation journal's `core:operation-journal:v1`. Changing an envelope's format label cannot convert it into another storage format. Encryption is authenticated, and the envelope accepts no arbitrary unencrypted metadata fields.

The decrypted payload is `{ version: 1, owner: { network, accountId }, invoices }`. Each entry has exactly `hash`, `signed` and `savedAt`. Reads verify the local NEP-413 signature, invoice hash, merchant/network binding, unique invoice IDs/hashes and timestamp shape. Duplicate identical saves are idempotent; changing terms or signatures under an existing ID is rejected. Expired invoices remain valid historical archive entries.

This checks signed-term integrity, not current account-key permissions, legal identity, KYB or paid status. The existing API must still verify a current merchant FullAccess key and reconcile finalized records for a fresh payment observation. The library stores no `paid`/`partial` status cache, fulfillment authorization or tax certificate.

## Backups and removal

**Export encrypted library** downloads only the encrypted envelope. **Restore encrypted library** requires empty storage for the selected merchant and the backup's passphrase. Existing ciphertext is preserved when a restore is refused. To combine backups with an existing library, unlock it and use **Merge an encrypted backup**; supply a different backup passphrase when necessary.

Merging validates the complete incoming library before writing, keeps existing immutable requests, deduplicates exact repeats and rejects conflicting IDs/signatures. Wrong merchant/network, authentication failure, corrupted entries, unknown fields or more than 100 total invoices leave the existing encrypted library unchanged. Both formats enforce the existing 2 MB plaintext / 3 MB envelope limits.

**Remove local copy** changes only this library's encrypted records. It does not cancel a signed payment request, change contract settlement, delete exported backups or revoke shared links. Keep the records and backups needed by your business; this browser library has no server-side recovery service or statutory retention guarantee.

Browser writes use Web Locks on the account-specific namespace and refuse an overlapping tab/request instead of risking a lost update. Locking/unmounting invalidates pending library work; a completed encryption cannot write through an already-locked instance. Other tabs' data is reloaded before every mutation. Browsers without Web Locks must use another supported browser; there is no unlocked write fallback.

## SDK

```ts
import { InvoiceLibrary, browserInvoiceLibraryStorage } from '../sdk/client/index.js';

const owner = { network: 'testnet' as const, accountId: 'merchant.testnet' };
const library = new InvoiceLibrary(browserInvoiceLibraryStorage(owner), passphrase, owner);
await library.create(); // Existing storage must be unlocked instead.
await library.add(signedInvoice);
const entries = await library.list();
const encryptedBackup = await library.export();
await library.merge(otherEncryptedBackup, otherBackupPassphrase);
library.lock();
```

`restore(envelope)` works only on empty storage. `remove(invoiceHash)` removes one local record. `list()` sorts by saved timestamp and returns verified requests. Library methods do not sign messages, broadcast transactions or contact RPC/API services. Existing operation-journal envelopes keep their previous format and associated data.

## Validation

Core tests cover encrypted persistence with zero network reads, historical signatures, immutable IDs, owner/network separation, authenticated context separation, empty-only restore, merging/deduplication, corrupt payloads, atomic conflict rejection, lock cancellation and cross-context exclusion. Browser regressions cover merchant reconnects, reload/unlock, title/reference search, encrypted export/restore, differently encrypted backup merging, local removal and locking while encryption is pending.
