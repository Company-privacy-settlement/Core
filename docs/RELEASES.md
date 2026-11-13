# Versioned contract, SDK and policy releases

[Service overview](SERVICE.md) · [Roadmap](ROADMAP.md) · [Contract builds](https://github.com/Company-privacy-settlement/Contract)

A release joins exact Core, Contract and Front source commits with the rebuilt contract WASM, Node/browser SDK, existing proving artifacts, group policies and API origins. The directory and normalized tar archive have independently verifiable hashes. Preparation is local: it does not deploy, transfer funds, remove keys, publish a GitHub release or perform chain-readiness checks.

The current format accepts **sandbox/testnet only** and always carries `UNSAFE_LOCAL_DEVELOPMENT_ONLY` and `chainVerification: not_performed`. A successful integrity check is not a production audit, reviewed multi-party setup, token endorsement or proof of a keyless funded deployment.

## Inputs

Check out Core, Contract and Front as siblings. `CORE_CONTRACT_REPO` and `CORE_FRONT_REPO` can override the sibling paths. Install each repository’s locked dependencies with `npm ci`. Use Node.js 22.13+, Contract’s pinned Rust/WASM toolchain, C/C++ build tools and GNU tar. The three checkouts must be clean, with all release inputs committed. Ignored build artifacts do not count as source changes.

Create the development proving artifacts separately with Core’s existing `npm run zk:setup` if they do not exist. **Do not rerun setup to update an existing group:** a new setup changes its verifier and requires new deployment/policy; existing notes keep their original group. Release preparation never replaces the ceremony.

Copy [the release template](../examples/release.template.json) and supply actual reviewed policies. The bundled USDC policy template deliberately has unusable hash placeholders and cannot create a valid release as-is.

```json
{
  "format": "core-release-input-v1",
  "version": "0.1.0-demo.1",
  "network": "testnet",
  "groups": [
    {
      "id": "merchant-usdc",
      "policyFile": "./trusted-policy.json",
      "apiOrigin": "https://core-api.example",
      "depositsEnabled": true
    }
  ]
}
```

`policyFile` resolves relative to the config file, not the shell’s working directory. The output path resolves relative to the shell. Use a fresh version/output directory, preferably Core’s ignored `dist/releases/<version>` or a directory outside the checkouts. Never place a release over a source checkout.

The input schema rejects extra fields and private-key/password inputs. Each of at most eight groups must have a unique ID/registry, use the release network, and match this release’s forest, shared-vault and serialized verifier hashes. The token account, denomination and fixed fee recipient remain explicit policy values. FT denominations whose 15 bps fee rounds to zero are rejected. Native NEAR and FT policies may coexist in one release, but this does not turn them into one approved group directory or shared privacy domain.

API addresses are exact HTTPS origins, without credentials, paths, query strings or fragments; loopback HTTP is allowed for local development. No API/RPC is queried and no policy is inferred from an API response.

## Prepare

From Core:

```sh
npm run release:prepare -- /absolute/path/release.json dist/releases/0.1.0-demo.1
```

Preparation performs these checks:

1. Pin clean Core/Contract/Front commits and package versions. Copy allowlisted build inputs and compare them with Git blobs, including changes hidden from ordinary status by index flags.
2. Rebuild Contract WASM and Node/browser SDK from the selected checkouts. Preserve the existing `build:client` compatibility path; `build:sdk` also emits Node ESM and declarations.
3. Recompile the current circuit and match the R1CS/witness WASM against existing setup files. Export the verification key from the existing zkey and compare its contents with the pinned key JSON. These checks establish local artifact linkage; they do not review ceremony entropy or replace a full ceremony/transcript audit.
4. Validate contract/proving manifests, embedded-child manifest hashes, browser source/file hashes and Front’s exact vendored SDK. Front must be synchronized and committed before preparing a release; the tool does not silently update it.
5. Bind policy verifier hashes to the **832 serialized NEAR verifier bytes**, not the verification-key JSON checksum. Bind registry/vault hashes to the released WASM and retain all public policy values.
6. Build a closed public-file inventory, verify the completed temporary directory, and publish it to a new output path. Refuse existing output/archive paths and symbolic links. Private notes, receipt backups, journals, `.env`, wallet keys, business documents and sandbox reports are not copied.
7. Create `<output-directory>.tar.gz` with sorted names, normalized permissions/ownership and a timestamp derived from pinned commits. Identical inputs/toolchain/metadata produce the same bundle; different source commits or platforms/tool versions may change its hashes. The release SemVer is independent of each repository’s package version; both are recorded.

The final JSON prints `directory`, `version`, `manifestSha256`, `archive`, `archiveSha256`, `safety` and `chainVerification`. Build output goes to stderr. Retain the hashes through an authenticated channel independent of the downloaded package/API. A checksum only delivered beside an attacker-substituted archive is not a trust anchor.

If archive creation fails after directory publication, the already verified directory is preserved and the command fails. Do not overwrite that directory to retry; inspect it and choose a new output path. No public version or Git tag is created automatically.

## Bundle layout

```text
release.json                     # version, commits, package versions, toolchain, groups, inventory
README.md                        # safety and consumption instructions
artifacts/
  build-manifest.json            # four contract WASM hashes and embedded-child manifest bindings
  core_*.wasm
  manifest.json                  # original development proving manifest
  spend.r1cs
  spend_js/spend.wasm
  spend.zkey
  verification_key.json
sdk/
  package.json                   # Node/browser exports; original SDK package version/dependencies
  package-lock.json
  node/                          # Node ESM modules and declarations
  client/                        # standalone browser ESM, declarations and original manifest
policies/<group-id>.json          # full validated public policies
sources/Core/...                 # allowlisted SDK/build inputs and license notices
sources/Contract/...             # contracts/circuit/build inputs and lockfiles
sources/Front/...                # package inputs and exact vendored client; no site export
```

The archive is a distribution of these files, not an npm registry publication or a hosted frontend. It does not include dependencies/node_modules or the complete CLI/API server application. Use the pinned Core checkout for the CLI/API; use `sdk/` for the emitted SDK.

## Verify and consume

Verify the archive SHA-256 obtained independently before extracting into an empty directory. Never execute files from an unverified archive. The directory verifier does not extract archives.

```sh
# Compare this output with the independently received archive digest first.
sha256sum /path/core-release.tar.gz
mkdir /path/empty-release
tar -xzf /path/core-release.tar.gz -C /path/empty-release

# EXPECTED_MANIFEST_SHA256 must come from an independent authenticated source.
npm run release:verify -- /path/empty-release EXPECTED_MANIFEST_SHA256
```

The expected manifest digest is mandatory: the verifier cannot promote the file’s own checksum to trust. It checks the exact inventory, file sizes/hashes, schemas, policy/artifact bindings, source hashes, Node outputs and Front/browser consistency without network access. Changed/missing/extra files and symbolic links fail. SHA-256 authenticates contents only to the extent that the expected digest is trusted; signing-key management and independent release distribution remain operational decisions.

Use the pinned Core version containing this format’s verifier. For SDK consumers:

```sh
cd /path/empty-release/sdk
npm ci --omit=dev
node --input-type=module -e "import { quoteFees } from './node/core.js'; console.log(quoteFees('1000000'))"
```

The package exports the Node core at the root, browser APIs at `/client` and Node modules such as `/shared`, `/ft` and `/indexer/store`. Browser `client/index.js` has no Node/runtime dependency imports. Pass the bundle’s explicit `artifacts` directory to proving APIs; their existing default remains relative to the process working directory. Full SDK installation retains the recorded dependency lock and does not imply offline installation of those dependencies.

Before a wallet payment, still obtain the relevant policy independently and run the existing finalized deployment/preflight checks. A manifest does not establish account activation, token registration, empty access keys, available vault liquidity, remaining group capacity, index freshness or public checkout access. These belong to R02–R06.

Retain old releases for old notes. Packaging current artifacts does not upgrade immutable groups, migrate private notes, merge group privacy sets or change invoice reference semantics. A current release refuses old policies whose code/verifier hashes do not match; use their original release for recovery.

## Validation

The release change passed Core type checking and **203 tests**, including 11 release regressions for independent trust anchors, tampering/inventory, policy/serialized-verifier binding, stale SDKs, source provenance hidden by Git index flags, symlinks and CLI scope. Node/browser SDK builds are checked separately; the Core CI now includes `build:sdk`. Existing invoice HTTP tests use a fixed clock aligned with their dated fixtures. Actual funded-wallet deployment remains a separate release gate.
