# Journal cancellation and wallet dispatch review — 2026-11-13

Scope: the operation journal, reviewed wallet dispatch, and settlement workspace lifecycle. Contract and circuit artifacts are unchanged.

## P1 — journal lock did not revoke in-progress access

Clearing the journal's password prevented new reads but did not invalidate a read whose decryption had already captured the passphrase. Such a read could return plaintext after locking. A durable signing-intent write could also finish after locking and then dispatch a wallet request. These cases were reproduced with deferred decryption and storage.

Every journal access now captures a generation and checks it before and after asynchronous reads, decryption, validation, encryption and writes. Lock increments that generation. Results are withheld after cancellation, and the persistence callback is usable only while its access context is active. Reviewed submission checks the same context immediately before calling the wallet, after the signing-intent write has completed.

The lock cannot undo a storage write or wallet request that already started. An already-written `signing` attempt remains in the encrypted journal when a wallet result arrives after locking. Reopening that entry requires reconciliation or bound finalized observation; it must not trigger another signature. The new regressions cover this conservative state as well as cancellation during restore and an unsigned preflight review.

## P1 — settlement cache and late unlock could retain or restore an active journal

The settlement workspace had no history-cache lock and tracked a journal only after create/restore/unlock completed. Unfinished creation or restoration could therefore reopen the workspace after navigation. Unmount cleanup did not invalidate later policy checks, plan reads, reviews, status updates or exports.

The workspace now uses the shared page-hide/persisted-cache-return lock. It tracks the candidate journal before awaiting create/restore/list, revokes both candidate and active journals, and invalidates the UI generation on lock and unmount. A synchronous running flag prevents simultaneous actions before React's busy state updates. Policy verification, wallet connection, backup handling, plan import, review, invoice checks, signing and reconciliation verify that generation before applying results or continuing side effects.

Browser regressions reproduce cache entry with visible operation history, cache entry while create encryption is pending, and cache entry during approval preflight. They check immediate view clearing, retained encrypted history, blocked late writes/unlocks, and absence of late wallet calls. Recovery stays explicit after reopening the journal.

## Validation

Four original SDK cancellation regressions and the browser cache regressions fail against the previous behavior. The fixed SDK is checked with the full Core test suite and actual sandbox wallet sessions, including prerequisite approval, deposits, withdrawals, recovery and encrypted journal persistence. Front is type-checked, built and checked with its browser suite on desktop and mobile. Cryptographic formats, fees and destinations remain compatible.

This review verifies cancellation and conservative recovery, not physical memory erasure or a full protocol security audit. A lock does not cancel a provider's already-open signing interface; check its existing transaction and finalized contract state before continuing.
