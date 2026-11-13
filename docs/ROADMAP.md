# Core development roadmap

Current service state as of **2026-11-13**. [Service overview](SERVICE.md) describes the user flow and repository boundaries. [Contract](https://github.com/Company-privacy-settlement/Contract) owns contract/circuit changes; [Front](https://github.com/Company-privacy-settlement/Front) owns the English-first website and wallet workspaces. This roadmap separates implemented capabilities from remaining work.

## Implemented

| Area | Delivered behavior | Guide |
| --- | --- | --- |
| Settlement | Native NEAR v2 and immutable-token FT v3 shared groups; separate keyless principal vaults, global nullifiers, fixed-destination retries and additive 15 bps fees | [Privacy](PRIVACY.md) |
| Operations | Independent deployment-policy checks, same-final-block balances/registrations, exact storage calls, selected-member verification and bounded cancellable observation | [Operations](OPERATIONS.md) |
| Read-only API | Policy-pinned endpoints, exact-origin CORS, peer admission/RPC budgets, deadlines/cancellation and liveness/deployment/index readiness | [Operations](OPERATIONS.md#request-limits-and-readiness) |
| Wallet execution | Browser-safe verified SDK, reviewed testnet FT calls, encrypted journal/backup, cross-tab exclusion, transaction verification and conservative unresolved-signature recovery | [Wallet](WALLET.md) |
| Finalized index | Durable SQLite checkpoints, restart/resume, receipt correlation, bounded all-shard discovery, explicit provenance/coverage and stable paginated activity | [Indexer](INDEXER.md) |
| Invoices | Merchant NEP-413 signature/current FullAccess check, per-unit v2 references, v1 reading, exact checkout binding and indexed partial/paid/late/overpayment | [Invoices](INVOICES.md) |
| Invoice library | Optional encrypted merchant/network storage, explicit save/search/open, backup/restore and immutable-request merge; no paid-status cache | [Library](INVOICE_LIBRARY.md) |
| Groups | Caller-approved directory, capacity discovery and ordered selection, browser rechecks, full/retired original-group recovery and namespace-bound journals | [Groups](GROUPS.md) |
| Recipients | Distinct account activation/token registration, observed minimum storage cost, inspectable registration calls and stale-response invalidation | [Recipients](RECIPIENTS.md) |
| Connected invoice payments | Original-group encrypted note → local proof → selected-unit fee review → separate approvals → finalized confirmation, bounded public polling and conservative recovery | [Invoice payments](INVOICE_PAYMENTS.md) |
| Browser proving | Local FT withdrawal Groth16 proofs in a disposable worker, independently pinned files, reconstructed original-group tree, cancellation and proof-file verification | [Browser prover](BROWSER_PROVER.md) |
| Browser notes | Local FT note creation, encrypted file backup/reopen, CLI interoperability and bounded public deposit plans | [Notes](BROWSER_NOTES.md) |
| Browser evidence | Private receipts, separate encrypted backup/reopen, explicit selected-field exports, independent-root integrity checks, root-only deposit preparation and CLI evidence compatibility | [Receipts](BROWSER_RECEIPTS.md) |
| Lifecycle protection | Page-hide/history-cache locks; generation-bound private work, journal reads/writes and last-moment wallet dispatch guards | [Wallet](WALLET.md), [Notes](BROWSER_NOTES.md) |
| Product shell | Landing, ten English Docs guides and separate sample KYB steps; English/Korean/Chinese repository READMEs | [Service](SERVICE.md) |
| Organization recovery | Consistent online SQLite snapshots, pinned non-overwriting quarantine, discarded sessions/challenges, explicit current-access approval and one-use activation into a new database | [Organization backups](ORGANIZATION_BACKUPS.md) |
| Organization access | Separate wallet-authenticated API, durable organizations/members, directed invitations, fixed roles, revocation, ownership transfer and organization-scoped audit log; reviewed backup/recovery; no payment signing or corporate identity grant | [Organizations](ORGANIZATIONS.md) |

## Recorded validation

The latest recorded full implementation runs on **2026-11-13** include:

- Core: `npm run check`, **303 tests** via `npm test`, browser-client build.
- Front: type/build checks, **148 browser cases** verified (146 in the full run plus two corrected selected-unit regressions on a focused rerun), and three sample-KYB unit cases.
- `npm run demo:ft`: actual sandbox WASM and Groth16, **14 finalized records** covering fee/recovery paths, recipient activation/registration, API/index/journal restart and transaction discovery, browser note backup/deposit preparation, receipt backup/disclosure and finalized evidence anchoring.

The FT is a local **TESTUSD fixture, not Circle-issued USDC**. No funded public-network wallet smoke test has been completed. These are dated results; documentation edits do not imply fresh execution of every suite. Reproduction: [Core README](../README.md), [Front README](https://github.com/Company-privacy-settlement/Front), [Contract README](https://github.com/Company-privacy-settlement/Contract).

Historical reviews: [invoice/index](REVIEW-2026-11-12.md), [selection/checkout](REVIEW-2026-11-13.md), [notes/library](REVIEW-2026-11-13-NOTES.md), [journal lifecycle](REVIEW-2026-11-13-JOURNAL.md).

## Remaining development — priority and status

The backlog below contains **36 work packages: R01/R02/U01/U02 tooling implemented, 32 open** across six areas. They are planning items, not 36 discovered vulnerabilities or equally urgent release blockers. Completed capabilities above must be reused rather than rebuilt. Ownership names refer to repositories/workstreams, not assigned people. Effort and dates remain unestimated until deployment access, provider choices and product requirements are known.

- **P0 — public testnet demo:** required to demonstrate the existing protocol with a real funded deployment and wallets. External accounts/funding and hosting-audience decisions are dependencies, not authorization to spend funds, remove keys or change access.
- **P1 — usable merchant flow:** removes CLI friction and adds merchant operations. These are service additions, not claims of production safety.
- **P2 — enterprise service:** business controls, batch worker payments, real verification and reviewable tax preparation.
- **Design — optional protocol scope:** requires an explicit requirement and version/compatibility analysis. Do not bundle these research changes into a release of the current fixed-denomination protocol.
- **Gate — before production funds:** independent security, setup and operational/product qualification. Gate work starts in parallel; it cannot wait until after a production launch.

All entries below except **R01/R02/U01/U02 tooling** are **open** unless explicitly labeled an existing foundation. External dependency does not mean development is blocked: prepare dry-runs, reviewable manifests, runbooks, adapters and fixtures first.

## P0 — public testnet release (6)

| ID | Work package / owner | Completion evidence | Dependencies |
| --- | --- | --- | --- |
| R01 | **Implemented:** versioned release tooling — Core, consuming Contract/Front | [Prepare/verify commands](RELEASES.md), clean pinned sources, rebuilt WASM/Node/browser SDKs, circuit/key linkage, policy/raw-verifier binding, closed inventory and normalized archive. Independently trusted manifest hash is mandatory for offline verification. | Development setup only; actual deployment/distribution/readiness remain R02–R06 |
| R02 | **Implemented:** testnet deployment tooling — Core, consuming Contract artifacts | [Hash-pinned plan, preflight, explicit execution, journal reconciliation and sealed verification](DEPLOYMENT.md); atomic initialization, separate FT registrations and acknowledged key removal. Local WASM rehearsal remains distinct from public deployment. | R01; actual funded public execution and real wallets remain R03/R04 |
| R03 | Funded testnet wallet qualification — all three | With the independently pinned testnet token, complete actual-wallet deposit, cross-vault payout, recipient registration, uncertain-result reconciliation and allowed retries; record exact fees, final records, balances and original-group recovery. Clearly distinguish local TESTUSD tests from token/public-network tests. | R02, activated accounts, gas/storage/token balances, compatible wallets |
| R04 | **Hosting tooling delivered; live deployment open** — Core / operations | [Compiled supervisor, Docker/Compose HTTPS, optional Render blueprint, policy pin, single-writer volume, readiness and online backup/restore](HOSTING.md). Local process/restart/restore tests do not establish a reachable deployed HTTPS endpoint. | Actual host/access, deployed policy, DNS/TLS and live readyz still required |
| R05 | **CI tooling delivered; hosted qualification open** — all three | [Exact-revision shared pipeline](CI.md): Front types/units/build/browser, rebuilt SDK versus vendoring/source inventory, Core/service checks, actual native/FT WASM/Groth16 and exact-source development-release verification. Stage/source/artifact evidence is allowlisted. | Private-repository read secret and reusable-workflow access; observe a successful hosted Actions run before release qualification |
| R06 | Demo access and complete user journey — Front / operations | Check landing → Docs → trusted group → deposit → invoice checkout → finalized status → selected evidence on the intended audience/device. Verify checkout-link access separately. Preserve owner-private access until a different audience is explicitly selected. | R03/R04; audience decision for external viewers |

## P1 — wallet usability (6)

| ID | Work package / owner | Completion evidence | Dependencies |
| --- | --- | --- | --- |
| U01 | **Implemented:** local browser Groth16 prover — Core + Front | [Worker-based FT withdrawal proofs](BROWSER_PROVER.md), independent artifact hashes and verifier binding, reconstructed tree, CLI public-input/encoding parity, cancellation and proof-file verification. Actual Chromium proofs pass independent Node verification; timings and aggregate RSS are recorded for desktop/mobile emulation. | Physical-device/browser qualification remains U05; connected invoice flow delivered in U02 |
| U02 | **Implemented:** connected note-to-invoice payment flow — Core + Front | [Note → proof → amount/fee review → explicit approvals → finalized confirmation](INVOICE_PAYMENTS.md), derived selected-unit action, current-key/status gates, duplicate intent checks, cancellation/cache locks and read-only recovery. Actual browser proofs pass independent Node verification. | Funded public-wallet and physical-device qualification remain R03/U05; on-chain invoice caps remain X04 |
| U03 | Guided account activation and funding — Front + Core | Explain missing account, token registration, gas and storage separately; hand off to a compatible wallet and recheck finalized readiness. Any sponsorship is explicit and quoted; never guess activation amounts. Existing readiness checks remain read-only. | Actual wallet/token capability qualification |
| U04 | Backup, archive and storage lifecycle — Core + Front | Exercise restore after device/browser-data loss and supported format upgrades; show bounded-store capacity and permit safe archive/export of reconciled history. Keep unresolved intents; never erase a spendable note or signing intent to free space. | Current separate encrypted note/receipt/journal/library formats |
| U05 | Real browser and wallet matrix — Front + Core | Test supported desktop/mobile wallets, NEP-413 signing, navigation interruption, cache return, storage quota and Web Locks behavior. Existing mobile tests emulate Chromium; they do not qualify Safari, Firefox or real mobile wallets. Unsupported features fail clearly and safely. | R03; supported-device/wallet list |
| U06 | Recovery and accessibility polish — Front + Core | Consistent actionable error states, progress/cancellation, keyboard/screen-reader coverage and explicit unresolved-signature recovery. Preserve last-moment signing guards and original destination bindings. | Existing operation state machine and lifecycle locks |

## P1 — merchant payments (6)

These are optional service-layer additions for a persistent merchant gateway. They do not grant the server authority over settlement principal.

| ID | Work package / owner | Completion evidence | Dependencies |
| --- | --- | --- | --- |
| M01 | Authenticated merchant API — Core / new service boundary | Tenant-owned immutable invoice IDs/terms, encrypted private data, authenticated idempotent creation and audit trail; isolation tests reject cross-merchant access. Preserve the current public read-only settlement API as a separate boundary. | Auth/tenant/key-management decisions |
| M02 | Persistent merchant dashboard — Front + merchant service | Search/filter invoices and exports from authorized merchant storage; derive payments from verified final events with pagination/coverage, not redirects or a trusted client paid-status cache. Keep optional local-library interoperability. | M01 and existing index/invoice status |
| M03 | Signed payment webhooks — merchant service | Durable idempotent outbox, signed event IDs/timestamps, replay protection, retries/dead-letter handling and merchant-side deduplication. Validate allowed callback destinations and network access before dispatch. | M01; verified final events and endpoint policy |
| M04 | Invoice and business-evidence composition — Core + Front; Contract if needed | Version a commitment/verification model that binds invoice unit, payment and selected business evidence; specify what is on-chain versus off-chain, tamper cases and v1/v2 compatibility. Decide whether the existing opaque reference suffices before changing ABI/circuit. | Signed-reference design and evidence/privacy requirements |
| M05 | Overpayment, expiry and refund workflow — Core + Front | Explicit policies for concurrent/late/reused-reference payments, human review and merchant-authorized refund transactions with independent records and reconciliation. Do not erase the original payment or pretend current app checks reserve a unit. | Merchant decisions; X04 only if on-chain enforcement is required |
| M06 | Financial reconciliation and historical attestations — Core + Front | Reconcile principal, both add-on fees, storage/gas, earned treasury fees and liabilities without labeling them all tax expenses. Export bounded source-anchored records; define historical merchant-key/issuer attestation behavior after key rotation. | Indexed provenance, accounting requirements and attestation model |

## P2 — enterprise and compliance preparation (6)

| ID | Work package / owner | Completion evidence | Dependencies |
| --- | --- | --- | --- |
| E01 | **Access foundation delivered; payment approvals open** — organization service + Front | [Persistent organizations, members, invitations, fixed roles, wallet authentication, authorization revocation, ownership transfer and audit history](ORGANIZATIONS.md), plus [quarantined backup/recovery with explicit current-access review](ORGANIZATION_BACKUPS.md). Maker-checker payment approvals and verified signer-to-business/corporate-wallet mapping remain unimplemented; organization creation does not establish legal identity. | Auth foundation is separate from M01 merchant invoice storage; real business/signing qualification remains required |
| E02 | Batch worker/contractor payments — Core + Front | Validate recipient lists and classifications, isolate failures, show each note/fee/approval and reconcile per-recipient results. Specify scheduled execution authority separately; a saved schedule must not silently gain wallet signing power. | E01; U02; explicit batch/scheduling product scope |
| E03 | Real KYB/KYC provider and credentials — Core + enterprise service | Entity/beneficial-owner cases, documents/follow-ups, authenticated callbacks, issuer trust, expiry/current revocation and explicit decisions. Version signed claims for any finer jurisdiction/scope than current US/AE credentials. Decide off-chain eligibility versus X05 circuit admission. | Provider/account selection, data controls and business review |
| E04 | Encrypted business-document packages — enterprise service + Front | Authenticated upload/access, encryption/key rotation, integrity commitments, authorized selective export and tested retention/deletion. Never place raw identity, beneficial-owner, salary or tax files on-chain. | E01; storage/key-management/retention decisions |
| E05 | Versioned US / Abu Dhabi rule engine — Core / compliance preparation | Resolve US state/federal scope, ADGM/mainland status, B2B/employee/contractor classification and effective date. Store cited official rule versions, deterministic calculations, source/input provenance and reviewed fixtures. No invented rates. | Jurisdiction/product facts and qualified rule review |
| E06 | Reviewable AI preparation and evidence review — enterprise service + Front | Generate cited drafts from reviewed E05 outputs and authorized documents; expose unknowns and require review. Separate receipt integrity, final payment, declaration truth, identity and legal/tax conclusions. Filing/payment connectors are a distinct later integration, never implied by draft generation. | E03/E04/E05; model/data-access and review policy |

Tax calculation, payroll withholding, treaty analysis, AI legal drafts, real provider calls, statutory filing and fiat conversion remain unimplemented. These entries describe development preparation, not current legal obligations or approved tax rates. See [compliance scope](../compliance/README.md).

## Design — optional protocol expansion (6)

| ID | Work package / owner | Completion evidence and compatibility decision | Dependency / tradeoff |
| --- | --- | --- | --- |
| X01 | Larger shared-group capacity — Contract + Core | Specify tree/state/storage/gas limits beyond 256 total outputs; regenerate and review circuits, vectors, artifacts and policies where required; provide original-group recovery compatibility. | New version/setup analysis; throughput/privacy measurements |
| X02 | Variable amounts and multi-note payments — Contract + Core | Define value conservation, range checks, change notes, decimals/fee rounding and proof binding; test invalid balances and cross-asset substitution. No claim that arbitrary amounts follow from the present fixed-denomination circuit. | Separate protocol design and security review |
| X03 | Private cross-group migration — Contract + Core | Define independent domains, cross-group spend/nullifier coordination and failure recovery; review what the migration publicly links. No automatic claim of a merged anonymity set or A → B → C fund routing. | Separate privacy/settlement design, not group selection UX |
| X04 | Contract-enforced invoice semantics — Contract + Core | Decide whether expiry/caps/cancellation/reservations are required; specify concurrent payments, recoveries after expiry, griefing and metadata leakage before changing contracts. Keep legacy invoice behavior explicit. | Product decision; M05; separately versioned terms/protocol as required |
| X05 | Proof-enforced eligibility — Contract + Core | If required, specify private credential possession, issuer trust, expiry/revocation freshness and admission semantics inside a separately versioned proof/policy. Explain who controls issuer updates. UI checks alone cannot enforce permissionless contract admission. | E03 and admission/privacy requirements |
| X06 | Native NEAR browser path and fresh recipients — Core + Front | Add separately reviewed native plans if needed; expose existing client-side fresh-key generation through a tested encrypted-backup/activation flow without server-held keys. Qualify FT account activation/registration independently. | Asset scope, wallet compatibility and U03/U05; legacy native SDK is a foundation |

## Gate — before production funds (6)

| ID | Work package / owner | Required evidence |
| --- | --- | --- |
| S01 | Independent security review — Contract + Core + Front | Review circuit constraints, verifier/context binding, balances/nullifiers, cross-contract state transitions, SDK/wallet boundaries and private-data handling; resolve findings and retest. Existing targeted code reviews are not a full audit. |
| S02 | Reviewed multi-party setup and release provenance — Contract + Core | Reviewed ceremony/transcript, verified proving/verifier artifacts and matching deployment policies; document artifact distribution, contributors and compatibility. Current single-machine artifacts explicitly say UNSAFE_LOCAL_DEVELOPMENT_ONLY. |
| S03 | Economic, storage and asynchronous-state qualification — Contract + Core | Property/fuzz/adversarial sequences for principal/fee/liability conservation, callback failure/staleness, retry idempotence, worst-case gas/storage and external-token rejection. Document permanently reserved payout states; never reset nullifiers or redirect payouts to invent recovery. |
| S04 | Operational resilience and scaling — Core / operations | Restore drills with defined recovery objectives, monitoring of lag/coverage/reservations/capacity, RPC failover, indexed-provider backfills, distributed admission limits and incident procedures. Test writer concurrency/upgrade compatibility before multi-instance deployment. No secrets/business fields in telemetry. |
| S05 | Frontend and software-supply-chain protection — all three | Inventory/pin release dependencies and wallet integrations, verify artifacts/signatures, review hosting security headers/CSP and browser asset trust, and run secret scanning. Hash checks alone do not protect a browser served malicious code; qualify the deployment chain as a whole. |
| S06 | Production business and asset qualification — all three / product review | Explicit asset/network and jurisdiction scope, token external-control/failure review, qualified review of the service’s proposed operating model, user-support/escalation procedures and staged release criteria. Browser network selection is currently testnet-only; any mainnet path requires separate configuration and complete qualification. |

## Risk register

Severity describes potential impact for the relevant deployment stage, not a newly reproduced exploit. “Known limit” is current documented behavior; “qualification gap” means required evidence is missing; “future-service risk” applies only if that planned feature is added. Fixes already covered by historical reviews are not reopened without a regression.

| Risk | Type / impact | Current mitigation and residual exposure | Tracking |
| --- | --- | --- | --- |
| Incorrect proof/setup or settlement logic | Qualification gap / critical before production | Real Groth16/vectors and tests exist; independent audit and reviewed multi-party setup do not. Current setup is explicitly development-only. | S01/S02/S03 |
| Permanently unresolved payout callback | Known limit / potential fund lock | Fixed destinations, idempotence and retries avoid duplicate payouts; a vault payout that remains Pending cannot safely be reset by the SDK. Reserved balances may remain locked. | S03/S04; X changes only after a reviewed recovery design |
| Wrong or compromised deployment/policy distribution | Qualification gap / funds at risk | SDK/API pin and check policies/hashes; trustworthy versioned distribution and public release qualification remain incomplete. | R01/R02/S05 |
| Note loss, passphrase loss or compromised browser | Known limit / spend-secret loss or theft | Separate encrypted backups and lifecycle locks exist. There is no lost-secret recovery or physical memory-erasure guarantee; malicious served code is outside file encryption alone. | U04/U05/S05 |
| Public metadata correlation and small groups | Known limit / privacy exposure | Proof hides input membership, not public recipients/signers/timing/amounts. More vaults are not a measured anonymity set; repeated references and disclosures can link activity. | S01; privacy review for X01/X03/X04 |
| Group exhaustion or fragmented payout liquidity | Known limit / unavailable new deposits or payout selection | 256 total outputs, fixed denominations and per-vault liquidity; existing capacity discovery/recovery helps but does not recycle outputs or guarantee a funded vault. | R03/S04; X01/X02/X03 if approved |
| Late/concurrent invoice overpayment | Known limit / merchant reconciliation burden | Index tracks late/overpaid/reused references; expiry/caps are app rules, not reservations. Recovery can complete after expiry. | M05/M06; X04 if required |
| Invoice/evidence root substitution | Known integration boundary / invalid checkout or misleading evidence | Exact invoice reference checks already reject substitution; current receipts and invoice unit roots are distinct workflows. | M04; preserve existing checks |
| Stale/incomplete index or RPC outage | Known dependency / delayed or incomplete status | Finalized checkpoints, explicit provenance/coverage, budgets and readiness exist. Scaling, multi-provider operations and restore drills remain unqualified. | R04/S04 |
| Unqualified public wallets/devices | Qualification gap / compatibility remains unproven | Browser notes, standalone proofs and connected invoice payments work with local proving. Testnet wallet adapter and Chromium-emulated mobile tests do not establish broad device support. | U01/U02/U05/R03 |
| Hosted audience or missing deployment funds | Demo dependency / checkout unavailable to recipients | Hosted site remains owner-private; no funded public group is bundled. Site access and deployment funding are separate dependencies. | R02/R03/R06 |
| Bounded browser stores and cross-device recovery | Known limit / inability to add history or recover local state | Journal/library are bounded and encrypted; exports exist, but operational archiving/device-loss drills and compatibility UX remain work. | U04/U05 |
| Real KYB/tax claims without provider/rule evidence | Service gap / incorrect identity or business conclusions | UI exports are explicitly unverified/unsubmitted; SDK issuer checks and receipt integrity do not establish real identity or tax acceptance. | E03/E05/E06/S06 |
| External token behavior and operating dependencies | Qualification gap / rejected transfers or unavailable assets | FT calls bind one immutable token per group; token behavior, failures and external controls still require asset-specific testing and review. | R03/S03/S06 |
| Merchant tenant leakage or unsafe callbacks | Service foundation / future merchant-data exposure | Organization API now enforces tenant/role isolation, signature sessions and revocation. Organization names/membership metadata need protected storage; no private merchant terms or webhooks exist yet. Merchant encryption, callback validation and operational qualification remain separate. | M01/M03/E01/E04/S05 |

## Suggested execution order

1. **R01/R02 tooling delivered → R04/R03:** review the [release bundle](RELEASES.md) and [deployment plan](DEPLOYMENT.md); provision the API/index and deliberately execute funded testnet steps when credentials/funding are available.
2. **R05 tooling delivered:** configure private-repository checkout and reusable-workflow access, then observe the [exact three-repository integration](CI.md) in Actions. Local checks do not substitute for a hosted run.
3. **R04 → R03 → R06:** stand up a verified testnet API/index, qualify actual funded-wallet settlement, then test the complete demo for its intended audience. Funding/access choices remain explicit dependencies.
4. **U01/U02 delivered → U03–U06:** qualify user recovery, backup lifecycle and real devices/wallets before promising broadly supported checkout.
5. **M01 → M02/M03**, then M04–M06: add persistent merchant operations without giving a service custody of principal.
6. **E01 → E02/E03/E04 → E05 → E06:** add enterprise controls and real reviewed preparation. Use fixtures until provider/data access is deliberately configured.
7. **S01–S06 start alongside the relevant stages and must close before production funds.** X01–X06 are optional, separately scoped/versioned work; none is a reason to silently change existing notes, groups or destinations.

This backlog is not a new audit or a claim that unimplemented optional features are present. Historical validation numbers above remain recorded results; listing development work does not rerun the 303 Core tests, 148 browser cases or sandbox suite. Detailed limits remain in [SERVICE.md](SERVICE.md), [PRIVACY.md](PRIVACY.md), [INVOICES.md](INVOICES.md) and [WALLET.md](WALLET.md).

Organization access review and fixes: [2026-11-13 findings and validation](REVIEW-2026-11-13-ORGANIZATIONS.md).

Organization backup/recovery validation on 2026-11-13: Core types and all 303 tests passed, including 14 recovery regressions; the compiled CLI/service harness exercised quarantine and reviewed activation. This addition does not complete E01 payment approvals or operational off-host/retention qualification.
