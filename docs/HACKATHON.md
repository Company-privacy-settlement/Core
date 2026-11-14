# Core — hackathon guide

Core builds private business settlement on NEAR with distributed principal, shared ZK notes and selectively disclosed evidence. The three repositories separate on-chain custody, service tooling and the English-first app.

## Thirty-second pitch

A supplier signs an invoice. The payer opens an encrypted note, generates a local proof, checks the full amount and added fee, and approves the exact wallet calls. A funded vault pays the recipient; a shared nullifier prevents spending the note twice. Teams can reconcile finalized outcomes and share selected receipt fields with their reviewers.

Private business records need not become public transaction memos. Public transaction metadata still exists: this prototype does not claim effective anonymity.

## Watch and inspect

[![English narrated demo](assets/hackathon-demo-poster.png)](https://github.com/Company-privacy-settlement/Front/blob/main/public/media/core-hackathon-demo-en.mp4)

[English MP4](https://github.com/Company-privacy-settlement/Front/blob/main/public/media/core-hackathon-demo-en.mp4) · [Transcript, subtitles and chapter timing](https://github.com/Company-privacy-settlement/Front/blob/main/docs/HACKATHON_DEMO.md) · [Hosted player](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/media/) · [Web Docs](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/)

The Site retains owner-only access. GitHub links retain repository permissions; give judges access to Front or share the exported media bundle separately. No public accessibility is implied by these links.

| Segment | What the recording establishes |
| --- | --- |
| Product and architecture | Current landing and documentation screens. |
| Invoice checkout | Actual app with a controlled wallet/API fixture; encrypted note selection, a real local Groth16 proof, fee review, two wallet approvals and fixture finality. No public USDC transfer. |
| Tax preparation | Source-bound deterministic outline and submission for independent review in a fixture organization. No live AI call, professional approval or filing. |
| Native testnet | Evidence cards derived from the separately recorded native NEAR CLI/software-wallet run, including actual missing-recipient recovery. These are not browser wallet transactions. |
| Boundaries | Public metadata, development proving setup and the remaining qualification work. |

## Repository map

| Repository | Responsibility | Entry point |
| --- | --- | --- |
| [Core](https://github.com/Company-privacy-settlement/Core) | SDK, proving, API/indexer, enterprise services, release and evidence tooling | [README](../README.md) |
| [Contract](https://github.com/Company-privacy-settlement/Contract) | Native NEAR and token-bound NEP-141 contracts, keyless vaults and verifier | [README](https://github.com/Company-privacy-settlement/Contract/blob/main/README.md) |
| [Front](https://github.com/Company-privacy-settlement/Front) | Next.js landing, docs, invoice checkout, local proofs and organization workspace | [README](https://github.com/Company-privacy-settlement/Front/blob/main/README.md) |

English is the default. Each repository also has Korean and Simplified Chinese README translations. The former interactive demo is not restored: the media player only plays the recorded video.

## Run a reviewer checkout

Use Node.js 22.16+ and `npm ci` in each checkout. For Core:

```bash
npm ci
npm run check
npm test
npm run build:sdk
```

For the UI, follow [Front's local commands](https://github.com/Company-privacy-settlement/Front/blob/main/README.md#run-locally): `npm run dev` starts the app without API keys or sibling repositories. Live operations require separately configured APIs, wallet and independently trusted policy; opening the UI does not provision these services.

For contract builds and local sandbox execution, use [Contract's instructions](https://github.com/Company-privacy-settlement/Contract/blob/main/README.md#run-locally). Generating the development SRS is not a production ceremony.

## Independently verify the public run

The 2026-11-14 run finalized 14 signed transactions, including deployment/sealing and twelve wallet actions. Two 0.1 NEAR deposits were followed by full 0.1 NEAR payouts. A transfer to a missing recipient became Retryable; after activation, retry completed to the original bound destination without charging another protocol fee. Registry and vaults had zero access keys, and outstanding notes ended at zero.

- [Runbook, all transaction links and limitations](TESTNET_WALLET.md)
- [Public run evidence](evidence/testnet-wallet-2026-11-14.json)
- [Independent read-only reverification](evidence/testnet-wallet-reverification-2026-11-14.json)
- [Native testnet policy](evidence/testnet-native-policy-2026-11-14.json)

After `npm ci`, re-query public chain data without wallet credentials:

```bash
npm run testnet:verify-wallet -- \
  docs/evidence/testnet-wallet-2026-11-14.json \
  e009bd0f600b23e0fabe30064ee3211446682946126d1b341aace34b5981a681 \
  /tmp/core-hackathon-reverification.json
```

The original run used `0.1.0-testnet-wallet.1`, with Core `4f606ca7baaaef7b754412105bee728ef1995151`, Contract `a68f38096422b01286ce988c28550310f573c358` and Front `f817e7e74e86d17f0782f38b1e5a8eb526e890a7`. Documentation/media revisions do not change those deployment sources. The original run used a local Ed25519 software wallet, native NEAR and development proving material.

Recorded engineering gates include 513 Core tests, SDK/type builds and compiled service restart/backup/restore. The 256-case browser fixture regression is a separate recorded gate; it is not public wallet evidence or a claim that every case was rerun for the media update.

## Custody, fees and privacy

Vaults keep principal separately. The registry shares commitments and nullifiers, checks the ZK spend and authorizes a funded payout. There is no required A → B → C chain of principal transfers. Sharing notes across vaults expands the possible input-note set without automatically creating independent participants.

Deposit and withdrawal each add 0.15% to the amount rather than reducing the recipient's principal. NEAR storage, activation, registration and network gas are separate. The recorded run collected 0.0006 NEAR of protocol fees; the recovery did not add a second protocol fee.

The current group holds 256 total outputs. The public single-payer run reveals signers, funding edges, timing, recipients and amounts. No cover-traffic scheduler is implemented. Next privacy work is noncustodial relaying, optional randomized delay/batching and measurement of independent participation and metadata leakage before any budgeted cover-traffic experiment. See [Privacy](PRIVACY.md#participation-and-cover-traffic).

## Qualification still open

- Real browser wallet and public USDC execution; the native policy must not be reused as an FT browser policy.
- Hosted API/indexer/organization API HTTPS acceptance after server and domain setup.
- Observed GitHub Actions success for the pinned three-repository integration; local checks do not substitute for a remote run.
- Live KYB/AI provider qualification, reviewed jurisdiction rules and professional approval. Drafts are preparation artifacts, not filings or payment authority.
- Production SRS, independent security review, operational readiness and meaningful anonymity measurement.

[Service](SERVICE.md) · [Roadmap](ROADMAP.md) · [Deployment](DEPLOYMENT.md) · [Hosting](PRODUCTION_HOSTING.md) · [CI](CI.md)

## Submission validation — 2026-11-14

For this documentation/media update, Front's production static export, TypeScript check and three unit tests passed. The ten existing Docs browser checks passed across desktop/mobile Chromium. The browser media check verified playback advancement, all twelve chapter controls, a seek into recovery, English VTT loading, download responses and no horizontal overflow on desktop/mobile. [Media browser report](https://github.com/Company-privacy-settlement/Front/blob/main/docs/evidence/hackathon-media-2026-11-14.json).

The media verifier checked four SHA-256/size entries, SRT/VTT timing, chapter coverage, H.264/AAC at 1600 × 900/24 fps, full video/audio decode and the original native-evidence hash. Exported media matches the source files byte for byte. README translations, repository links and Markdown anchors passed the local documentation checker; web links are subject to the existing repository/Site access controls. These are local submission checks, not observed remote Actions or live backend qualification.
