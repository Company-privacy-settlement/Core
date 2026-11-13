# Core development backlog

This backlog is based on the current code. Contract and circuit work stays in the separate Contract repository. English is the default documentation language.

## P0 — usable settlement operations (this iteration)

- [x] Validate immutable deployment policies before reads; preserve structured RPC failures rather than treating provider errors as missing accounts.
- [x] Read FT balances, metadata, NEP-145 registrations, and sender NEAR storage credit at one finalized block.
- [x] Prepare ordered registration and exact storage-credit top-up calls; keep token amounts, NEAR attachments, gas, and account activation distinct.
- [x] Verify a selected vault directly even when it is beyond the default catalog page.
- [x] Observe deposit and withdrawal state from verified contracts, with optional original-owner/destination/receipt bindings.
- [x] Return bound retry/refund calls only when contract state permits them. A timeout does not establish failed payment; no automatic re-broadcast occurs.
- [x] Add bounded, cancellable SDK polling and CLI commands for preflight, status and waiting.
- [x] Add a runnable read-only HTTP API for frontend integration, configured with one trusted policy/RPC and exact CORS origins. No keys, private notes, proof generation or broadcast endpoint.
- [x] Exercise the operations SDK and API against actual sandbox WASM and Groth16 settlement; regression tests pass.

Validation: `npm run check` and **140 tests** via `npm test` pass. The `npm run demo:ft` sandbox report includes 14 finalized settlement records and checks preflight, HTTP API, finalized observation, wallet-session recovery, encrypted journaling, exact transaction verification, durable index restart, automatic all-shard transaction discovery, receipt correlation and activity pagination.

Implementation: `sdk/operations.ts`, `server/api.ts`, `scripts/server.ts`, and `scripts/cli.ts`. Usage and limitations: [OPERATIONS.md](OPERATIONS.md).

## P1 — connect a real product flow

- [x] Browser-safe FT execution bundle with declarations and SHA-256 manifest; independent Front build verifies its vendored copy.
- [x] Wallet port and NEAR Connect testnet frontend; explicit single-call review, trusted policy, fees, payer/network binding and finalized observation.
- [x] Encrypted local operation journal, cross-tab exclusion, backup/restore and unresolved signature reconciliation. No automatic resubmission after reconnect.
- [x] Exact finalized wallet transaction verification and sandbox coverage of storage, deposit and withdrawal recovery.
- [x] Durable registry-journal index with SQLite transactions/checkpoints, finalized-block conflict checks, restart/resume and bounded record replay.
- [x] Persistent public TX-reference queue, exact finalized receipt correlation, and read-only activity/status APIs with stable filtered pagination.

- [x] Bounded automatic all-shard TX discovery with complete receipt-graph checks, atomic cursor/candidate persistence and canonical gap validation.
- [x] Front public group activity with validated index responses, checkpoint age, unresolved provenance, discovery coverage and stable filters/pages.

- [x] Recipient-signed FT invoices, merchant full-access key checks, private checkout plan binding and indexed partial/paid/late/overpayment reconciliation.
- [x] Invoice terms v2 with distinct per-unit signed references, indexed reuse checks, honest race accounting and legacy v1 compatibility. [Privacy model and public metadata limits](PRIVACY.md).
- [x] Indexed invoice reference-set lookup with stable cursors, bounded matching-record reads, legacy adapter fallback, late-total consistency and checkout invalidation regressions. [Review findings and resolution](REVIEW-2026-11-12.md).
- [x] Complete paginated CLI vault selection at one final block, direct selected-member verification and invoice fragment/history lifecycle fixes. [Review findings and resolution](REVIEW-2026-11-13.md).
- [x] Process-local bounded peer rate limits, weighted route admission, RPC read budgets, request deadlines and transport cancellation; retained slots for non-cancellable work and separate deployment/index readiness checks. [Settings and operational limits](OPERATIONS.md#request-limits-and-readiness).

Invoice scope and next service layer: [INVOICES.md](INVOICES.md). Business terms stay client-held; merchant API persistence, signed webhooks, fiat conversion and contract-enforced invoice caps/deadlines remain future work.

Integration: [WALLET.md](WALLET.md). Private note creation/proving remains in the CLI. A publicly deployed/funded testnet wallet smoke test is still outstanding.

Index scope and deployment: [INDEXER.md](INDEXER.md). All configured registry records are copied; transaction provenance is enriched from bounded all-shard scans or supplied public references. Discovery start/progress and unresolved links remain explicit, with no complete business-history claim.

| Task | Deliverable / acceptance condition | Dependency |
| --- | --- | --- |
| Browser note/prover expansion | Generate encrypted notes and new Groth16 proofs locally in the browser, with mobile memory/performance measurements and the same committed vectors. Current bundle executes prepared CLI plans. | Prover packaging and browser measurements |
| Discovery scaling | Add indexed-provider adapters, throughput/cost controls and operational alerting for large public-network backfills. Current RPC scanner enumerates all shards/transactions with persistent offsets and explicit coverage. | Archival/indexed data provider |
| Remaining API deployment hardening | Authentication for any future private business data, distributed/edge limits, OpenAPI/client generation and redacted operational telemetry. Process-local budgets, deadlines/cancellation and readiness probes are implemented. | Hosting/access model; current API defaults to loopback |
| Testnet deployment workflow | Reproducible artifact/policy release, verified token registration, explicit key-removal phase and a real-wallet smoke test. | Funded deployer account and reviewed setup hashes |
| Group capacity management | Discover and display full groups, route new deposits to separately approved groups, preserve withdrawal access to old groups. No implied private cross-group migration. | New group deployment/policy distribution |

## P2 — enterprise and compliance integrations

- [ ] Real KYB/KYC provider: entity and beneficial-owner review, trusted issuer configuration, credential expiry/revocation freshness, and provider callbacks. Existing signature checks alone do not establish identity. A circuit-enforced admission policy requires separately versioned Contract work.
- [ ] US / Abu Dhabi preparation: determine the US state, ADGM versus mainland, payment classification and effective date; version cited official rules, calculate deterministically, and prepare reviewable AI drafts. Do not invent tax rates or claim filing/approval.
- [ ] Encrypted business-document packages: access-controlled off-chain attachments, integrity commitments, selective exports, and a documented retention/deletion policy. No legal names, salary documents or raw tax forms on-chain.
- [ ] Independent evidence review: check disclosed-field semantics against settlement data and provider attestations; distinguish integrity, payment completion, identity and legal/tax conclusions.

## Production gates and protocol limits

Independent contract/circuit/SDK security review, a reviewed multi-party trusted setup, operational incident procedures, and issuer-control risk assessment are still required before production use. Permanently missing vault payout callbacks remain conservatively reserved; the SDK must not manufacture recovery by resetting a nullifier or redirecting the destination. The current group has 256 outputs and fixed denominations. Public-network deployment is not part of this iteration.
