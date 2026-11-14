# Core — private business settlement on NEAR

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Core is a development protocol for business-to-business payments and business-to-worker transfers. Independent vaults hold principal; shared zero-knowledge notes authorize a direct payout from one funded vault. Recipients can issue signed invoices, payers review each wallet call, and receipt holders disclose selected evidence.

This repository contains the SDK, local browser prover and proving CLI, read-only API, finalized index and evidence tools. The current browser execution flow supports independently configured testnet FT groups. Native NEAR v2 remains available through the contracts and CLI. English is the default service/documentation language.

[Service overview](docs/SERVICE.md) · [Web Docs](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/) · [Roadmap](docs/ROADMAP.md)

[Organization invoice API](docs/ORGANIZATION_INVOICES.md) stores and retrieves immutable signed invoices per organization, prevents duplicate creation and encrypts sensitive terms with AES-256-GCM. Configure a separate owner-only key ring; the API refuses invoice storage without it. Existing local invoice creation/checkout remains independent.

[Payment management dashboard](docs/PAYMENT_DASHBOARD.md) adds organization invoice search, status/asset/group/date filters, CSV/JSON export and finalized-index payment reconciliation. The SDK distinguishes historical lookup from current-key checkout; unknown, stale and incomplete observations remain explicit.

[Signed payment webhooks](docs/WEBHOOKS.md) add encrypted callbacks/events, a durable finalized-index outbox, stable IDs, HMAC signatures, retries/dead letters, failure history and atomic receiver deduplication. Owners/Admins manage callbacks and redrives in Organization → Webhooks. A pinned local index, approved HTTPS destinations and protected key ring are required.

[Worker/contractor payout batches](docs/PAYOUT_BATCHES.md) group 1–20 independently approved public withdrawal requests, with idempotent/resumable preparation, per-recipient additive fees, a shared encrypted journal, fixed-destination individual recovery and CSV/JSON settlement. Successful/uncertain rows are never replayed as a whole batch.

## Repositories

