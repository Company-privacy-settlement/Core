# Core — private business settlement on NEAR

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Private business settlement on NEAR: independent vaults hold principal, shared zero-knowledge notes authorize payouts, and selective evidence supports reconciliation.

Core is the SDK, API, finalized indexer and enterprise workflow repository.

## The idea

Businesses need to pay suppliers, employees and contractors without putting invoice terms and business records on-chain. Core combines signed payment requests, local proofs and reviewable evidence while keeping custody distributed across vaults.

[Hackathon guide](https://github.com/Company-privacy-settlement/Core/blob/main/docs/HACKATHON.md) · [Web Docs](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/) · [Core](https://github.com/Company-privacy-settlement/Core) · [Contract](https://github.com/Company-privacy-settlement/Contract) · [Front](https://github.com/Company-privacy-settlement/Front)

## Watch the demo

[![Core — English narrated hackathon demo](docs/assets/hackathon-demo-poster.png)](https://github.com/Company-privacy-settlement/Front/blob/main/public/media/core-hackathon-demo-en.mp4)

[Watch English MP4](https://github.com/Company-privacy-settlement/Front/blob/main/public/media/core-hackathon-demo-en.mp4) · [Captions, transcript & chapters](https://github.com/Company-privacy-settlement/Front/blob/main/docs/HACKATHON_DEMO.md) · [Hosted video player](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/media/)

English narration, captions and actual application screens. Browser segments use labelled wallet/API fixtures and real local proof generation. A separate section shows the recorded native NEAR public-testnet run.

Repository and Site access follow their existing permissions. Demo media is stored in Front; reviewers need Front access, or the downloadable video bundle. No sharing permissions are changed by this submission.

## What is built

| Capability | Implementation |
| --- | --- |
| Settlement | Native NEAR v2 and token-bound NEP-141/USDC v3; shared nullifiers and distributed principal. |
| Local proving | Groth16 note creation/spending, browser proving support and selective-disclosure receipts. |
| Operations | Read-only API, finalized SQLite indexer, service supervision, deployment/release tools and recovery. |
| Enterprise | Organizations/RBAC, encrypted invoices, separate payment approval, batch payouts and signed webhooks. |
| Preparation | KYB connector and dated US/Abu Dhabi rule components; cited drafts with immutable independent review. |

## Run locally

Node.js 22.16+; no wallet key is needed for types, tests or SDK builds. The API/indexer and Organization API are separate services. Configure a reviewed policy/RPC and protected storage before running them; see the hosting guides.

```bash
npm ci
npm run check
npm test
npm run build:sdk
```

```bash
# Read-only verification of the recorded real testnet run; no wallet key needed.
npm run testnet:verify-wallet -- docs/evidence/testnet-wallet-2026-11-14.json \
  e009bd0f600b23e0fabe30064ee3211446682946126d1b341aace34b5981a681 \
  /tmp/core-wallet-verification-new.json
```

## Real testnet evidence

**14 actual public-testnet transactions reached FINAL** on 2026-11-14: deploy/seal, two 0.1 NEAR deposits, payouts and an actual missing-recipient failure recovered to the original destination. Both recipients received the full 0.1 NEAR; retry charged no second protocol fee. Registry and both vaults were keyless. A separate read-only verifier checked receipts, signatures, historical before/after balances and 0.0006 NEAR collected protocol fees.

[Testnet run and transaction links](https://github.com/Company-privacy-settlement/Core/blob/main/docs/TESTNET_WALLET.md) · [Public evidence](https://github.com/Company-privacy-settlement/Core/blob/main/docs/evidence/testnet-wallet-2026-11-14.json)

The recorded native-wallet gate passed **513 Core tests**, SDK/type builds and compiled service restart/backup/recovery. The browser-USDC preparatory update passed **520 Core tests** and type checking; its actual funding report remains blocked. Browser fixtures, funding preflight and public settlement execution are separate evidence categories.

## Architecture and fees

```mermaid
flowchart LR
    P["Payer"] --> A["Independent vault A"]
    P --> B["Independent vault B"]
    A -. "shared commitments / nullifiers" .-> Z["NEAR ZK registry"]
    B -. "shared commitments / nullifiers" .-> Z
    Z -. "authorize one funded payout" .-> B
    B --> R["Recipient: full principal"]
```

Deposit and withdrawal each add **0.15%**. The recipient receives the full principal. NEAR action storage, registration, activation and network gas are separate.

The ZK statement hides which input note is spent. Signers, recipients, timing, fixed amounts, vaults and funding edges remain public. This single-payer run does not establish effective anonymity. There is no cover-traffic scheduler; a group currently supports 256 total outputs.

## Scope and next steps

**Hackathon / development prototype.** The setup is `UNSAFE_LOCAL_DEVELOPMENT_ONLY`. Public-testnet qualification covers native NEAR with a local Ed25519 software wallet. Real browser-wallet/USDC execution, hosted API HTTPS acceptance, observed remote Actions success and production security review remain open.

Next priorities: noncustodial relaying, optional randomized delay/batching, privacy measurements, then budgeted cover-traffic experiments. Live KYB/AI providers, professional rule approval and statutory filing require separate qualification.

## Explore the project

[Browser USDC qualification](https://github.com/Company-privacy-settlement/Core/blob/main/docs/BROWSER_USDC_TESTNET.md) · [Service](https://github.com/Company-privacy-settlement/Core/blob/main/docs/SERVICE.md) · [Privacy](https://github.com/Company-privacy-settlement/Core/blob/main/docs/PRIVACY.md) · [Invoices](https://github.com/Company-privacy-settlement/Core/blob/main/docs/INVOICE_PAYMENTS.md) · [Organizations](https://github.com/Company-privacy-settlement/Core/blob/main/docs/ORGANIZATIONS.md) · [Tax drafts](https://github.com/Company-privacy-settlement/Core/blob/main/docs/TAX_DRAFTS.md) · [Deployment](https://github.com/Company-privacy-settlement/Core/blob/main/docs/DEPLOYMENT.md) · [Hosting](https://github.com/Company-privacy-settlement/Core/blob/main/docs/PRODUCTION_HOSTING.md) · [CI](https://github.com/Company-privacy-settlement/Core/blob/main/docs/CI.md) · [Roadmap](https://github.com/Company-privacy-settlement/Core/blob/main/docs/ROADMAP.md)
