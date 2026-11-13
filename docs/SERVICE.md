# Core service overview

Core is a development protocol for private business-to-business payments and business-to-worker transfers on NEAR. The service combines independently held vault balances, shared zero-knowledge notes, recipient-signed invoices and selective payment evidence. English is the default website/documentation language; the three repository READMEs also provide Korean and Simplified Chinese.

This document describes implemented behavior as of **2026-11-13**. It is not a claim of production readiness, live KYB review or tax/legal approval.

## Repository and service map

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Settlement | [Contract](https://github.com/Company-privacy-settlement/Contract) | Native NEAR v2 and immutable-token NEP-141 v3 groups, independent vaults, shared forest/nullifiers, real Groth16 circuit |
| Integration | [Core](../README.md) | Browser/Node SDK, local proving CLI, read-only HTTP API, SQLite index, evidence tools |
| Interface | [Front](https://github.com/Company-privacy-settlement/Front) | Next.js landing, ten English Docs guides and wallet workspaces |
| Future compliance | [Compliance scope](../compliance/README.md) | Real KYB providers, versioned US/Abu Dhabi rules and reviewable AI preparation |

| Front route | Use |
| --- | --- |
| `/docs/` | Setup, architecture, payments, invoices, groups, privacy, KYB, SDK/API and recovery |
| `/live/` | Settlements: trusted-policy/group selection, capacity, reviewed testnet FT calls, journal recovery and indexed public activity |
| `/notes/` | Local FT note generation, encrypted backup/reopen and public deposit-plan preparation |
| `/invoices/` | Merchant-signed requests and optional encrypted local invoice library |
| `/pay/#invoice=…` | Signed checkout, recipient readiness and indexed payment status |
| `/evidence/` | Private receipt creation, backup, selective disclosure and independent-root integrity verification |
| `/kyb/` | Six-page sample intake and clearly marked unsubmitted preparation |
| `/app/` | Legacy links redirect to the corresponding Docs guide |

The [hosted development workspace](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site) is owner-private. That access policy also applies to checkout links. An external merchant/customer demo needs appropriate access plus an independently reviewed, deployed and funded group; none is bundled.

## First settlement

```mermaid
sequenceDiagram
    participant M as Recipient / merchant
    participant P as Payer browser + wallet
    participant C as Local Core CLI
    participant A as Read-only API + finalized index
    participant V as NEAR forest + independent vaults
    M->>M: Sign invoice terms and per-unit references
    M->>P: Share signed JSON or checkout link
    P->>P: Import independent policy, verify merchant and recipient
    P->>P: Create FT note; download and reopen encrypted backup
    P->>A: Prepare public deposit from commitment/root
    P->>V: Review and approve prerequisites / deposit
    V-->>P: Bound deposit becomes Active
    C->>C: Generate proof for original group and exact invoice reference
    C->>P: Public withdrawal plan only
    P->>V: Review and approve withdrawal prerequisites / proof
    V->>M: One funded vault pays full principal directly
    V->>A: Finalized Complete record
    M->>A: Reconcile invoice totals and coverage
```

1. **Establish trust.** Obtain a deployment policy independently of the API. Pin network, registry, token, denomination, fee recipient, verifier and code hashes. Import a policy or caller-approved group directory; review capacity at a finalized block. API policy matching alone does not replace on-chain preflight.
2. **Prepare the recipient.** Read account existence and token registration separately. A missing account requires activation outside this service; token registration alone does not activate it. The app shows the token’s observed storage minimum and an inspectable registration call without signing/funding it. It never guesses activation funding or creates fresh accounts server-side.
3. **Create and fund a note.** `/notes/` creates an FT note locally and requires its downloaded encrypted backup to reopen before deposit preparation. The API receives only public commitment, disclosure root and optional vault. The default search checks at most 20 vault records; an explicit member can be checked beyond that window. A partial scan is not a complete catalog and a plan does not reserve liquidity/capacity. Execute the public plan in Settlements and verify the bound deposit becomes `Active`.
4. **Create a spend proof.** Core CLI opens the saved note using the original policy/group and creates a new Groth16 proof. Notes can be created in-browser, but browser proving is not implemented. An invoice payment must use its exact signed recipient and selected signed-derived per-unit reference.
5. **Approve and observe.** Connect a compatible testnet wallet, unlock an encrypted journal and review each registration, storage, fee and proof call separately. A wallet response, redirect or timeout does not prove settlement. Confirm the bound withdrawal reaches `Complete`; reconcile unresolved signing intents before sending again.
6. **Keep and disclose evidence.** Keep note, journal, invoice and receipt backups separately. Share only selected receipt openings with an appropriate recipient. Check their root against an independently sourced settlement record; integrity alone is not business truth or tax acceptance.

For detailed prerequisites and commands, use [wallet execution](WALLET.md), [browser notes](BROWSER_NOTES.md), [recipient preparation](RECIPIENTS.md), [group selection](GROUPS.md) and [invoices](INVOICES.md).

## Fees

Both deposit and withdrawal add **15 basis points (0.15%)** to principal. Fees are computed per note and rounded down in the asset’s atomic units. The recipient receives the full denomination.

| Asset / denomination | Deposit payment | Separate withdrawal payment | Recipient |
| --- | --- | --- | --- |
| FT example: 1 USDC, six decimals | 1.0015 USDC | 0.0015 USDC | 1 USDC |
| Native NEAR v2: 1 NEAR | 1.0215 NEAR including action storage | 0.0215 NEAR including action storage | 1 NEAR |

FT actions have separate NEAR storage: 0.02 NEAR per applicable action plus a first-use 0.005 NEAR sender credit-ledger bond per target contract. Registration, gas, account activation and the FT transfer’s one-yocto attachment are separate. Native v2 divides its 0.02 NEAR storage between registry (0.015) and vault (0.005); it does not add another protocol fee. Retries/private transfers pay applicable storage without a second protocol fee. A payer funding fresh notes pays both deposit-side and later withdrawal-side fees. Signing invoice terms itself has no transaction fee.

Fee ledgers can pay only earned fees to the fixed treasury. They do not authorize sweeping principal or pending payout liabilities. See [operations](OPERATIONS.md) and [contract FT accounting](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/USDC.md).

## Invoices and payment evidence

A recipient issues NEP-413 signed terms for 1–32 units of a fixed group denomination. New terms v2 assign one fresh signed-derived reference to each unit; legacy v1 remains readable. Checkout verifies signed terms and current merchant FullAccess key ownership, independent group policy, exact recipient/proof reference, readiness, indexed totals and coverage. Wallet control is not legal-entity identity.

Signed terms remain client-held. URL-fragment links expose their terms to link holders. The optional encrypted library stores immutable signed requests per merchant/network, with explicit save, search, open, export, restore and merge. It stores no trusted paid-status cache. The API indexes public settlement references rather than retaining an invoice terms database. There is no merchant server inbox, automatic refund, webhook or fiat conversion.

Expiry, unit caps and reference reuse are app rules, not on-chain reservations. Concurrent payments may overpay. The index reports finalized partial/paid/late/overpayment and incomplete-coverage states rather than inventing a final status. Recovery remains bound to its original destination and may finish after expiry.

A private receipt commits to eight declared fields using fresh per-field salts and SHA-256 Merkle proofs. `/evidence/` encrypts the full receipt, verifies its downloaded backup, and exports only explicitly selected openings. The verifier requires a separately supplied root and makes no chain request. CLI `verify-bundle` can independently anchor selected disclosed roots to finalized transaction records; it does not establish complete business history or field semantics.

**Invoice references and arbitrary receipt roots are distinct.** Checkout requires the signed-derived unit root in the withdrawal’s `disclosureRoot`. Replacing it with a receipt root breaks invoice binding/reconciliation. A generic non-invoice action may use an independently prepared receipt root. Attaching arbitrary receipt evidence to an invoice-bound action needs a separately designed/versioned combined commitment; the current service does not claim this integration. See [browser receipts](BROWSER_RECEIPTS.md) and [privacy](PRIVACY.md).

## Data ownership and recovery

| Data | Location | Recovery requirement |
| --- | --- | --- |
| Private note secrets | Browser memory and downloaded encrypted note file; local CLI file when opened | Note backup + passphrase + original policy/group |
| Full receipt and salts | Browser memory and separate downloaded encrypted receipt file | Receipt backup + passphrase |
| Operation journal | Encrypted browser storage, optional encrypted export | Journal/passphrase; explicit reconciliation for uncertain signatures |
| Optional invoice library | Encrypted browser storage, separate merchant/network namespace | Library/passphrase or exported encrypted backup |
| Signed invoice / selected disclosure | Explicit JSON downloads or shared link | Treat as readable by holders; retain independently |
| Public settlements | Chain plus configured read-only API/index | Independently pinned policy; check finality, provenance and coverage |
| KYB sample draft | Memory inside the KYB layout | Reload/leaving clears it; downloaded preparation is explicitly unsubmitted |

Encryption uses separate authenticated contexts; journal backups are not note backups. Locking, page-hide and history-cache handling clear private views and invalidate pending work. Web Locks protect supported cross-tab writes. Already-started storage writes may finish, and already-open wallet requests cannot be undone. Durable signing intents stay blocked until explicitly reconciled against the original transaction or bound finalized state; no automatic resend occurs. There is no lost-secret/passphrase recovery. Selected disclosures and signed terms are intentionally readable exports, not encrypted backup substitutes.

## Deployment and operation

Use Node.js 22.13+ for Core. Contract/proving builds additionally need the pinned Contract Rust toolchain, WASM target and C/C++ tools. API/index development and Front’s vendored build do not need Rust. See each repository README for commands and [`.env.example`](../.env.example) for configuration; `.env` files are not automatically loaded.

The API defaults to `127.0.0.1:3001`, accepts no private notes, keys, proof-generation requests or broadcasts, and requires an independently configured trusted policy/RPC. A hosted Front requires a reachable HTTPS API with its exact origin allowed in CORS. Run the finalized index worker separately before attaching its database. `/healthz` reports process liveness; `/readyz` verifies deployment/index readiness. Per-process admission limits and RPC budgets are implemented; distributed limits and any future private-data authentication remain deployment work.

The durable SQLite index copies configured registry records and enriches transaction provenance through bounded all-shard scans or supplied public references. Checkpoints, discovery start/progress, unresolved provenance and coverage remain explicit. An index result is not a claim to a complete company history. [API operations](OPERATIONS.md) · [Index deployment](INDEXER.md).

## Versioned release packages

[Release tooling](RELEASES.md) bundles pinned Core/Contract/Front source commits, rebuilt contract WASM and Node/browser SDKs, existing proving artifacts, group policies and API origins. Offline verification requires a separately trusted manifest digest and validates the closed public-file inventory and cross-layer bindings. Packages remain explicitly development-only; preparing/verifying one does not deploy contracts, certify a ceremony or check funded/keyless chain readiness.

## Testnet deployment workflow

[Deployment tools](DEPLOYMENT.md) generate a hash-pinned public plan from a testnet release, perform finalized preflight, execute one explicitly selected deploy/registration/seal phase, reconcile unknown outcomes without resending and verify the sealed keyless registry. A one-shot local signer uses an owner-only file outside the API. Account creation/funding, real public execution, vault liquidity, hosted API/index and wallet qualification remain separate steps.

## Organizations and team access

The [separate Organization API](ORGANIZATIONS.md) adds NEP-413 testnet wallet authentication, durable organizations/members, targeted invitations, five fixed roles, immediate authorization revocation, versioned ownership transfer and per-organization audit history. Front's `/organization/` keeps its session in memory and clears private views on lifecycle/origin changes. Organization roles do not grant settlement signing rights, establish legal identity or issue KYB. Corporate signer mapping, payment approvals, merchant invoice storage and SSO remain separate work. Public backend hosting and real-wallet qualification are still required.

## Integrated CI

[Cross-repository CI](CI.md) selects exact Core/Contract/Front commits, rebuilds and compares the browser SDK, runs types/unit/browser suites and actual native/FT WASM/Groth16 sandboxes, then verifies a development release against the tested sources. Private GitHub access and reusable-workflow sharing must be configured separately; local validation does not establish a successful hosted Actions run.

## API and indexer hosting

[Hosting tooling](HOSTING.md) provides a compiled single-instance service, policy-pinned bootstrap, supervised API/indexer, persistent SQLite volume, optional HTTPS proxy and online backup/restore. Public hosting must still be provisioned against a verified deployed testnet policy; local process tests and provider templates are not a live URL or funded deployment.

## Current boundaries

- **Custody/privacy:** separate keyless vaults, one coordinating forest per group and direct payout from one funded vault. No A → B → C principal route. Global nullifiers prevent note reuse, but recipients, signers, amounts, timing, vault balances and references remain public. More vaults alone do not measure anonymity; RPC observations and immutable code/verifier trust still matter.
- **Capacity:** fixed denominations and 256 total note outputs per group, including private transfers. Withdrawal does not recycle outputs. Groups/assets remain separate domains with no automatic private migration.
- **Browser:** configured testnet FT execution, local notes and receipts are implemented. New Groth16 spend proofs remain in the CLI; native NEAR v2 uses the contract/CLI path.
- **KYB:** Front’s six-page sample intake distinguishes the US, Abu Dhabi mainland and ADGM. File contents are not read/uploaded. Exports state `verified: false`, `credentialIssued: false`, `providerSubmission: not_sent`. SDK checks trusted issuer signatures, subject binding, expiry and supplied revocations; this is not live identity review or circuit-enforced admission.
- **Tax/legal:** B2B, employee and contractor classification, US state/federal jurisdiction, ADGM/mainland status and effective date must be resolved before future rules/drafts. Real tax calculation, payroll withholding, treaty analysis, AI legal drafts and statutory filings are not implemented.
- **Security/release:** no production audit, reviewed multi-party setup, bundled funded public deployment or public-network real-wallet smoke test. Missing payout callbacks remain conservatively reserved; never reset nullifiers or redirect destinations to manufacture recovery.

## Recorded validation and next work

The latest recorded implementation validation on **2026-11-13** passed **249 Core tests**, **112 Front browser cases**, Front type/build checks and an actual FT sandbox integration with **14 finalized records**. The sandbox uses a local TESTUSD fixture, not Circle-issued USDC or public money. It covers real WASM/Groth16, fee/retry behavior, API/index/journal recovery, recipient transitions, browser note/receipt backups and finalized receipt anchoring. Browser test fixtures do not substitute for a funded public-network wallet run.

Reproduction commands and prioritized remaining work are in the [Core README](../README.md), [Front README](https://github.com/Company-privacy-settlement/Front), [Contract README](https://github.com/Company-privacy-settlement/Contract) and [roadmap](ROADMAP.md). Detailed review findings remain dated historical records rather than a claim that every suite was rerun for each documentation edit.
