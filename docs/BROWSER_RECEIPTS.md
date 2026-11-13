# Private browser receipts and selective disclosure

[Service overview](SERVICE.md) · [Development roadmap](ROADMAP.md)

Front `/evidence/` creates a version-1 receipt locally, encrypts its complete contents, and exports proofs for explicitly selected fields. `/notes/` can import a disclosed receipt locally and use only its root in a public deposit plan. No receipt service, identity provider, AI tax calculation or filing endpoint is involved.

## Create, keep and disclose

1. Enter your eight declared fields: sender, recipient, asset, amount, purpose, reference, occurrence time and optional credential hash. Each value is a string of at most 4,096 characters. Empty values are allowed; they do not establish missing facts.
2. Choose and confirm a passphrase of 12–1,024 characters. The complete receipt is encrypted in this tab. Its public commitment is displayed; the draft inputs are cleared.
3. Download the encrypted receipt and reopen that file with its passphrase to verify the backup. Keep this file separately from private notes and operation-journal backups.
4. Select fields intentionally. Nothing is selected by default. Prepare and review the disclosed values, then download the selected disclosure file. Values in this exported file are readable by its recipients.
5. Keep the encrypted full receipt to disclose other fields later. Locking, page-hide and persisted history-cache return clear the workspace's active receipt, draft, passwords and verification views. Pending file reads or cryptographic tasks cannot reopen it. No receipt is persisted in browser storage; JavaScript does not guarantee physical memory erasure.

Use a fresh receipt for each operation. Reusing a root links public activity even when unrelated values remain hidden.

## Connect the root to settlement

On `/notes/`, open and verify your encrypted private note first. Use **Import receipt root from disclosure JSON** to load a selected disclosure. The browser validates its field proofs against its own root and retains only that root for the deposit request. This import is a preparation check, not independent settlement verification. Invalid imports clear the previous root and deposit plan.

The API receives the note commitment, receipt root and optional vault. Receipt values, opening salts, private notes and backup passwords remain local. Review and sign the existing deposit flow separately. For a generic non-invoice withdrawal prepared in the CLI, use the receipt's root as the action's `disclosureRoot`. The contract/circuit binds this opaque root; it does not inspect the business values.

**Invoice checkout is a distinct binding.** An [invoice payment](INVOICES.md) must use its signed-derived per-unit reference as `disclosureRoot`. An arbitrary receipt root cannot replace it or be silently attached to the same reference. A combined invoice/business-evidence commitment needs a separately designed/versioned format. Deposit receipt roots and invoice withdrawal references should not be presented as one automatically linked receipt trail.

## Verify a disclosed receipt

The verifier requires a root supplied separately from the file, for example one independently observed in a trusted settlement record. It does not prefill trust from the imported file. It checks every selected field, salt and Merkle path against the expected root. Wrong roots, changed values/fields/paths, unknown fields, empty disclosures and duplicate openings are rejected. Changing the expected root or importing another file removes the previous result.

**Receipt integrity verified** means only that the disclosed declarations match that root. It does not establish that the root is on-chain, that a payment completed, that the declarations are truthful, or that an identity, credential or tax filing was accepted. The browser verifier makes no chain request. Use the existing CLI `verify-bundle` with an independently configured evidence source to check selected transaction inclusion and finalized event anchoring. Even a valid anchored root does not establish the truth of every declared field or a complete payment history.

## SDK

```ts
import {
  createReceipt, encryptReceiptBackup, openReceiptBackup,
  discloseReceipt, verifyReceiptDisclosure,
} from '@company-privacy-settlement/core/client';

const receipt = await createReceipt({
  sender: 'internal sender reference', recipient: 'internal recipient reference',
  asset: 'nep141:your-token.testnet', amount: '1000000',
  purpose: 'Project milestone', reference: 'INV-001',
  occurredAt: new Date().toISOString(), credentialHash: '',
});
const backup = await encryptReceiptBackup(receipt, passphrase);
const reopened = await openReceiptBackup(downloadedBackup, passphrase);
const disclosure = await discloseReceipt(reopened, ['asset', 'amount']);
const checked = await verifyReceiptDisclosure(disclosure, independentlyObtainedRoot);
```

Declared values and parsed proofs are copied before asynchronous hashing. Field names and their tree positions are fixed. The SHA-256 leaf and three-level Merkle proof format matches `sdk/disclosure.ts` and existing evidence bundles. Browser and Node receipts verify in both directions.

Encrypted backups use format `core-private-receipt`, authenticated data `core:private-receipt:v1`, PBKDF2-SHA256 with 250,000 iterations, AES-256-GCM, a fresh 16-byte salt and 12-byte IV. The envelope holds `{version:1,receipt}` and must contain all eight valid openings. It is distinct from note, journal and invoice-library formats. Files are capped at 200 KB. No ciphertext format or contract upgrade is required for existing data.

## CLI

Existing plaintext receipt files remain readable. The `disclose` command also reads browser-encrypted full receipt backups. Set `CORE_RECEIPT_PASSWORD` securely in the environment; never put the actual passphrase in command arguments or upload the backup to the API.

```bash
npm run cli -- disclose core-private-receipt.json asset,amount,reference
```

The output is the same selected-opening receipt object accepted by `verify-bundle`. Keep a selected disclosure inside the intended bundle transaction's `disclosure` field; the verifier checks it against that transaction's finalized record root. CLI field selection rejects unknown, duplicate, empty or unavailable fields.

Validation includes cross-implementation proofs, tampering, Unicode limits, asynchronous input changes, separate encryption contexts, CLI compatibility, lifecycle cancellation, and a browser-generated receipt root anchored and verified in the actual FT sandbox evidence bundle.
