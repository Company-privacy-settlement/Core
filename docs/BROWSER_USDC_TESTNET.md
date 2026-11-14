# Browser wallet and native testnet USDC qualification

[Native CLI evidence](TESTNET_WALLET.md) · [Wallet execution](WALLET.md) · [Browser proofs](BROWSER_PROVER.md) · [Invoices](INVOICE_PAYMENTS.md) · [Deployment](DEPLOYMENT.md)

## Current observation — 2026-11-14

**End-to-end browser-wallet USDC qualification is not complete.** The native CLI run and labelled browser fixtures remain separate evidence. No USDC deposit, invoice payout, withdrawal or recovery transaction is asserted by this update.

A read-only query of one fresh FINAL NEAR testnet snapshot verified the Circle-listed native USDC account, its six-decimal metadata, deployed code hash, payer balance/registration and NEAR balance after current storage stake. The existing owned payer `core14-0574c4-ebed76bb2c.testnet` initially had **0 USDC**, no token registration and about **2.1275 spendable testnet NEAR**. See the [before-registration snapshot](evidence/browser-usdc-funding-before-registration-2026-11-14.json).

Token registration was then provisioned with the existing owned local Ed25519 CLI signer: [`5qiSCayqf2D4bS1huUjDozqAfocsdC4jACGKym3rh7wo`](https://testnet.nearblocks.io/txns/5qiSCayqf2D4bS1huUjDozqAfocsdC4jACGKym3rh7wo), FINAL with no failed receipts, attaching **0.00125 testnet NEAR**. The original hash, signature, signer, exact `storage_deposit` call and FINAL receipts were re-read independently. This is a preparation transaction, not browser-wallet or USDC settlement acceptance. [Public registration evidence](evidence/browser-usdc-registration-2026-11-14.json).

The [latest funding report](evidence/browser-usdc-funding-2026-11-14.json) confirms registration but still records **0 USDC**. Its remaining blockers are testnet USDC funding and independent code-hash review.

The official [Circle USDC contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses) identifies NEAR Testnet USDC as:

```text
3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
```

A normal request through [Circle's public faucet](https://faucet.circle.com) selected **USDC → Near Testnet** and the owned payer. The site returned a bot-detection message and an interactive reCAPTCHA challenge; no token grant was observed. Human completion or an already funded owned testnet account is required. No challenge bypass or repeated automated faucet submission is part of this workflow.

The actual Front invoice page opened NEAR Connect’s real testnet picker and displayed Meteor, without fixture routes. Authentication/signing was not completed. See the [prerequisite observations](evidence/browser-usdc-prerequisites-2026-11-14.json).

The live MyNearWallet testnet page announced limited mode from November 1 and disabled new connections/approvals. The NEAR Connect manifest currently advertises other testnet-capable providers, including Meteor and Intear. Check current wallet availability and actual account access before signing; a manifest flag, visible picker or opened provider UI does not establish authentication or a signed transaction. Never send recovery phrases or private keys in chat or commit them to a repository.

## Reproducible read-only funding preflight

This command needs no wallet, private key or API server. Copy [the public input template](../examples/usdc-funding.template.json), select the owned payer and explicitly reviewed HTTPS RPC, and optionally add an independently reviewed `tokenCodeSha256`. An observed code hash in a report is not independent approval of that code.

```bash
npm ci
npm run testnet:preflight-usdc -- /path/usdc-funding.json /path/new-funding-report.json
```

For two 1 USDC notes, the balance requirement is **2.006 USDC**:

| Action | Per note, USDC atomic units |
| --- | ---: |
| Full principal | 1,000,000 |
| Deposit: principal + 0.15% | 1,001,500 |
| Withdrawal: added 0.15% fee | 1,500 |
| Two deposits and two withdrawal fees | 2,006,000 total |

The recipient receives the full principal. NEAR gas, token storage registration, registry/vault deployment, account activation and action storage credit are separate. The configured NEAR reserve is compared after subtracting current account storage stake using the snapshot's protocol storage price; it is not a quote for all new provisioning costs.

Preflight rejects wrong-chain/syncing/stale RPC, mismatched snapshots, invalid metadata/amounts, credential-bearing input and malformed storage records. It pins the official token account rather than accepting a look-alike TESTUSD symbol. All state reads target the same finalized block. Input/RPC responses are bounded and the output is created exclusively with mode 0600, without overwriting earlier reports.

Exit codes: **0** means only that the configured funding checks passed; **2** means observed prerequisites are blocked; **1** means input/RPC verification failed. All outcomes keep browser/deposit/proof/invoice/withdrawal/recovery/USDC-settlement qualification claims false. Funding readiness alone never completes the acceptance criteria below.

## Remaining execution prerequisites

1. An owned testnet account authenticated in a supported actual browser wallet, with NEP-413 message signing for the invoice merchant and transaction signing for the payer. Keep each reviewed wallet approval explicit. Do not replace the wallet with an injected fixture or a local CLI signer and call it browser evidence.
2. Actual official testnet USDC, payer token storage registration, and enough separate testnet NEAR for each account and prerequisite. The funding report supplies observed token storage minimums; registration requires a signed transaction; the observed preparation transaction used the local CLI signer and does not count as browser-wallet acceptance.
3. A **new token-bound v3 FT registry and funded independent vaults**, released/deployed/sealed through the existing pinned tooling. Independently review token/registry/vault/verifier hashes and zero access keys. The existing native v2 registry/policy cannot serve this flow. A new group needs separate deployment funding and reviewed release inputs.
4. Core API plus finalized indexer configured against that FT policy, an independently received policy file, correct browser CORS origin, and matching trusted proving manifest/WASM/zkey/verification key. The existing private Front deployment does not provision a backend. Local acceptance may use loopback services; externally hosted HTTPS acceptance remains a separate task.

## Acceptance sequence and evidence

| Step | Required actual observation |
| --- | --- |
| Merchant invoice | Connect the real merchant browser wallet, sign the current invoice with NEP-413, and verify its merchant key and token-bound policy through the real API. Record invoice hash and public unit/reference bindings. |
| Deposit two notes | Generate/encrypt notes locally, retain backups, review each registration/storage prerequisite and each 1,001,500-atomic deposit. Record real wallet transaction hashes, FINAL receipts and each bound commitment becoming Active. |
| Browser proof | Select an original-group encrypted note, validate trusted artifact hashes, generate/verify the actual local Groth16 proof, and bind its root/nullifier to the intended invoice unit, payout vault and recipient. Cancellation must leave no signing attempt. Never export witnesses or note passwords. |
| Invoice payment | Review full principal, 1,500-atomic added fee and every NEAR prerequisite; approve individually in the actual wallet. Record the fee transfer/acceptance and finalized Complete withdrawal plus the real indexed invoice status. Wallet approval alone is insufficient. |
| Failure | Use only an owned test recipient. Confirm a real failed FT payout, not merely a rejected local preflight or an uncertain callback. For example, an owned recipient's token registration may disappear after review; force-unregistration burns its token balance, so use an empty dedicated account. Never weaken preflight checks or use another person's account to manufacture failure. |
| Recovery | Once the original dedicated recipient is registered again, review and sign the observer-provided recovery call. Confirm the original nullifier, vault, recipient, amount and disclosure root; Complete/attempt increase; exact recipient balance increase; and no second USDC protocol fee. |
| Independent read-back | At a finalized snapshot, re-read signed transactions, exact call parameters, resolver usage, registry/vault states, recipient token balances and fees. Separate chain observations from wallet-interaction observations; RPC receipts alone do not prove which browser/provider signed. |

A valid result must retain public account IDs, transaction hashes/signers, finalized block references, token code/policy/artifact hashes, invoice bindings, before/after balances and recovery identity. Browser evidence should identify the actual provider/network and individual approvals, with keys, passwords and note secrets excluded. Reconcile uncertain signatures using their original hashes instead of resetting the journal or automatically signing again.

Use an explicit completion checklist: deposit, browser proof, invoice payment, withdrawal, real failure and recovery. Publish only observed successes. Public metadata and the development SRS limitations still apply; even a successful run would not establish effective anonymity or production readiness.

## Validation of this preparatory update

Core type checking and all **520 tests** passed, including seven focused funding-preflight tests. CLI smoke checks confirmed exclusive report creation, preservation of existing evidence, rejection of secret-bearing input without leaking its contents, and mode 0600 for generated reports. SDK/browser vendoring remains byte-identical. The actual public read returned exit 2 with funding blocked before and after registration, while retaining every execution-qualification claim as false. The single actual registration transaction was independently checked for signature, FINAL receipts, destination, method, arguments and attachment. Full browser settlement acceptance remains open.
