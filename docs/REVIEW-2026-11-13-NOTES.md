# Browser note and deposit-plan review — 2026-11-13

Scope: browser private-note creation/backups, CLI interoperability, public FT deposit planning, and the invoice library's related private-view lifecycle. The changes below address reproduced defects; they are not a full protocol security audit.

## P1 — private views survive browser history-cache entry

Notes and the invoice library invalidated work on component unmount and explicit lock. Browser history caching can retain a mounted document, so those paths did not clear the active note, passphrases, library entries or a library-opened invoice before caching it.

Front now registers `pagehide` and persisted `pageshow` locks. The handler flushes the lock's React updates synchronously before returning, clears the private rendered view and invokes the existing generation/epoch cancellation. Pending encryption, file reads and other library operations cannot repopulate the locked view. The handler uses the current lock callback so it also hides an invoice opened after the listener was installed. Encrypted library storage is retained; users must reopen the saved note backup or unlock the library to continue.

Regression coverage checks synchronous removal during a persisted page-hide event, cached return, reopening backups, completion of delayed note encryption, hiding a library-opened invoice, and preservation of encrypted library bytes. Browser lifecycle events do not establish physical erasure or cover every OS/browser termination path. See [pagehide lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event) and [React synchronous browser integration](https://react.dev/reference/react-dom/flushSync).

## P2 — the caller's trusted backup policy was read after decryption

`openNoteBackup` parsed `expectedPolicy` after asynchronous decryption. Reusing and modifying that caller-owned object could accept a backup that differed from the policy at call entry, or reject one that originally matched.

The function now parses a separate policy snapshot before its first await and compares the decrypted payload against that snapshot. Tests reproduce both directions of mutation: an initially different policy cannot become trusted while decrypting, and changing an initially matching caller object does not change the ongoing check.

## P2 — targeted last-member checks claimed a complete vault scan

Public deposit planning derived `vaultScanComplete` from the catalog's next-page cursor. Explicitly verifying record 201 of 202 leaves no next page but does not verify records 0–200. The API incorrectly reported full coverage.

Completion now requires `checkedRecords === vaultCount`. An explicit one-member check in a multi-member registry remains partial even for its last record. The regression exercises that exact boundary while retaining successful direct deposit planning beyond the default bounded scan. Ordinary complete scans keep their previous result.

## Validation

The new policy-mutation and last-member regressions failed before their fixes. Both desktop and mobile history-cache regressions failed against the previous Front build. The corrected code is checked with Core's full test suite, the browser client build/checksum checks, Front's type/build checks, and the browser regression suite. Contract and circuit artifacts are unchanged.
