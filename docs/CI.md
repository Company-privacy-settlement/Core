# Core, Contract and Front integration CI

[Service overview](SERVICE.md) · [Release packages](RELEASES.md) · [Server hosting](HOSTING.md) · [Roadmap](ROADMAP.md)

All three repositories call Core's [reusable integration workflow](../.github/workflows/integration.yml). Pushes and pull requests test the changed repository's exact event SHA against two selected sibling revisions. Core also retains its service-container build and fail-closed startup check. CI does not deploy servers, submit public-network transactions, change site access, publish releases or rotate an existing group's setup.

Repository-local checks also remain: Core types/units/SDK/service, Contract WASM/units and Front types/units/static build. They run independently of the integration job once GitHub can resolve the shared workflow. Observe the hosted check names before configuring any branch-protection requirement; this change does not modify repository protection settings.

## Source selection

Core's [integration lock](../.github/integration-lock.json) contains full Contract and Front commit SHAs. The tested Core revision is explicit; the file cannot contain its own commit hash. Front and Contract callers pin both the reusable workflow and the tested Core baseline to the same full Core SHA, and pass their own `github.sha` as the candidate. The untouched sibling comes from that Core revision's integration lock. A pull request uses the event's merge SHA, not a moving branch name.

| Trigger | Core | Contract | Front |
| --- | --- | --- | --- |
| Core push/PR | Event SHA | Core lock | Core lock |
| Contract push/PR | Caller-pinned Core SHA | Event SHA | Pinned Core lock |
| Front push/PR | Caller-pinned Core SHA | Pinned Core lock | Event SHA |
| Core manual dispatch | Explicit SHA or selected workflow SHA | Explicit SHA or lock | Explicit SHA or lock |

The resolver accepts only lowercase 40-character commit SHAs, validates the baseline even when overridden, and never resolves `main` during the run. After checkout, CI checks actual Git HEADs, clean trees, package identities and identical public vectors in Core/Contract. `sources.json` records the three commits, Git trees, package versions, vector hashes and lock hash.

To test coordinated changes before updating defaults, dispatch **Three-repository integration** in Core's Actions tab, supplying all three exact SHAs. The workflow revision selected in the UI supplies the orchestration code; `core-ref` selects the Core source checkout. Both are visible in Actions. Promote a reviewed tuple by updating the Core lock and the two caller pins in committed changes. Caller pins intentionally stay fixed until updated; a new Core commit does not silently change other repositories' baselines. No circular self-hash or moving cross-repository branch is required.

## GitHub configuration

For private repositories, configure an organization Actions secret named `INTEGRATION_READ_TOKEN`, restricted to these three repositories. Use a fine-grained token with **Contents: read** on Core, Contract and Front. It is passed only to checkout steps; credentials are not persisted or exported to builds. Without it, checkout falls back to the caller's read-only `GITHUB_TOKEN`, which can read its own repository and public siblings, but cannot read private siblings. Missing access fails the run; no integration stage is silently treated as passed.

In **Core → Settings → Actions → General → Access**, permit the other two private repositories in the organization to use Core's reusable workflows. Also allow the pinned GitHub actions used by the workflow in organization/repository Actions policy. Secrets do not make an inaccessible reusable workflow callable: GitHub resolves that access before starting jobs. These settings and secrets require repository administration access and are not installed by committing YAML.

Fork pull requests do not receive the read token. Keep that protection; use maintainer-reviewed commits and an explicit manual run for private cross-repository qualification. No `pull_request_target`, write token, automatic PR comment or unattended publication is used. The workflow uses hosted disposable Ubuntu runners, read-only repository permissions, pinned third-party action commits, bounded job/demo timeouts and cancellation of older runs for the same workflow/ref.

