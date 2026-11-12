# Core

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

The **wallet SDK, CLI, and integration code** for private settlement on NEAR. Rust contracts, ZK circuits, and contract tests live in the separate [Contract repository](https://github.com/Company-privacy-settlement/Contract). It includes a runnable read-only HTTP API for verified vault discovery, FT preflight, and finalized settlement state. Signing and proof generation remain local client operations.

The current version supports native NEAR **shared anonymity v2** and **USDC/NEP-141 v3**. Principal remains distributed among vaults, while a common forest maintains one note tree and global nullifiers. A note deposited in A can withdraw from B, and concurrent requests or retries cannot pay the same note twice. V1 independent pools and the factory remain compatible.

| Repository | Contents |
| --- | --- |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | `pool`, `factory`, `shared-vault`, `forest`, Circom circuits, native tests, and WASM builds |
| Core (this repository) | Secret notes and wallets, local proving, verified vault selection, selective disclosure, transaction evidence, KYB signature checks, CLI, and integration demos |

## Development status and operations

This iteration adds a browser-safe FT execution SDK, explicit wallet-call review, an encrypted operation journal, and exact finalized transaction verification. [Front’s `/live/` workspace](https://github.com/Company-privacy-settlement/Front) uses NEAR Connect on testnet with your independently trusted deployment policy. Uncertain signatures stay blocked across restart; acceptance is distinct from final payout. See [wallet integration and recovery](docs/WALLET.md). Private note creation/proving stays in the CLI. Automatic provenance discovery, public testnet deployment, and real KYB/tax integrations remain on [the development backlog](docs/ROADMAP.md).

The finalized registry-journal index now persists records and checkpoints in local SQLite, resumes without duplicates, verifies supplied transaction/receipt provenance, and provides stable filtered activity pages. Run `npm run index -- once` or `watch` with `CORE_INDEX_DB`; the API opens the same database read-only. Provenance is optional and explicitly unresolved until verified. This does not assert complete company history. See [indexer setup and scope](docs/INDEXER.md).

```bash
npm run cli -- ft-preflight trusted-policy.json https://rpc.testnet.near.org public-request.json
npm run cli -- settlement-status trusted-policy.json https://rpc.testnet.near.org public-reference.json
npm run cli -- settlement-wait trusted-policy.json https://rpc.testnet.near.org public-reference.json

export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

The API defaults to `127.0.0.1:3001` and uses an actual trusted deployment policy, with no simulated fallback. It exposes `/v1/vaults`, `/v1/ft/preflight`, `/v1/settlements/status`, and `/v1/transactions/verify`; wallets, private notes and signing keys stay outside the service. A transaction being accepted or an observation timing out does not establish payout completion or failure. See [operations usage and HTTP endpoints](docs/OPERATIONS.md) for inputs, readiness flags and recovery behavior.

## Getting started

Requires Node.js 22.13.0+. Contract builds use Rust 1.99.1 pinned in Contract and C/C++ build tools. Check out both repositories as siblings.

```text
workspace/
  Contract/
  Core/
```

From Core:

```bash
(cd ../Contract && npm ci)
npm ci
npm run contract:build
npm run zk:setup
npm run check
npm test
npm run demo:shared
```

Export `CORE_CONTRACT_REPO` to use a different Contract checkout path. Core's build command runs the Contract build, verifies manifest SHA-256 hashes, and copies the WASM files. `zk:setup` also runs in Contract and imports the verified proving artifacts. Generated files are excluded from Git.

`npm test` uses committed public vectors and runs independently without a Contract checkout, Rust, or setup. `npm run contract:test` / `npm run factory:test` invoke Contract's v1 tests. Run `(cd ../Contract && npm test)` for all contract tests; build the contracts first.

Demos use the official NEAR sandbox 2.14.1 on Linux x64 or macOS arm64. They exercise real WASM, real Groth16 proofs, and finalized RPC results, then remove the disposable chain. Transactions in the reports are not testnet transactions.

| Demo | Validation |
| --- | --- |
| `npm run demo:ft` | Six-decimal FT deposits/withdrawals, counterfeit rejection, cross-vault settlement, double-spend prevention, unregistered/frozen recipient recovery, and asset-aware finalized evidence |
| `npm run demo:shared` | Shared tree, cross-vault withdrawals, concurrent double-spend prevention, duplicate deposit refunds, payout retries, fees, and 12 finalized records |
| `npm run demo:factory` | V1 keyless deployment, failure refunds, and independent withdrawals |
| `npm run demo` | V1 private note transfer, fresh-wallet withdrawal, and receipt verification |

The v2 report is `demo-output/shared-validation.json`. Automatic administrator key removal occurs only inside the disposable local chain. Public-network deployment and key removal are not performed.

## USDC / NEP-141 v3

Deploy a **separate forest bound to a token address and fixed denomination** using Contract's `new_ft`. Notes are not mixed with native NEAR groups. Principal remains in each vault address's token balance; the forest receives only withdrawal fees.

Depositing 1 USDC (1,000,000 atomic units) sends **1.0015 USDC**. Withdrawal pays a separate **0.0015 USDC** fee; the recipient receives the **full 1 USDC**. Storage of 0.02 NEAR and gas are separate. Because `ft_on_transfer` cannot receive attached NEAR, first fund storage credit for the token sender. First use adds a one-time 0.005 NEAR ledger bond per contract; later top-ups do not charge another bond. Unused credit can be refunded to its owner.

```bash
(cd ../Contract && npm run build:test-ft)
npm run contract:build
npm run demo:ft
npm run cli -- quote-usdc 1
```

`demo:ft` deploys a test token based on official near-contract-standards to a disposable sandbox. It is **not Circle-issued USDC or a real public-network transaction**. Results are in `demo-output/ft-validation.json`. Existing proving setup is required; regenerate public vectors when creating a new setup.

Add the official `tokenId` to `SharedPolicy` to verify a v3 asset group. Native USDC on testnet uses `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`. Check [Circle's official addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) and distinguish USDC from USDC.e. Replace registry and code hashes in `examples/usdc-policy.template.json` with values from the actual new deployment.

SDK functions in `sdk/ft.ts`:

- `parseUsdc`, `quoteFtFees`: exact six-decimal USDC amounts and add-on fees without floating point; token quantities and yoctoNEAR are never summed.
- `buildFtRegistration`: explicit NEP-145 registration payload using the storage minimum read from the token.
- `buildStoragePrepayment`: first-use bond and remaining-credit calculations based on the actual `get_storage_credit` result.
- `buildFtDeposit`, `buildFtWithdrawal`: token calls bound to a verified catalog and proof destination, storage targets, and final-state checks.

The `shared-note`, `shared-deposit-args`, and `shared-spend-args` CLI commands also handle v3 policies. Before sending, an actual wallet must register the receiving vault, registry, treasury, and recipient on the token, and fund the token sender's NEAR storage credit. A fresh implicit wallet needs both NEAR account creation and FT registration before it can receive USDC. A successful `ft_transfer_call` means token acceptance; payout completes only when `get_withdrawal` reports `Complete`.

FT evidence uses `SettlementBundle { version: 3, assetTokenId, ... }`. Verification anchors token identity to finalized logs and summarizes token protocol fees separately from NEAR storage fees. See the [Contract USDC specification](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md) for the ABI, recovery, and redeployment requirements. Installing the new binary over existing contract state is unsupported.

## Shared v2 workflow

1. Build Contract and populate `examples/shared-policy.json` with independently verified forest/vault WASM and verifier hashes. Do not trust hashes copied from an unknown contract.
2. At one finalized block, the SDK verifies registry/vault code, empty key lists, group membership, fees, and available liquidity.
3. The recipient creates a secret note for the common group and shares only its commitment with the sender. The sender deposits directly into a verified vault.
4. The SDK reconstructs the shared tree and generates the proof locally, binding the selected payout vault and recipient.
5. The forest consumes the nullifier before the selected vault pays principal. On failure, retries preserve the original destination and spent state.

```bash
# Read the password securely; do not put it in command arguments or the repository.
read -rs CORE_NOTE_PASSWORD
export CORE_NOTE_PASSWORD

npm run cli -- discover-shared examples/shared-policy.json https://rpc.testnet.near.org
npm run cli -- shared-note examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json
npm run cli -- receipt examples/receipt-values.json private-receipt.json
npm run cli -- shared-deposit-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json RECEIPT_ROOT
npm run cli -- shared-spend-args examples/shared-policy.json https://rpc.testnet.near.org receiver-note.encrypted.json examples/withdraw-action.json withdrawal-args.json
```

These commands prepare payloads. An actual NEAR wallet must sign and submit them. If the action omits `vault`, the SDK selects verified liquidity. Replace the principal recipient `target` and fresh `disclosureRoot` with actual values. For a private transfer, use `kind: transfer`, set `target` to the recipient's commitment, and omit the vault.

Check that a vault deposit reaches `Active`. Rejected registration permits a principal-plus-protocol-fee refund to the original sender; network failures can resume through `retry_deposit`. Withdrawal completes only when the forest's `get_withdrawal` reaches `Complete`. A requested event alone is not payout confirmation. Specification: [Shared v2](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/SHARED.md).

## Fees

Deposits and withdrawals each charge **0.15% on top of principal**, preserving the recipient's full amount. Round down in yoctoNEAR for NEAR or atomic token units for FTs. Storage of 0.02 NEAR and gas are separate.

For 1 NEAR, deposit **1.0215 NEAR**; withdrawal pays a separate **0.0215 NEAR**, and the recipient receives **1 NEAR**. V2 divides storage between forest (0.015) and vault (0.005); this is not an extra fee. Transfers and retries pay storage only, without another protocol fee.

```bash
npm run cli -- quote-fees 1000000000000000000000000
```

`fee_recipient` is fixed at initialization. Vaults accrue deposit fees; the forest accrues successful withdrawal fees. Only earned fees can be collected to the fixed treasury, protecting principal, pending payouts, refunds, and storage balances. Failed fee transfers restore the ledger.

## Receipts, KYB, and fresh wallets

```bash
npm run cli -- wallet receiver-wallet.encrypted.json
npm run cli -- disclose private-receipt.json asset,amount,reference
npm run cli -- verify-bundle bundle.json https://rpc.testnet.near.org
```

Generate fresh implicit wallet keys on the user's device and back them up with AES-256-GCM encryption. Contracts do not generate or custody private keys. If a secret note is lost, the operator cannot recover it.

Receipts use independent salts per field and **a new root for each action**. Reusing a root publicly links the actions. V2 evidence compares finalized registry-executor events with journal records and checks vault, principal, fees, and disclosed-field integrity. It verifies inclusion and integrity of selected transactions, not complete history, private note flows, legal identity, or tax-filing acceptance.

Enterprise KYB verifies explicitly trusted issuers' Ed25519 signatures, subject commitments, expiry, and supplied revocation lists. It does not perform actual entity/beneficial-owner review or enforce eligibility in the circuit. US/Abu Dhabi tax and AI drafts are future work; see [compliance boundaries](compliance/README.md).

## Limitations

The shared set is cryptographic membership. Small participant counts, timing, amounts, recipients, gas wallets, and public data can reduce privacy; network anonymity is not guaranteed. The common registry is a logical state coordination point with no operator approval key. Trust in RPC remains.

This hackathon core supports native NEAR v2 and USDC/NEP-141 v3, fixed denominations, and 256 total shared-tree outputs. Versions and assets use separate domains; automatic note migration is unsupported. Variable amounts, cross-asset bridges, statutory filing, a production audit, and a distributed trusted setup are outside scope. Network labels are configuration and do not automatically prevent deployment on the underlying mainnet. The development setup is for local/testnet demonstrations.