| Repository | Responsibility |
| --- | --- |
| [Core](https://github.com/Company-privacy-settlement/Core) | Browser/Node SDK, browser/CLI proving, API, SQLite index and evidence verification |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | Rust contracts, Circom circuit, test vectors, WASM and proving artifacts |
| [Front](https://github.com/Company-privacy-settlement/Front) | Next.js landing, English Docs, invoices, notes, settlement, evidence and sample KYB |

Local browser proving now supports FT withdrawal proofs, cancellation, independently pinned WASM/zkey/verifier files and proof-file verification. Export reviewed artifacts with `npm run prover:export`; see [Browser prover](docs/BROWSER_PROVER.md). [Connected invoice checkout](docs/INVOICE_PAYMENTS.md) supports original-group encrypted note selection → local proof → amount/fee review → separate wallet approvals → finalized confirmation, with selected-unit binding, cancellation, fresh merchant/status gates and conservative recovery.

## What is available

| Capability | Current behavior |
| --- | --- |
| Private settlement | Separate native NEAR v2 and token-bound NEP-141 v3 groups; fixed denominations and 256 total note-tree outputs per group |
| Browser notes | Local FT note creation, encrypted file backup, file re-verification and public deposit plans |
| Wallet execution | Explicit registration/storage/payment approvals, encrypted operation journal, final-state checks and conservative recovery |
| Invoices | Recipient NEP-413 signatures, per-unit v2 references, legacy v1 reading and indexed partial/paid/late/overpayment reconciliation |
| Invoice library | Optional merchant/network-separated encrypted storage, search/open and backup/restore/merge |
| Recipient preparation | Separate account activation and token-registration checks; observed storage minimum, no guessed activation funding |
| Evidence | Encrypted full receipts, selected field proofs, local independent-root integrity checks and separate finalized transaction anchoring |
| Public index | Durable SQLite checkpoints, bounded all-shard transaction discovery, verified provenance and paginated activity |
| KYB | Local sample intake in Front and trusted-issuer signature checks in the SDK; configured Sumsub connector available separately; live qualification remains |

## Service flow

1. Obtain a deployment policy independently. Verify its network, registry, token, denomination, treasury and code/verifier hashes against the configured Core API.
2. Create an FT note in Front **Private notes**; download and reopen its encrypted backup before preparing a deposit. The API receives public commitment/root data only.
3. Import the public deposit plan in **Settlements**, connect a testnet wallet and approve each prerequisite/payment separately. A deposit is funded only when its bound record is `Active`.
4. Generate a withdrawal proof in Front **Local proofs** or the CLI using the encrypted note and original policy. For checkout, bind the exact signed invoice recipient and selected per-unit reference.
5. Review/sign the public withdrawal plan in the app. Payout completes when its bound record is `Complete`; a wallet response or timeout is not a finality decision.
6. Keep the appropriate backups and disclose only selected receipt fields. Receipt integrity, transaction anchoring, business identity and tax acceptance are separate claims.

Invoice payment references and arbitrary receipt roots are distinct workflows: an Evidence receipt root cannot replace a signed invoice's expected payment reference.

## Fees

Both deposit and withdrawal charge **0.15% added to principal**, rounded down in the asset's smallest units. The recipient receives full principal.

| Example | Deposit | Withdrawal fee | Recipient receives |
| --- | --- | --- | --- |
| 1 USDC note, six decimals | 1.0015 USDC | 0.0015 USDC | 1 USDC |
| 1 native NEAR note | 1.0215 NEAR including action storage | 0.0215 NEAR including action storage | 1 NEAR |

FT action storage is 0.02 NEAR per applicable action; first-use sender credit adds a 0.005 NEAR ledger bond per target contract. Token registration, account activation and network gas are separate. The payer creating new notes also pays the deposit-side fee. See [operations](docs/OPERATIONS.md) and the [contract FT specification](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md).

## Run Core

Requires Node.js **22.13.0+**. SDK/API/index development does not require Rust or a Contract checkout.

```bash
npm ci
npm run check
npm test
npm run build:client
```

For a real configured group, supply a reviewed policy; templates contain unusable placeholders. The service does not automatically load `.env` files.

```bash
export CORE_POLICY_FILE=/absolute/path/to/trusted-policy.json
export CORE_RPC_URL=https://rpc.testnet.near.org
export CORE_ALLOWED_ORIGINS=http://localhost:3000
npm run serve
```

The default is `127.0.0.1:3001`. `/healthz` is process liveness; `/readyz` checks the deployment and configured index. Start the optional index worker in another terminal using the same policy, RPC and `CORE_INDEX_DB` before attaching the API. See [.env.example](.env.example), [API configuration](docs/OPERATIONS.md) and [index setup](docs/INDEXER.md). Never send notes, wallet keys, passwords or business documents to the API.

## Versioned release packages

`npm run build:sdk` emits Node ESM/declarations and the standalone browser client. `release:prepare` rebuilds from clean pinned Core/Contract/Front commits and bundles contract/proving artifacts, SDKs, group policies and API origins. `release:verify` requires an independently received manifest SHA-256 and checks the bundle offline. Current releases are sandbox/testnet development-only; packaging does not deploy or establish chain readiness. [Commands and release format](docs/RELEASES.md) · [Input template](examples/release.template.json).

## Testnet deployment tools

`deploy:plan` binds a testnet release and public deployment inputs; `deploy:preflight` checks the finalized network/account/key/token/cost snapshot. `deploy:execute` performs one explicit atomic initialization, FT registration or acknowledged key-removal phase with a durable public intent journal. `deploy:reconcile` never resends; `deploy:verify` checks the sealed keyless deployment. Local signing uses a separate owner-only deployer key file, never the API. [Commands and rehearsal](docs/DEPLOYMENT.md) · [Input template](examples/deployment.template.json).

## API and indexer hosting

`build:service` compiles a production runtime; `serve:service` bootstraps and supervises the read-only API and a single persistent SQLite writer. Docker/Compose provides optional Caddy HTTPS, a durable volume and restart policy; a separate Render blueprint is available. Policy digest, exact origins and indexed readiness are required. Online backups and non-overwriting restore are included. [Hosting and recovery](docs/HOSTING.md) · [VPS environment](ops/service.env.example). Actual external deployment requires a hosting target and verified deployed testnet policy.

## Organization access

The separate Organization API provides NEP-413 testnet sign-in, persistent organizations/members, directed invitations, Owner/Admin/Operator/Viewer/Auditor roles, revocation, versioned ownership transfer and audit history. Front's `/organization/` manages these controls; its session stays in memory. These permissions do not grant on-chain signing or verify a business. `npm run serve:organizations` runs the service with independent origin/database/RPC settings. [API, roles and hosting](docs/ORGANIZATIONS.md).

[Organization backup and recovery](docs/ORGANIZATION_BACKUPS.md) captures consistent online snapshots, discards sessions/challenges and restores into quarantine. A separately approved current-access file is required before activation into a new database; historical owners, roles and pending invitations are never automatically restored as authority.

[Corporate payment approval](docs/CORPORATE_PAYMENTS.md) separates the creator from another Owner/Admin approver and freezes the payment, additive 0.15% fee and reviewed prerequisite calls. The supported wallet flow rechecks current membership and approval before reserving each exact call once. This is an organization API/SDK/app policy; the existing contracts retain permissionless fixed-destination proof execution.

## Integrated CI

All three repositories call the same exact-revision pipeline: Core types/units and API/indexer recovery, rebuilt SDK versus Front vendoring, Front types/units/static build and desktop/mobile browsers, contract WASM/units, native/FT Groth16 sandboxes and a verified development release. Private siblings require `INTEGRATION_READ_TOKEN` and reusable-workflow access. [Pins, gates and GitHub setup](docs/CI.md). Local validation is separate from an observed hosted Actions run.

## Local contract and proof validation

Check out Core, Contract and Front as sibling directories. Contract builds require its pinned Rust **1.99.1**, the WASM target and C/C++ build tools. From Core:

```bash
(cd ../Contract && npm ci)
npm run contract:build
npm run zk:setup
(cd ../Contract && npm run build:test-ft)
npm run demo:ft
```

`CORE_CONTRACT_REPO` overrides the default `../Contract`. Core verifies artifact manifest hashes before importing WASM/proving files. The setup is a single-machine development ceremony; replacing it requires matching verifier/artifacts and new deployments. Generated artifacts stay out of Git.

Recorded validation on **2026-11-13**: Core **320 tests**, Front **164 browser cases** plus type/build checks, and the actual FT sandbox report with **14 finalized records**. The sandbox uses a test FT, not Circle-issued USDC or public-network money. Reproduce these recorded checks with the commands above.

## Privacy, custody and recovery

Principal does not traverse A → B → C hops. One group's shared tree hides input-note membership while a selected vault pays directly. Groups retain separate privacy sets. Public recipients, signers, amounts, timing, vault balances, nullifiers and references can still correlate activity; vault count is not a measured anonymity set. The keyless registry coordinates state, and RPC/API observations remain trust dependencies.

Browser notes and full receipts stay in memory and encrypted downloaded files. Journal and optional invoice-library data persist encrypted in separate browser namespaces. Locking/history-cache handling invalidates pending work. An already-open wallet request cannot be cancelled by locking; its durable signing intent stays blocked for explicit reconciliation. The service cannot recover lost note secrets or passphrases.

The US / Abu Dhabi scope is a planned preparation layer, with US state and ADGM/mainland distinctions required. AI tax drafts, full jurisdiction tax coverage, live KYB qualification, statutory filing, fiat conversion and production deployment are not implemented. See [compliance scope](compliance/README.md).

## Guides

[Wallet/recovery](docs/WALLET.md) · [Browser notes](docs/BROWSER_NOTES.md) · [Recipients](docs/RECIPIENTS.md) · [Invoices](docs/INVOICES.md) · [Invoice library](docs/INVOICE_LIBRARY.md) · [Browser receipts](docs/BROWSER_RECEIPTS.md) · [Groups](docs/GROUPS.md) · [Privacy](docs/PRIVACY.md) · [Indexer](docs/INDEXER.md) · [Roadmap](docs/ROADMAP.md)

The hosted development workspace is owner-private; external customer checkout requires suitable access configuration and an independently deployed/funded group. No funded public deployment is bundled. Variable amounts, private group migration, real compliance integrations, independent security review and a reviewed multi-party setup remain outstanding.

Validated on **2026-11-14** for organization invoice storage: **342 Core tests** passed, including 22 new invoice API/encryption/idempotency/recovery cases, plus the compiled service startup/restart and CLI recovery harness.

Payment dashboard validation on **2026-11-14**: **355 Core tests** and **182 desktop/mobile browser cases** passed, including 13 new Core and 18 browser dashboard cases; type checks, Node/browser SDK builds and the static Front build passed. Browser service/wallet fixtures do not establish a live public-network deployment.

Signed webhook validation on **2026-11-14**: **379 Core tests** and **194 desktop/mobile browser cases** passed, including 24 new Core and 12 browser webhook cases. Node/browser SDK, static build and compiled service/recovery checks passed. Tests use local index/wallet/transport fixtures; no real merchant callback or public backend deployment was performed.

Worker/contractor payout validation on **2026-11-14**: **401 Core tests** and **210 desktop/mobile browser cases** passed, including 22 new Core and 16 browser payout cases. Type checks, Node/browser SDK and static Front builds, compiled service restart/backup/recovery and documentation checks passed. Browser wallets, RPC and organization services are local fixtures; these results do not qualify funded public-network payroll or real mobile wallets.

[Sumsub KYB/KYC integration](docs/VERIFICATION.md) is available in Organization → Verification: company/beneficial-owner review, secure supplemental submissions, encrypted minimal snapshots, authenticated invalidation and fixed review-date expiry/revocation. Activation needs an operator-contracted account, configured levels and HTTPS callbacks; development exercised provider fixtures, not real entities. The separate `/kyb/` sample stays unsubmitted.

KYB/KYC connector validation on **2026-11-14**: **428 Core tests** and **224 desktop/mobile browser cases** passed, including 27 new Core and 14 provider-workflow browser cases. Types, Node/browser SDK and static Front builds, compiled service restart/backup/recovery, documentation and SDK synchronization passed. Tests use local provider/RPC/wallet fixtures; no real Sumsub account, entity/person decision, live callback or public backend was qualified.

[US/Abu Dhabi rules](docs/RULES.md) provide seven source-checked component candidates selected by jurisdiction, employee/contractor/B2B relationship and applicable date. The local browser/CLI engine records exact arithmetic and official sources; reviewed use requires an independently pinned Ed25519 reviewer approval. No professional approval, complete tax liability, automatic withholding or filing is bundled.

Rule-engine validation on **2026-11-14**: **459 Core tests** and **240 desktop/mobile browser cases** passed, including 31 new Core and 16 rule-workspace browser cases. Types, Node/browser SDK and static Front builds, compiled CLI export/reverification, service restart/backup/recovery and source/documentation checks passed. Reviewer keys are test fixtures; no professional tax/legal rule approval, taxpayer assessment, automatic withholding or filing was performed.
