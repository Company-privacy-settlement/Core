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
| Browser notes | Local FT note creation, encrypted file backup/reopen, CLI interoperability and bounded public deposit plans | [Notes](BROWSER_NOTES.md) |
| Browser evidence | Private receipts, separate encrypted backup/reopen, explicit selected-field exports, independent-root integrity checks, root-only deposit preparation and CLI evidence compatibility | [Receipts](BROWSER_RECEIPTS.md) |
| Lifecycle protection | Page-hide/history-cache locks; generation-bound private work, journal reads/writes and last-moment wallet dispatch guards | [Wallet](WALLET.md), [Notes](BROWSER_NOTES.md) |
| Product shell | Landing, nine English Docs guides and separate sample KYB steps; English/Korean/Chinese repository READMEs | [Service](SERVICE.md) |

## Recorded validation

The latest recorded full implementation runs on **2026-11-13** include:

- Core: `npm run check`, **192 tests** via `npm test`, browser-client build.
- Front: type/build checks, **98 browser cases**, and sample-KYB unit coverage.
- `npm run demo:ft`: actual sandbox WASM and Groth16, **14 finalized records** covering fee/recovery paths, recipient activation/registration, API/index/journal restart and transaction discovery, browser note backup/deposit preparation, receipt backup/disclosure and finalized evidence anchoring.

The FT is a local **TESTUSD fixture, not Circle-issued USDC**. No funded public-network wallet smoke test has been completed. These are dated results; documentation edits do not imply fresh execution of every suite. Reproduction: [Core README](../README.md), [Front README](https://github.com/Company-privacy-settlement/Front), [Contract README](https://github.com/Company-privacy-settlement/Contract).

Historical reviews: [invoice/index](REVIEW-2026-11-12.md), [selection/checkout](REVIEW-2026-11-13.md), [notes/library](REVIEW-2026-11-13-NOTES.md), [journal lifecycle](REVIEW-2026-11-13-JOURNAL.md).

## Next — verifiable public testnet release

| Priority | Deliverable / acceptance condition | Dependency |
| --- | --- | --- |
| P0 | Reproducible versioned artifact/policy release: reviewed WASM/verifier hashes, independently distributed policies and exact API origins | Reviewed setup and release owner |
| P0 | Public testnet deployment: funded deployer, explicit reviewed key-removal phase, token registration, verified keyless state and complete real-wallet deposit/withdrawal/recovery smoke test | Funded accounts, reviewed artifacts and wallet access |
| P0 | Demo access appropriate for intended recipients; hosted checkout availability tested separately from local wallet execution | Hosting audience decision and deployed group |
| P1 | Browser Groth16 spend proving with committed-vector parity, mobile memory/time measurements and cancellation/recovery tests | Prover packaging and browser measurements |
| P1 | Operational scaling: indexed-provider adapters, backfill cost/throughput controls, distributed limits and redacted alerting/telemetry | Archival/indexed provider and hosting model |
| P1 | OpenAPI/client generation; authenticate any future private business API while preserving the current public read-only boundary | Defined API compatibility and private-data model |

Capacity selection and recovery routing are implemented. Adding groups still requires independently reviewed deployments; it does not implement private migration or merge their anonymity sets. Account/FT readiness is implemented; activation funding and account creation remain external.

## Next — merchant and enterprise service

| Area | Required result |
| --- | --- |
| Merchant service | Authenticated merchant-owned invoice IDs, encrypted immutable terms, audit history, independently verified final events and an idempotent signed-webhook outbox with bounded retries |
| Invoice/evidence composition | Explicitly versioned combined commitment and verification model; an arbitrary receipt root must not replace the currently signed invoice unit root |
| Payment semantics | Separately designed cancellation/reservation/cap enforcement and merchant-controlled refunds; current app-only expiry/caps do not reserve on-chain capacity |
| KYB/KYC provider | Real entity/beneficial-owner review, trusted issuer configuration, current expiry/revocation and callbacks; signature checks alone do not establish identity |
| US / Abu Dhabi preparation | Resolve US state/federal scope, ADGM versus mainland, employment/contractor/B2B classification and effective date; version cited official rules, compute deterministically and prepare reviewable AI drafts |
| Business documents | Encrypted access-controlled attachments, integrity commitments, selective export and retention/deletion policy; no raw identity/salary/tax forms on-chain |
| Evidence review | Separate integrity, selected finalized transaction inclusion, declared-field truth, identity and legal/tax conclusions |

Real KYB, AI tax/legal preparation, payroll withholding, treaty analysis, statutory filing and fiat conversion remain unimplemented. See [compliance scope](../compliance/README.md). Circuit-enforced admission requires separately versioned Contract work.

## Production gates and protocol limits

Independent contract/circuit/SDK audit, reviewed multi-party setup, issuer-control risk review, incident procedures and operational recovery validation remain required before production. The group has fixed denominations and 256 total outputs; variable amounts, automatic private group migration and cross-asset bridges are not implemented.

Permanently missing payout callbacks remain conservatively reserved. SDK/API tooling must not reset a nullifier or redirect a destination to manufacture recovery. Public metadata and API/RPC observations remain privacy/trust dependencies. [Privacy model](PRIVACY.md).
