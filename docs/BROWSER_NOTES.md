# Browser notes and public deposit plans

[Service overview](SERVICE.md) · [Development roadmap](ROADMAP.md)

Front `/notes/` creates a private FT note locally, encrypts a single-note backup, verifies the downloaded file, and prepares a public deposit plan. The existing `/live/` wallet flow reviews and submits that plan. Creating a note or preparing a plan does not deposit funds. FT withdrawal proofs can now be generated locally in [Front Local proofs](BROWSER_PROVER.md); native and private-transfer proving remain available through the CLI.

## Create and fund a note

1. Obtain the original group's FT policy independently. Use the approved group directory in Settlements to check an enabled group and download its policy before creating a new note. Notes never migrate between groups.
2. On **Private notes**, import that testnet policy, choose and confirm a passphrase of 12–1,024 characters, and create the encrypted note. Generation requires no API or wallet connection.
3. Download the encrypted backup. Reopen that file with its passphrase in **Verify your backup**. Preparation stays disabled until the note and its full policy validate. Keep the file and passphrase separately.
4. Enter the matching Core API. Supply a selective-disclosure receipt root, retaining its private openings separately, or choose a new random reference for a deposit without evidence. Reusing references can link activity.
5. Optionally specify a vault. Otherwise the server verifies up to the first 20 registry records and selects an eligible vault. An unsuccessful partial scan does not establish that the whole group is unavailable. An explicit vault can be verified beyond that window.
6. Prepare and inspect the public deposit call, download the plan and import it in Settlements with the same trusted policy. Approve registration, storage and payment individually. Confirm the bound deposit record is `Active`.
7. Retain the encrypted note for spending. Keep the operation-journal backup and receipt openings separately; neither replaces the note backup.

Locking, page-hide events and persisted browser-cache returns clear the active note and passphrases from application state and the rendered view; a downloaded backup is required to reopen it. No note collection or plaintext is persisted in browser storage. JavaScript cannot guarantee physical erasure of memory. Failed refreshes clear old plans; lock/unmount invalidates pending file reads, encryption results and network responses. Failed backup checks disable preparation, preserving the current note until explicitly locked.

## Browser SDK

```ts
import {
  createPrivateNote, encryptNoteBackup, openNoteBackup, HttpGateway,
} from '@company-privacy-settlement/core/client';

const note = await createPrivateNote(trustedPolicy);
const encrypted = await encryptNoteBackup(trustedPolicy, note, passphrase);
// Save the encrypted file, then read it back locally.
const restored = await openNoteBackup(downloadedFile, passphrase, trustedPolicy);
const prepared = await new HttpGateway(trustedApiOrigin).prepareDeposit(
  trustedPolicy,
  { commitment: restored.note.commitment, disclosureRoot, ...(optionalVault ? { vault: optionalVault } : {}) },
  { signal: abortController.signal },
);
// Use prepared.plan in the existing SettlementSession importPlan flow.
```

Omit `vault` when no explicit vault is selected. Backups contain the original complete policy and version-1 note inside an AES-256-GCM envelope using PBKDF2-SHA256 (250,000 iterations), a fresh 16-byte salt and 12-byte IV, and separate authenticated data `core:private-note:v1`. The outer format is `core-private-note`; the envelope must be at most 16 KB. Wrong passwords, tampering, changed policies and malformed notes are rejected. This format is distinct from journal, invoice-library and legacy CLI scrypt backups.

## CLI compatibility

Existing `shared-deposit-args`, `shared-spend-args`, `group-deposit-args` and `group-spend-args` accept browser backups directly. Set `CORE_NOTE_PASSWORD` securely as described in the Core README; never include the actual passphrase in an argument or upload the backup to Core's API.

```bash
npm run cli -- shared-spend-args trusted-policy.json https://rpc.testnet.near.org core-private-note.json action.json withdrawal-plan.json
```

The backup's full policy must match the supplied trusted policy or an approved directory entry before RPC work. The existing note domain, commitment and circuit validation still apply. Legacy encrypted CLI notes remain supported. Native NEAR note generation remains in the CLI; the new browser workflow is FT-only.

## Read-only public API

`POST /v1/deposits/prepare` accepts exactly:

```json
{
  "commitment": "42",
  "disclosureRoot": "abababababababababababababababababababababababababababababababab"
}
```

`42` is a schema example, not a usable note backup. Optional `vault` selects a particular registry member. Zero, noncanonical or out-of-field commitments, unknown fields, secrets, nullifiers, notes, request-controlled RPCs and query parameters are rejected. The server uses its configured trusted policy. It never accepts a private note to validate a public deposit request.

All group and vault verification occurs at one finalized block. The result contains the policy, block, public `plan`, `remainingOutputs`, `checkedVaults` and `vaultScanComplete`. Full scan coverage requires all registry records to have been checked; selecting its last member alone remains a partial scan. The route costs 5 rate points and allows at most 80 source reads, subject to deployment limits and cancellation. Full groups reject new deposits; the server does not select a different group. Capacity is an observation, not a reservation.

The client first compares `/v1/config` against the independently imported policy. It checks the returned token call, original commitment, disclosure reference, optional selected vault, exact principal plus 0.15% fee, 1 yoctoNEAR attachment and 300 Tgas. Registration, NEAR action storage, ledger bonds and gas costs remain separate. Plan review does not establish readiness or a completed deposit.

## Circuit compatibility and sources

The browser uses the existing v3 domain and Poseidon commitment over `(secret, nullifier, domain)`. It samples secret/nullifier locally with Web Crypto, using the same 253-bit field sampling as the CLI. The bounded BigInt implementation is checked against the existing `circomlibjs` hash for 48 boundary/deterministic vectors and through an actual sandbox deposit and later Groth16 spend.

Parameters are extracted from pinned `circomlibjs 0.1.7` and checked by SHA-256 during client builds. `node scripts/browser-poseidon.mjs --check` verifies the generated file; omit `--check` to regenerate. Upstream: [reference implementation](https://github.com/iden3/circomlibjs/blob/v0.1.7/src/poseidon_reference.js), [constants](https://github.com/iden3/circomlibjs/blob/v0.1.7/src/poseidon_constants.json). Attribution and license: [GPL-3.0](licenses/circomlibjs-GPL-3.0.txt). This does not add browser Groth16 proving or constitute an independent cryptographic audit.
