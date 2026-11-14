# Wallet signing and encrypted operation recovery

The browser client connects the read-only operations API to a wallet supplied by the application. The separate [Front repository](https://github.com/Company-privacy-settlement/Front) exposes this flow at `/live/`, using **NEAR Connect 0.12.0** on testnet. Legacy `/app/` routes redirect to the corresponding English Docs guide; the simulation dashboard has been removed. See the [service overview](SERVICE.md) for all current workspaces.

This milestone provides reviewed FT payment execution and recovery. FT note creation, encrypted backups and public deposit planning are also available on [Front `/notes/`](BROWSER_NOTES.md). Groth16 spend proving still uses the local Core CLI. It does not deploy or fund a public testnet group, integrate an external KYB provider, or certify tax/legal compliance.

## Build and use

```sh
npm ci
npm run build:client
```

`dist/client/index.js` is a standalone ESM bundle containing only `sdk/client/` modules. Its build fails if a Node or external runtime module enters the bundle. Declarations and a SHA-256 manifest accompany it. It uses browser Web Crypto and Web Locks, with no application signing key.

```ts
import {
  HttpGateway, OperationJournal, SettlementSession, browserJournalStorage,
  parsePolicy,
} from './dist/client/index.js';

// Obtain this file independently of the API. Do not trust a policy solely because an API returned it.
const policy = parsePolicy(trustedPolicyJson);
const gateway = new HttpGateway('https://your-core-api.example');
const journal = new OperationJournal(browserJournalStorage(), passphrase);
await journal.create(); // Existing journal: use list() to unlock instead. Never overwrite it.
const session = new SettlementSession(journal, gateway, walletPort, policy);
const operation = await session.importPlan(publicFtPlan);
const review = await session.review(operation.id);
// Render receiver, function, arguments, token amount, attached NEAR, and additional gas.
if (review.action === 'sign') {
  await session.submitReviewed(operation.id, review.callHash!);
}
// Review again for the next prerequisite or finalized settlement state. Never loop automatic signatures.
```

`WalletPort.identity()` returns `{network, accountId}`. `sign(call, context)` must verify `context.identity` immediately before invoking the wallet and return `{hash, signer}`, or `undefined` for an unavailable result. The shipped Front adapter checks the wallet account/network again, requests one explicit `FunctionCall`, and supplies the reviewed signer. It does not request a limited-access application key. The wallet/provider remains a trust dependency.

Front vendors the bundle, declarations and manifest so an independent Front checkout builds without Core or Contract directories. To update it:

```sh
npm run build:client
(cd ../Front && npm run sync:core && npm run check && npm run build)
```

`Front/scripts/core-client.mjs` verifies every copied checksum. Checksums detect accidental divergence; establish source authenticity through the repository/release channel independently.

## Prepare the public input

Use an actual deployed FT shared group and independently reviewed WASM/verifier hashes. Placeholder policies are deliberately unusable. The testnet workspace accepts only `network: testnet` with `tokenId`; the Core client also supports sandbox FT groups for integration validation.

1. Start Core's API with `CORE_POLICY_FILE`, `CORE_RPC_URL` and the exact Front origin in `CORE_ALLOWED_ORIGINS`. See [OPERATIONS.md](OPERATIONS.md).
2. Create and retain an encrypted FT note on `/notes/` and prepare its public deposit plan, or use `shared-note` / `shared-deposit-args` in the CLI. Use `shared-spend-args` for a public withdrawal plan; it accepts browser note backups directly. These commands retain local proving and bind withdrawal public inputs to the token, registry, denomination, vault, recipient and receipt root.
3. On Front `/live/`, enter the API origin, import the independently trusted policy file, and verify that all policy values match. Policy equality alone is not a chain-readiness claim.
4. Connect a NEAR testnet wallet. Create/unlock a journal with a passphrase of at least 12 characters. Import only the **public FT plan**.
5. Review and approve each prerequisite, then the payment. Refresh until the bound contract record becomes `Active` (deposit) or `Complete` (withdrawal).
6. Export an encrypted journal backup. Also retain your separate encrypted private-note backup: the journal cannot authorize a future withdrawal.

The client derives the principal and 15 bps fee from the trusted policy rather than trusting a plan's display quote. A 1 USDC group charges **1,001,500 token atomic units** to deposit and **1,500** to withdraw; the recipient receives **1,000,000**. NEAR storage and gas are separate. First-use storage prepayment includes a 0.005 NEAR ledger bond plus 0.02 NEAR action credit. Token registration and activation of fresh accounts are separate prerequisites. Missing accounts block signing; this flow does not create EOA keys or silently activate accounts.

## Crash and redirect behavior

Before calling a wallet, the journal records the exact call, SHA-256 hash, original commitment/nullifier/destination, and state **`signing`** in encrypted storage. If persistence fails, the wallet is never called. A cross-tab Web Lock remains held through signing and result persistence. Unsupported Web Locks or a competing tab fail closed.

An exception, page redirect, closed tab, or missing wallet result leaves an unresolved attempt. Reopening the journal never automatically sends that payment again. A matching finalized contract record can establish payment acceptance. Otherwise, supply the original transaction hash with `session.reconcile(id, {hash, signer})`, or use Front's **Verify existing transaction**. A wallet rejection without a verifiable transaction remains conservatively blocked; there is no unsafe “reset and resend” button.

`POST /v1/transactions/verify` performs a public read against the configured RPC. It requires the exact transaction hash, signer, receiver, single function call, arguments, gas and attached deposit, and requires an observed `FINAL` result. Unknown/non-final lookups remain pending without rebroadcast. Unknown transactions remain pending. An FT resolver's exact used amount proves acceptance; a finalized used amount of zero establishes non-acceptance. An outer transaction failure or unexpected/partial result remains **unknown** because a receiver may already have accepted tokens before a later resolver failure. Acceptance alone never establishes settlement completion.

Recovery calls remain bound to the original commitment/nullifier and destination. They are offered only by the contract observer; retries charge the specified NEAR storage attachment, never another token fee. A confirmed prerequisite/recovery still visible in the same stale state is not automatically purchased again. An operation already finalized in the journal never reopens on a later inconsistent read.

## Encryption and storage

Format `core-operation-journal` v1 uses PBKDF2-SHA256 (250,000 iterations, fresh 16-byte salt) and AES-256-GCM (fresh 12-byte IV, format-bound authenticated data). The envelope contains only ciphertext and encryption parameters. The passphrase is held in the unlocked client instance and cleared by `lock()`; the application clears the passphrase input after unlocking. Browsers, extensions and wallet providers can still observe unlocked memory. Encryption does not protect against compromised page code or an endpoint that sees public lookup requests.

The journal stores only reviewed public plans, bindings and signature attempts. It accepts at most 100 operations and 64 attempts per operation; plaintext is capped at 2 MB. Unknown/private input fields are rejected, and restored operations are revalidated. Backup restoration requires empty storage to prevent accidental loss of existing recovery history. Keep the passphrase separately; there is no recovery service. This PBKDF2 journal format is separate from the CLI's scrypt-encrypted note format.

`sdk/client-node.ts` provides an optional local file adapter with 0600 atomic writes, fsync and an exclusive lock directory. A process crash may leave a lock directory. Reconcile interrupted signing before manually removing that lock; the adapter never steals it on a timer. The sandbox uses this adapter and disposable local-chain signers. It is not a server custody service.

## Validation boundaries

Core tests cover encrypted restart/restore, persistence failure, cross-context exclusion, wrong identity/policy/destinations, stale reviews, uncertain signatures and exact finalized transaction checks. `npm run demo:ft` additionally drives this client through an actual sandbox storage prerequisite, token deposit and fixed-destination withdrawal recovery, using real WASM/Groth16 and the HTTP gateway.

Front browser tests use the connector's standard injected-wallet interface and mocked public reads to cover desktop/mobile review, signing requests, encryption, backup and reload blocking. They do not establish that an externally funded wallet has signed against a publicly deployed testnet group. That smoke test remains dependent on a funded, reviewed deployment.

Primary integration references: [NEAR Connect](https://github.com/hot-dao/near-selector), [transaction RPC/finality](https://docs.near.org/api/rpc/transactions), [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md).

Before preparing a payout, use the [recipient readiness check](RECIPIENTS.md) in the SDK, CLI or browser. It separates account activation and token registration at one final block and provides an inspectable registration call without signing or submitting it.

## Locking during pending work

Locking revokes in-progress journal accesses and prevents late reads, restores, reviews and wallet dispatch from continuing. The settlement workspace also locks on page-hide and persisted history-cache return, invalidating pending UI work. Encrypted history is preserved. A storage write or wallet request that already started cannot be undone: a durable unresolved signing intent remains blocked after reopening until the original transaction or bound finalized state is reconciled. Locking does not establish transaction failure or authorize resending. See [review details and regressions](REVIEW-2026-11-13-JOURNAL.md).

## Local proving before wallet review

[Local proofs](BROWSER_PROVER.md) generates and verifies an FT withdrawal proof in a disposable browser worker. Its exported public plan enters the same existing import/review/sign/reconcile flow. No wallet key is needed for proving; no signing or submission occurs in the prover. Keep the note backup through final reconciliation. [Connected invoice checkout](INVOICE_PAYMENTS.md) opens an encrypted note, derives the selected signed unit action and generates its proof before entering the same review/sign/reconcile flow. Its SDK session guards recheck current merchant ownership and invoice availability at import and signature time; the adapter invokes the last-moment authorization after asynchronous identity reads. Fixed-destination recovery remains available for already accepted funds after expiry.

## Corporate approval at dispatch

[Corporate payment guards](CORPORATE_PAYMENTS.md) bind the immutable approved policy/call and creator fee payer, then recheck current independent approval before each signature. A supporting adapter advertises `supportsBeforeDispatch: true`, awaits `context.beforeDispatch()` once after asynchronous identity work and immediately before the provider, and invokes `context.authorize()` for the final local lock/expiry check. Front implements this hook. Unsupported adapters fail before a corporate signing intent; lost authorization/provider responses preserve unresolved journal/one-use reservation state. This application gate does not change the contracts’ permissionless proof execution.

## Recorded native testnet software-wallet run

[Native NEAR public-testnet qualification](TESTNET_WALLET.md) records fourteen FINAL transactions, two deposits, cross-vault payout selection, a real missing-recipient failure and fixed-destination recovery with no second protocol fee. This validates the CLI/local-key native path. The Front FT wallet/NEAR Connect path and USDC are still unqualified on the public network.
