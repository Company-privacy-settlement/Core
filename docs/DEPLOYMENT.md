# Testnet deployment scripts and preflight

[Versioned releases](RELEASES.md) · [Service overview](SERVICE.md) · [Roadmap](ROADMAP.md)

The deployment CLI consumes a reviewed v1 release and creates a separate, hash-pinned public plan. It supports testnet native NEAR v2 and FT v3 groups. Planning, preflight and verification are read-only. Execution signs locally and broadcasts through the reviewed plan’s HTTPS RPC; the Core API remains read-only and has no deployer key or broadcast route.

This tooling does not create/fund accounts, deploy a token, set up a production ceremony, remove keys automatically or turn a deployment into a funded payment service. It refuses sandbox/mainnet release inputs. Development setup warnings remain in the release and plan.

## Prepare a reviewed plan

Use a Core checkout with the deployment commands installed (`npm ci`, Node.js 22.13+). Start with a [versioned testnet release](RELEASES.md), its independently received manifest digest, and [deployment input](../examples/deployment.template.json). The earlier sandbox sample release is deliberately rejected by these public-testnet commands.

```sh
npm run deploy:plan -- /path/testnet-release RELEASE_MANIFEST_SHA256 \
  /path/deployment-input.json /path/new-deployment-plan.json
```

The final JSON prints `planSha256`, the new file path and four phases. Retain that digest after reviewing the plan. Existing plan files are not overwritten. The input template has unusable public-key/token-hash placeholders; supply real reviewed values before running it.

Inputs specify the released group ID, exact public Ed25519 deployment key, HTTPS testnet RPC, gas reserve and per-account token registration limit. FT input also requires an independently reviewed SHA-256 of the token’s WASM. Native input omits `tokenCodeSha256` and uses registration limit `0`. Private keys/passwords are not accepted in the public input.

The plan binds the release digest/version, complete policy, RPC, public key, initializer, serialized verifier bytes, denomination, token and fee recipient. It fixes the initializer attachment at **1 NEAR** and function-call gas at **300 Tgas**. Deployment and initialization are two actions in one transaction, signed by the registry account itself. Each command verifies the plan digest, original release digest and reconstructed actions before contacting the RPC.

Use a newly activated registry account of the policy’s exact ID with one matching FullAccess key and no existing code/state or staked balance. Activate the treasury separately. Funding and account creation are deliberate external operations; this CLI never guesses or transfers activation funding.

## Inspect before sending

```sh
npm run deploy:preflight -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release deploy
```

The read-only preflight:

- Requires a synchronized RPC reporting `chain_id: testnet`, a head timestamp within the last 120 seconds (at most 30 seconds in the future), and a finalized snapshot within 10 blocks of the observed head, with the source bound to the planned registry. A testnet label inside a policy alone is insufficient.
- Pins all dependent account, key, configuration, token and cost reads to one finalized block. It uses the current protocol storage-byte cost and gas-price snapshot.
- Requires registry/treasury accounts to exist and exactly one matching Ed25519 FullAccess deployment key. Deploy refuses existing code **or** leftover contract state.
- For FT, verifies the token code hash and NEP-148 metadata, checks NEP-145 storage bounds/registrations, and rejects storage costs above the reviewed per-account limit.
- Checks a conservative native reserve for observed storage, code plus a 65,536-byte initialization allowance, 1 NEAR operational reserve, configured gas reserve and pending token registrations. The gas reserve must cover the observed gas price × 300 Tgas. This is a planning snapshot, not an exact fee quote, a consensus fee cap or a reservation; actual storage, transaction overhead and gas prices may differ.

Inspect returned balances, registrations and `checkedAtBlock`. Every signing phase repeats preflight and rechecks it after signing, immediately before dispatch. No saved preflight report authorizes a later transaction by itself. RPC responses remain a trust dependency; this tool is not a light client.

## Execute explicitly, one phase at a time

Execution requires a local, owner-only key file provided through `CORE_DEPLOY_KEY_FILE`. Its JSON has exactly `account_id`, `public_key` and `private_key`, matching the registry and reviewed public key. Keep it outside repositories/releases and use mode `0600`. The one-shot CLI reads it in memory; it never writes it into plans, reports or journals. Do not configure it on the Core API server or pass a private key in arguments.

```sh
export CORE_DEPLOY_KEY_FILE=/secure/path/registry-key.json

# 1. Atomic DeployContract + new/new_ft. Keep the deployment key.
npm run deploy:execute -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json deploy

# 2. FT only: sponsor exact observed registration minimum, individually.
npm run deploy:execute -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json register-registry
npm run deploy:execute -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json register-treasury

# Inspect initialized code/configuration and registered accounts before the next phase.
npm run deploy:preflight -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release seal
```

Already registered FT accounts cause no new signing or registration transaction. Native NEAR skips both registration phases. Each prerequisite is a distinct reviewed transaction, not an automatic deployment pipeline.

## Separate irreversible key removal

Seal only after reviewing deployed code, immutable configuration, verifier and token registrations. It requires the same sole FullAccess key, no issued notes and no created vaults; create permissionless vaults afterward. Unexpected keys or changed configuration block the step.

```sh
npm run deploy:execute -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json seal \
  --acknowledge-irreversible-key-removal
```

This signs **only DeleteKey** for the planned key; it cannot install a replacement, transfer principal or alter the destination. Removing the last key makes the registry code unupgradeable through access keys. The explicit acknowledgement is required every time this phase is invoked. There is no automatic key-removal step during plan generation, deployment or registration.

No actual public-network key removal is performed merely by implementing/testing these scripts. An operator must deliberately invoke this phase with the matching funded account/key.

