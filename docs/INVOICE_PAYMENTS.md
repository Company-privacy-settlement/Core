# Connected private-note invoice payments

[Invoices](INVOICES.md) · [Browser prover](BROWSER_PROVER.md) · [Wallet and recovery](WALLET.md) · [Roadmap](ROADMAP.md)

Front `/pay/#invoice=…` connects an original-group encrypted note to a signed invoice unit: **select note → generate proof → review amount and fees → approve each wallet call → observe finalized payment**. The existing FT circuit, ABI, group domains and additive 15 bps fees are unchanged. No proving service or pooled principal account is introduced.

## Complete a payment

1. Open the signed invoice. Independently import the same testnet FT policy, verify the matching API/current merchant key, connect the fee payer wallet and create or unlock the encrypted operation journal.
2. Choose **Payment unit**. Open **Pay with a private note** using the encrypted backup and its passphrase. The note must belong to the exact original policy/group. Retain its encrypted backup through final reconciliation.
3. Select an eligible payout vault. Under **Trusted proving files**, import the release manifest, WASM, zkey and verification-key JSON, with the independently received artifact-manifest SHA-256. Public files remain in this tab across invoice units; private note/proof state is cleared when changing units.
4. Choose **Generate invoice proof**. The SDK derives the recipient and selected unit reference from signed terms; neither is an editable payment destination. It checks current merchant ownership, invoice availability and local journal collisions before and after the worker proof. The worker rebuilds the complete original-group tree, checks all asset hashes and verifies Groth16 locally. **Cancel proof** terminates the job and leaves no imported payment or wallet call.
5. Choose **Review amount & fees**. Only the public plan enters the encrypted journal. Review the recipient, vault, invoice reference, full principal and 0.15% withdrawal fee. The wallet supplies the fee; principal comes from the funded private note. The deposit-side fee was separate. Amounts are token atomic units; no decimal assumption or FX quote is inferred. Storage, first-use bonds, registration and NEAR gas are separate.
6. Explicitly approve each required prerequisite, then **Approve payment in wallet**. Fresh preflight, wallet identity and exact call checks still apply. A second invoice authorization check runs before recording intent, after persistence and immediately before provider dispatch. Opening a wallet prompt is not confirmation.
7. Observe the bound finalized withdrawal record. Checkout polls public reconciliation at most ten times per selected operation, two seconds apart, then requires manual refresh. Polling never signs or resends. The confirmation is for this payment unit; the separate invoice summary can lag the contract and reports the index checkpoint. Select another unpaid unit and a different funded note for a multi-unit invoice.

The CLI/public-plan import path remains available. A plan must match the currently selected unit, recipient and trusted policy; it passes the same session guards. Legacy v1 shared references remain readable and permit sequential completed payments with distinct notes. New v2 units have distinct signed-derived roots.

## SDK boundaries

`prepareInvoiceProof(prover, gateway, signedInvoice, paymentIndex, note, assets, vault, options)` accepts a zero-based unit index. It performs no journal write or signature. Options include `signal`, `onProgress` and `getOperations`; pass the complete original-group journal to detect locally reserved notes and references, including operations belonging to other invoices.

`matchInvoiceProof(bundle, signedInvoice, paymentIndex, payer)` checks the signed invoice and exact selected-unit action/plan binding. Proof-file parsing/checksums alone do not prove Groth16 validity; local generation already runs cryptographic verification. External files must use the browser prover's verification path before being treated as locally verified.

Install `invoiceSettlementGuards(gateway, signedInvoice)` as the fifth `SettlementSession` constructor argument. Its import guard runs inside the journal's exclusive update. Its submit guard uses a fresh current-merchant/index read; the resulting pure authorization expires after 15 seconds or the invoice deadline. Wallet adapters must call optional `context.authorize()` after asynchronous identity work and immediately before handing the exact transaction to their provider. Front's adapter does this. An authorization rejected before wallet dispatch removes only the never-sent intent; an error after entering the wallet adapter remains conservatively uncertain.

## Recovery and limits

- Locking, page-hide/cache entry, unmount and unit changes invalidate pending private work. A late file read or worker result cannot repopulate the cleared note. The encrypted note backup remains separate from the public operation journal.
- A lost wallet response keeps a durable unresolved intent. Reconcile the original call/transaction; never infer rejection or automatically resend. Local duplicate-nullifier and v2 unit checks block competing intents in the same journal. They cannot coordinate separate devices/payers.
- Already accepted payouts retain their exact fixed-recipient retry/refund path even after invoice expiry or merchant-key rotation. Recovery must not invent a new destination, clear a nullifier or charge a new protocol fee.
- Merchant availability/index failures block new proof preparation/import/signature. An expired or fully covered invoice cannot start another payment through this flow. Index history is bounded and not a latest-chain guarantee.
- Invoice deadlines and unit caps are application rules, **not contract reservations**. Independent concurrent payers can overpay; a transaction already handed to an external wallet can settle after expiry. Contract-enforced limits remain separate X04 work.
- Only public vault/policy/status/call data reaches the API or wallet. Notes, witnesses and passphrases stay on-device. Public signer, recipient, amount, timing, vault and invoice unit reference remain observable. A hosted browser can still be compromised; file hashes do not replace deployment security.

## Validation — 2026-11-13

The connected flow adds 14 Core regressions for selected-unit binding, current-key/status failures, duplicate notes/units, fresh authorization around durable intent and delayed wallet work, expiry, uncertain results and fixed-destination recovery. Sixteen desktop/mobile-emulated browser cases use actual WASM/zkey proofs and an injected wallet/read-only API fixture. They cover separate storage/payment approvals, full multi-unit payment, local duplicate rejection, revocation, cancellation, page-cache locking, lost responses, unit changes and expiry. Browser-produced proof bytes are also verified independently through Node Groth16.

Core type checks and all **289 tests**, Node/browser SDK builds, compiled settlement/organization runtime harnesses, Front types/build and three unit cases passed. Browser verification covered **148 cases**: 146 passed in the full run; two existing invoice cases were updated from automatic unit advancement to explicit selected-unit preservation and both passed a focused desktop/mobile rerun. All 16 new connected-flow cases passed with actual proving artifacts.

These local fixtures do not establish a funded public-network wallet transaction, a live backend deployment, physical-phone support or production security qualification. Current proving material remains `UNSAFE_LOCAL_DEVELOPMENT_ONLY`.
