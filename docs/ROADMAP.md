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

Validation: `npm run check`, **54 SDK/API tests**, and `npm run demo:ft` with **14 finalized settlement records** pass. The sandbox report confirms live preflight, HTTP API, and finalized recovery observation.

Implementation: `sdk/operations.ts`, `server/api.ts`, `scripts/server.ts`, and `scripts/cli.ts`. Usage and limitations: [OPERATIONS.md](OPERATIONS.md).

## P1 — connect a real product flow

| Task | Deliverable / acceptance condition | Dependency |
| --- | --- | --- |
| Wallet adapter and frontend integration | User reviews prerequisites and fees, signs locally, and tracks the original commitment/nullifier until finalized completion. Reject account/network changes and avoid duplicate submission after reconnect. | Front changes and a selected wallet integration |
| Browser SDK packaging | Separate browser-safe field/receipt/proof code from Node CLI, file I/O and key management; verify the same public vectors in both environments. | Browser prover performance and memory measurements |
| Encrypted local operation journal | Persist submitted transaction references, expected bindings and recovery state without plaintext note secrets; resume after restart. | Storage format and user-controlled encryption/backup UX |
| Finalized event indexer | Durable checkpoints, reorg/finality handling, transaction/receipt correlation and paginated activity; retain selected-history evidence claims. | Persistent datastore and RPC provider |
| API deployment hardening | Authentication for any future private business data, rate limits, per-route budgets, OpenAPI/client generation, redacted telemetry and deployment health checks. | Hosting/access model; current API defaults to loopback |
| Testnet deployment workflow | Reproducible artifact/policy release, verified token registration, explicit key-removal phase and a real-wallet smoke test. | Funded deployer account and reviewed setup hashes |
| Group capacity management | Discover and display full groups, route new deposits to separately approved groups, preserve withdrawal access to old groups. No implied private cross-group migration. | New group deployment/policy distribution |

## P2 — enterprise and compliance integrations

- [ ] Real KYB/KYC provider: entity and beneficial-owner review, trusted issuer configuration, credential expiry/revocation freshness, and provider callbacks. Existing signature checks alone do not establish identity. A circuit-enforced admission policy requires separately versioned Contract work.
- [ ] US / Abu Dhabi preparation: determine the US state, ADGM versus mainland, payment classification and effective date; version cited official rules, calculate deterministically, and prepare reviewable AI drafts. Do not invent tax rates or claim filing/approval.
- [ ] Encrypted business-document packages: access-controlled off-chain attachments, integrity commitments, selective exports, and a documented retention/deletion policy. No legal names, salary documents or raw tax forms on-chain.
- [ ] Independent evidence review: check disclosed-field semantics against settlement data and provider attestations; distinguish integrity, payment completion, identity and legal/tax conclusions.

## Production gates and protocol limits

Independent contract/circuit/SDK security review, a reviewed multi-party trusted setup, operational incident procedures, and issuer-control risk assessment are still required before production use. Permanently missing vault payout callbacks remain conservatively reserved; the SDK must not manufacture recovery by resetting a nullifier or redirecting the destination. The current group has 256 outputs and fixed denominations. Public-network deployment is not part of this iteration.