## Uncertain results and final failures

Before invoking the signer, the CLI fsyncs a public deployment intent containing the exact unsigned transaction, deterministic hash, phase and plan digest. It snapshots signed bytes and rejects substituted recipients/actions/signatures before broadcast. It never delegates nonce retries or automatic rebroadcast to an SDK account sender.

The journal is separate from browser payment journals and contains no private key or signature. Atomic writes and an exclusive sidecar lock protect concurrent commands. Keep the same journal for the plan and retain it until all hashes are reconciled. Up to 16 attempts and 32 MiB are supported. A process crash can leave `<journal>.lock`; inspect the original process/transaction before removing a genuinely stale lock. Locks are never automatically broken.

```sh
npm run deploy:reconcile -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json
```

A timeout, interrupted signer or unknown transaction remains unresolved and blocks all new signing in that journal. Reconciliation queries the original hash/signer; it never sends anything. Final observations must match the exact signer, key, nonce, block hash, receiver and actions, plus complete final execution outcomes. NEAR’s DeployContract view contains a base64-encoded code hash, which is matched against the planned WASM. Its transaction view omits the original block hash: the returned Ed25519 signature is checked against the exact locally recorded unsigned bytes, binding that block hash cryptographically.

Only a matched **FINAL failure** permits another attempt, and only with `--retry-final-failure`. Seal retries also require the irreversible acknowledgement. The old attempt remains in the journal and a new finalized nonce/block produces a new hash. Never clear an unresolved journal or use a different journal to bypass uncertainty. A finalized transaction and current contract postconditions are distinct checks; run final verification even after successful reconciliation.

## Verify sealed deployment

```sh
npm run deploy:verify -- /path/deployment-plan.json PLAN_SHA256 /path/testnet-release
```

Verification requires empty registry access keys, exact WASM/embedded-vault/verifier/domain/fee policy, and FT registration of registry and treasury when applicable. Existing shared-policy validation is reused. This establishes the inspected deployment state at its finalized block, not public checkout access, token balances, vault liquidity, index freshness or production safety. `fundsReady` remains explicitly `false`; vault creation/funding and actual wallet payments belong to R03/R04.

## Local rehearsal and tests

`npm test` includes deployment guards, source/plan bindings, native/FT stages, unknown broadcasts, exact final receipts, explicit failure retries, signer substitution, exclusive journals and key-file handling. Core type checking covers the CLI and manual rehearsal.

For actual local-chain WASM validation, provide an existing trusted release and build the Contract test FT fixture:

```sh
(cd ../Contract && npm run build:test-ft)
export CORE_RELEASE_DIR=/path/verified-release
export CORE_RELEASE_MANIFEST_SHA256=INDEPENDENT_MANIFEST_SHA256
npm run test:deployment-sandbox
```

The test harness alone adapts an isolated local sandbox port to a testnet-labelled policy, runs native/FT atomic deployment, registration, lost-response reconciliation and explicit key removal, and checks the real contracts. The production CLI has no sandbox transport/network override. The public report in `demo-output/deployment-validation.json` explicitly says `publicNetworkDeployed: false`; no keys or sandbox reports enter release packages. This rehearsal does not count as a funded public-testnet wallet run.

Primary RPC references: [NEAR protocol configuration](https://docs.near.org/api/rpc/protocol), [gas price](https://docs.near.org/api/rpc/gas), [transaction finality and status](https://docs.near.org/api/rpc/transactions), [nearcore action views](https://github.com/near/nearcore/blob/master/core/primitives/src/views.rs).

## Recorded validation

On 2026-11-13: Core type checking and **215 tests** passed, along with the Node/browser SDK build. The actual local WASM rehearsal finalized **six deployment transactions** across native and FT groups, verified both registries keyless, and covered a deliberately lost response with hash-bound reconciliation. Public testnet RPC status, finalized block and protocol/gas cost reads were checked separately without signing or broadcasting. CLI smoke checks cover public-plan generation and overwrite, hash, phase, missing-key and read-only reconciliation guards. No funded public-testnet deployment or public-network key removal was performed.

## Recover an exact pre-dispatch intent

`deploy:resume-intent` is an explicit operator action for **one** journal entry still in `intent`. It first checks the original hash's current status. If unresolved, current account nonce must make the recorded nonce exactly next. Both preflight checks, immutable unsigned bytes, original hash and signature are verified. It re-signs the same bytes and dispatches that exact transaction without creating a new nonce, block hash, destination, amount or journal attempt. A pending external copy has the same transaction identity; it cannot become a second transaction through this command.

```sh
npm run deploy:resume-intent -- /path/deployment-plan.json PLAN_SHA256 \
  /path/testnet-release /path/deployment-journal.json seal \
  --acknowledge-exact-original-intent --acknowledge-irreversible-key-removal
```

The separate key-removal acknowledgement is mandatory for seal, including recovery. `submitted` uncertainty cannot use this command and remains read-only reconciliation. Non-next nonces, substituted payloads, multiple unresolved entries and missing acknowledgements are rejected. An expired original cannot be refreshed here. Ordinary execute/reconcile never resubmits an unknown transaction automatically.

Transaction status queries now request the current `NONE` milestone instead of waiting for an absent transaction to finalize. Consumers still require an **observed FINAL** result before accepting it; non-final or unknown status stays pending.

The [2026-11-14 native testnet run](TESTNET_WALLET.md) deployed and sealed a real registry and verified deposits, withdrawals and missing-recipient recovery. It uses a development setup and a CLI software wallet; browser/USDC/HTTPS/production qualification remain separate.