GitHub references: [reusing workflows and access](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [checkout permissions and private siblings](https://github.com/actions/checkout#checkout-multiple-repos-private).

## Gates

1. Install all three lockfiles with `npm ci`.
2. Check Core types and all unit tests; rebuild Node/browser SDKs.
3. Compare Front's committed browser SDK with the newly built Core files **and current source inventory**. Front's self-check alone cannot establish freshness. CI never runs `sync:core` to conceal drift.
4. Compile API/indexer and test readiness, single writer, restart, online backup, protected restore and cancellation against local mock RPC.
5. Check Front types and units; build its static export. Run the complete Chromium desktop/mobile suite with a fresh loopback server. Install Chromium/system dependencies on the runner; do not reuse an unrelated process on port 3000.
6. Build the four real contract WASMs and the local TESTUSD fixture with Rust 1.99.1; run all four contract unit suites. Build order preserves embedded child bytes.
7. Generate fresh **development-only** proving artifacts on the disposable runner. Run native NEAR and FT demos using actual local NEAR sandbox WASM and Groth16. The FT flow covers API, finalized index, wallet journal, invoices, recipient readiness and evidence. Existing committed public vectors remain unchanged. No proving setup or chain state is cached between runs.
8. Use the successful FT sandbox report to create a sandbox policy, then prepare and verify an exact-source `0.0.0-ci.1` development release. Verify its archive digest and require its three manifest commits to equal the tested source snapshot. The new release must not modify source checkouts.

To update a stale vendored SDK, run `npm run build:client` in Core and `npm run sync:core` in Front, review and commit Front's generated files, then select the matching revisions. Re-running CI cannot repair an incompatible tuple.

## Evidence and failure handling

Actions names each gate. A final summary records each stage's **outcome**, not a success conclusion that might conceal a failed step. Missing, skipped, cancelled or failed gates cannot produce a passed report. Earlier failures stop dependent work. Where Core checkout/ref resolution succeeded, an always-run report captures the completed/failed/not-run stages; failures before that point remain visible in Actions checkout/ref logs.

The seven-day integration artifact allowlist contains the result/source/client/release metadata, verified development release archive, contract WASMs/build manifest and rebuilt browser SDK. Failed browser fixtures retain their Playwright report and traces separately. These diagnostics use sample identities and local test inputs. No `demo-output/` directory, wallet key, note backup, receipt backup, database, journal, environment file or Powers of Tau transcript is uploaded. Avoid broadening uploads to an entire workspace or artifacts directory.

The CI release is an integrity/compatibility regression fixture. Its checksum is generated in the same run; it is **not** an independent trust channel for a distributed release. It is not published and must not replace an existing deployed group's verifier. Local TESTUSD is not Circle-issued USDC. Browser fixtures inject a test wallet and mock API; sandbox demos separately run actual contracts. Neither establishes a funded public-testnet wallet journey or production safety.

## Local reproduction

Use clean sibling `Core/`, `Contract/` and `Front/` checkouts. Install Node 22.16+ (required by the service runtime), pinned Rust/WASM, C/C++ build tools, Python 3 and Chromium's operating-system libraries. First export the exact source revisions, using the checked-out HEADs rather than a branch name:

```sh
export CORE_CI_CORE_SHA="$(git -C Core rev-parse HEAD)"
export CORE_CI_CONTRACT_SHA="$(git -C Contract rev-parse HEAD)"
export CORE_CI_FRONT_SHA="$(git -C Front rev-parse HEAD)"
cd Core
node scripts/integration.mjs refs
node scripts/integration.mjs sources
npm ci
npm ci --prefix ../Contract
npm ci --prefix ../Front
npm run check && npm test
npm run build:sdk
node scripts/integration.mjs client
npm run test:service-runtime
(cd ../Front && npm run check && npm test && npm run build)
(cd ../Front && npx playwright install --with-deps chromium)
(cd ../Front && CI=true npm run test:e2e)
npm run contract:build
npm run build:test-ft --prefix ../Contract
npm test --prefix ../Contract
npm run zk:setup
npm run demo:shared
npm run demo:ft
node scripts/integration.mjs release-input
node scripts/integration.mjs release
```

Local setup reuses an existing matching development setup; CI starts without one. Never force setup replacement for an existing deployment. Release output must be new; an existing `dist/integration/bundle` or archive is deliberately refused. Use a disposable checkout or retain previous evidence elsewhere before another run. Do not infer an Actions success from locally passing commands: remote checkout permissions, runner dependencies and the service Docker build still need their own observed run.

If another local service occupies port 3000, set `CORE_E2E_PORT` for the Front browser command. CI deliberately refuses to reuse a pre-existing server.
