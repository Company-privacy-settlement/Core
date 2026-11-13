# Local browser withdrawal proofs

[Private notes](BROWSER_NOTES.md) · [Wallet execution](WALLET.md) · [Release packages](RELEASES.md) · [Roadmap](ROADMAP.md)

Front `/prove/` creates and verifies a Groth16 FT withdrawal proof on the user's device. A disposable Web Worker owns witness construction and proving. The original `Spend(8)` circuit, five public inputs, group domains, fixed denomination and additive 15 bps fees are unchanged. No private note, password, witness or proving job is submitted to Core's API. Generating a proof does not send a payment.

## Use the workspace

1. Import the note's independently trusted **testnet FT policy**, then reopen its encrypted backup with the local passphrase. The complete backup policy and commitment must match. Keep the backup until final withdrawal reconciliation.
2. Import `manifest.json`, `spend.wasm`, `spend.zkey` and `verification_key.json` from the reviewed release. Enter the **artifact manifest's SHA-256 from an independent trusted channel**. This is the digest of `artifacts/manifest.json`, not `release.json`, the archive, or the browser SDK manifest.
3. Select a verified payout vault in the original group and load its finalized public snapshot from the matching API. An offline public snapshot can also be imported; importing alone does not establish chain freshness or deployment readiness.
4. Set the exact recipient and disclosure root. For invoice payment, copy the signed invoice recipient and selected unit's reference exactly. A random reference does not settle an invoice. Connected note-to-invoice selection remains separate U02 work.
5. Choose **Generate local proof**. The worker verifies files, reconstructs all 256 padded leaves/eight tree levels, finds the note, checks the advertised root, builds the witness, proves and verifies locally. All five public signals must match the locally expected values.
6. Download the proof file and/or public withdrawal plan. Import the plan into Settlements with the same trusted policy. Existing wallet preflight, signing guards, fees, destination binding and conservative reconciliation still apply. A proof does not reserve liquidity, register a recipient or confirm withdrawal.

**Cancel operation** terminates the worker immediately and invalidates pending results. The already open note remains available in that tab for an explicit retry. **Lock note**, page-hide, persisted cache return and unmount cancel work and clear the open private view; reopening requires the encrypted backup. Late file reads, worker results and verification callbacks cannot restore it. JavaScript and worker termination do not guarantee physical memory zeroization.

## Proving-file trust and limits

The manifest has the existing `core-v1` format, depth 8, setup label and exactly four hashes: R1CS, witness WASM, zkey and verification-key JSON. The browser checks the raw manifest digest before reading the bounded assets; it needs the three runtime assets, not the R1CS file. Limits are 8 KB manifest, 8 MiB WASM, 16 MiB zkey and 16 KB verification key. URLs, extra fields and other circuit depths/protocols are rejected. No arbitrary asset URL is fetched or executed.

Every used asset must match the independently pinned manifest. The verification key must have five public inputs and six IC points; its **832 raw NEAR verifier bytes** must hash to the trusted policy's `verifierSha256`. The JSON hash alone is insufficient. Curve coordinates use BN254 base-field limits and NEAR little-endian G1/G2 order, matching the CLI. The worker independently verifies the generated proof before returning it; the main client also checks the requested note's public signals, root, destination, snapshot and asset digest before enabling export.

An independent hash is a trust anchor for file identity, not proof that a setup ceremony is safe. Current local artifacts retain `UNSAFE_LOCAL_DEVELOPMENT_ONLY` and the UI displays that label. Never substitute new proving material for an already deployed group's verifier.

To make an importable file directory from existing verified artifacts:

```sh
npm run prover:export -- /path/reviewed-release/artifacts \
  INDEPENDENT_ARTIFACT_MANIFEST_SHA256 trusted-ft-policy.json /path/new-browser-files
```

The command verifies all used bytes and the policy binding before writing a new directory. It refuses overwrite, does not create a setup or publish files, and accepts no note/password/key. Run the existing release verification first; the export command does not requalify source provenance or deployed state.

## Public snapshot API

`POST /v1/proofs/context` accepts exactly `{ "vault": "v….<original-registry>" }`. It uses one finalized block to verify registry/vault WASM, keylessness, immutable policy and payout eligibility, then reads the complete ordered commitments on that block and rebuilds the root. The response is:

