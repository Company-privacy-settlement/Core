# Contract and corporate payment security review — 2026-11-14

[Corporate approvals](CORPORATE_PAYMENTS.md) · [Protocol privacy and trust](PRIVACY.md) · [Recovery](ORGANIZATION_BACKUPS.md)

Scope: the shared native v2 and token-bound v3 registry/vault contracts, the original pool/factory regression suites, Organization payment reservations, current membership checks and the supported SDK dispatch gate. This is a focused implementation review and adversarial regression run, not an independent production audit.

## Finding and correction

| Priority | Reproduced behavior | Correction |
| --- | --- | --- |
| P2 | An organization could reserve the same protocol nullifier twice by changing a policy's code hash, verifier hash or treasury metadata. The old reservation key included the entire policy; those fields do not create another v3 proof domain. Three new regressions failed before the fix, including racing creation and pre-upgrade aliases. On-chain nullifier checks still prevented a second principal payout. | Key new reservations by network, registry, token, denomination and nullifier. Compare existing reserved payloads using the same domain under `BEGIN IMMEDIATE`, including legacy stored keys. Recheck conflicts at approval and dispatch; report an approval invalid while conflicting claims remain. |

The change is in [Organization payments](../server/organizations/payments.ts). It leaves approved payloads, hashes, sessions, memberships and consumed dispatch reservations intact. It requires no schema migration and does not reset or rewrite historical claims. Contract execution and proof formats are unchanged.

New duplicates return `PAYMENT_NOTE_RESERVED`. Existing conflicting claims return `PAYMENT_NOTE_CONFLICT` before approval or dispatch. An authorized user can cancel/reject a conflicting request only if no call has been reserved, using existing version/content checks, then independently approve the remaining request. A dispatched or restore-invalidated claim remains reserved for reconciliation; deleting it or editing the database is not a recovery procedure. Separate organizations retain separate application reservations; the contract enforces global spent-nullifier safety.

## Acceptance matrix

| Requirement | Adversarial verification | Result and boundary |
| --- | --- | --- |
| Double spend | Two different valid destination proofs for one note race through different funded signers. Original unit suites also cover transfer/withdrawal nullifier reuse and domain substitution. | One principal payout and one spent nullifier. A competing proof cannot pay another recipient/vault. |
| Concurrent withdrawals | Two distinct spendable notes race for one vault's single liquid slot. Two independent OS processes also race one approved API dispatch. | One payout from that slot; rejected note remains unspent. One API call reservation and one successful audit entry. |
| Failure accounting | Missing native recipient and unregistered FT recipient cause real payout failures. Unit tests interleave failed payouts/refunds/fee collection with successful callbacks and new deposits. | Principal/nullifier/liquidity remain reserved; failed withdrawal fee remains pending, not earned. Callback order does not release another liability or erase newly earned fees. |
| Fixed recovery | Another funded signer retries the failed withdrawal after original-recipient readiness is fixed. Duplicate retry, changed recipient, direct vault access and external callback forgery are attempted. | Full principal reaches the original recipient once. No second protocol fee. Forged/direct paths are rejected and completed retry cannot pay again. |
| Approved content changes | Change title, policy, payment/proof/reference/fee or prerequisites; substitute stored payload after approval; change digest/version in HTTP requests. | Content/call/version checks reject substitution before a new dispatch and do not append a success audit. |
| Revocation | Remove/demote maker or approver, restore their role, change authority on a second SQLite connection, and revoke during the wallet's final asynchronous gate. | Old membership revisions never regain approval authority. The supported application refuses a new dispatch; already accepted fixed-destination recovery remains available. |

The added six [corporate payment cases](../tests/corporate-payments.test.ts) cover metadata aliases, competing connections, legacy conflict handling, cross-connection revocation, stored-content corruption and actual separate-process dispatch contention. Existing seventeen cases cover API/SDK approval separation, role/tenant isolation, wallet gates, expiry, backup invalidation and uncertain responses. Six added [vault cases](https://github.com/Company-privacy-settlement/Contract/blob/main/contracts/shared-vault/src/tests.rs) cover native/FT payout and refund interleavings, failed fee collection and overbooking.

## Reproduce

From Contract, run all pool/factory/shared-vault/forest unit suites:

```bash
npm test
```

From Core, use matching local proving artifacts and the adjacent Contract checkout:

```bash
npm run check
npm test
npm run build:service
npm run contract:build
npm run test:payment-security-sandbox
```

The new sandbox runner is [payment-security-sandbox.ts](../tests/manual/payment-security-sandbox.ts). It deploys real keyless native/FT registry/vault WASM into a disposable NEAR sandbox, creates four notes in two vaults per asset and generates real Groth16 proofs. It uses different transaction signers for concurrent requests, compares actual recipient balances, observes contract reservation/fee state and checks original-target recovery. FT assertions reconcile both actors' fee balances, refunded rejected calls, retained storage credits and vault/registry token holdings. It intentionally retains one unspent note in each disposable sandbox; teardown destroys the test environment.

Inspect receipt failures and semantic state, not only an outer transaction's success flag: an FT resolver can refund a rejected call while the outer token transaction succeeds. Initialization/proof snapshots wait for FINAL key sealing and deposits. These are test-harness checks, not protocol fixes.

Proof preparation is sequential in this harness so the Node verifier's initial worker pool is shared and shutdown finishes. The actual withdrawal transactions still race through separate signers. Concurrent proof generation is not claimed as part of this test.

[Machine-readable sandbox evidence](evidence/payment-security-sandbox-2026-11-14.json) records the checked code/verifier pins, local transaction hashes and each result. Local sandbox hashes are not public-testnet transaction evidence. TESTUSD is a fixture, not Circle-issued USDC. No public-network transaction, contract upgrade or production security qualification is claimed by this review.

Validation: **582 Core tests**, including **23 corporate-payment cases**, and **63 contract tests** (pool 16, factory 8, shared vault 22, forest 17) passed. Types, service compilation and compiled API/indexer/organization restart, backup, quarantine and reviewed recovery checks passed. The browser SDK inventory is unchanged. Rebuilt production forest/vault WASM hashes match the prior pinned binaries; the contract change adds tests only. The evidence includes fingerprints of the reviewed implementation and test files.

## Remaining security boundaries

Organization approval and revocation are enforced by the API/SDK flow. The contracts remain permissionless for a valid, destination-bound public proof. Someone holding an unsubmitted public withdrawal proof can relay it outside organization approval, and revocation cannot retract an already broadcast transaction or proof. Contract-enforced corporate dual authorization requires a separately versioned contract/action policy. This review does not claim that boundary is closed.

Maker/approver separation is between wallet accounts, not verified independent people. A database administrator can alter off-chain approval history; payload hashes do not authenticate a malicious database administrator. The development trusted setup remains `UNSAFE_LOCAL_DEVELOPMENT_ONLY`; production audit, reviewed setup, real browser-wallet/public-USDC and hosted HTTPS/remote CI qualifications remain separate.