```text
{ version: 1, policy, checkedAtBlock: { hash, height }, root, commitments, vault }
```

No witness, note, secret, nullifier or request-selected RPC is accepted. Existing exact-origin CORS, no-store, deadlines and admission controls apply; a request costs five rate points and has a 16-read RPC budget. `HttpGateway.provingContext` rechecks policy identity and rejects a substituted payout vault. The browser rebuilds the tree again. RPC/provider correctness, root freshness, current nullifier state, token registrations and liquidity are separate dependencies; the normal wallet flow rechecks executable readiness.

## Proof files and verification

The `core-browser-proof` version-1 file contains the policy, action, informational snapshot block, artifact digest/setup, raw NEAR proof/public signals and a public withdrawal plan. It contains no note secrets, Merkle path or password. Its `digest` is SHA-256 of the canonical JSON **payload excluding the digest field**, not of the formatted downloaded file bytes.

**Verify an existing proof file** checks that checksum, the independently selected policy, action/domain bindings, plan/fee consistency and proving-asset identity, then runs Groth16 verification in a fresh worker. Editing a proof and recomputing its checksum does not bypass cryptographic verification. The checksum is not a signature; a verified file does not authenticate optional snapshot metadata, establish finality or prove that a withdrawal is unspent/executable. Proof files reveal a public nullifier hash, recipient, vault and reference; share them deliberately.

## SDK and runtime

`BrowserProver.prove(request, assets, {signal, onProgress})` and `BrowserProver.verify(bundle, policy, assets, options)` accept a caller-owned worker factory. The bundled `prover-worker.js` is distributed in the browser SDK's SHA-256 inventory. Next.js uses a local module worker; the main SDK bundle retains no Node/runtime dependency. No CDN script or remote prover is used.

The worker uses pinned [snarkjs 0.7.6](https://github.com/iden3/snarkjs/tree/v0.7.6). Its exported curve builder initializes a single-thread engine reused for proving and verification, without nested worker pools or a SharedArrayBuffer requirement. Witness calculation requests 256 initial memory pages. Operation deadlines default to 180 seconds and are bounded to 300 seconds; errors/timeout/success all dispose of the worker. Third-party witness errors and stack traces are never returned to the UI. Dependency licensing/source notices remain in the bundled worker and corresponding repository/release sources.

## Recorded validation — 2026-11-13

The full Core suite passed **275 tests**, including **19 prover regressions**. Front type/build checks, **132 desktop/mobile browser cases** with real proving assets and three unit cases passed, together with the compiled settlement/organization runtime harnesses. Hosted Actions and funded public-network execution remain unobserved.

The final full Core run bounded test-file concurrency to two on this host (`node --import tsx --test --test-concurrency=2 tests/*.test.ts tests/*.test.mjs`); the test inventory is the same as `npm test`.

Core regressions cover CLI witness/public-input and encoding parity, committed public proof-byte round trips, original-group/full-tree handling, changed snapshots, all asset hashes and independent anchors, policy/verifier binding, proof-file tampering, worker crashes/cancellation/deadlines/late results, export guards and the authenticated-origin public HTTP surface. Front's 12 desktop/mobile cases include actual WASM/zkey generation, proof-file reopening, cryptographically altered files, cancellation/retry and page-cache locks. Set `CORE_PROVER_ARTIFACTS_DIR` for the four real-artifact cases; integrated CI creates those artifacts and supplies the variable, rather than skipping them.

`npm run test:browser-prover` independently compares actual browser output with CLI public inputs and verifies it through Node's Groth16 verifier. One local run recorded:

| Chromium viewport | Local generation | File verification | Sampled browser-process-tree peak RSS |
| --- | --- | --- | --- |
| Desktop 1440×1000 | 4.17 s | 0.71 s | ~631 MiB |
| Mobile emulation 390×844 | 3.49 s | 0.50 s | ~608 MiB |

The RSS sample covers the aggregate Chromium process tree, including browser/renderers; it is not a precise WASM heap peak. These are single-run observations on this development host, with concurrent work possible, not a performance guarantee or physical-phone qualification. Real Safari/Firefox/mobile wallets and constrained devices remain U05. The report at `demo-output/browser-prover-validation.json` contains timings, aggregate memory scope and public compatibility checks only. No public-network transaction or backend deployment was performed.
