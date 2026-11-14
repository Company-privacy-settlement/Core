# Public testnet wallet qualification — native NEAR

[Deployment](DEPLOYMENT.md) · [Wallet recovery](WALLET.md) · [Privacy boundaries](PRIVACY.md) · [Live backend hosting](PRODUCTION_HOSTING.md)

On **2026-11-14**, actual funded NEAR testnet accounts executed native deposits, a shared-group payout from a different vault, an actual missing-recipient failure and recovery to the original recipient. **Fourteen signed transactions reached FINAL**: twelve wallet actions plus deployment and key removal. This run used a local Ed25519 software wallet and real public RPC, contracts, WASM and Groth16 proofs. No sandbox or mocked wallet response is counted as public-testnet execution.

Qualification covers **native NEAR and the CLI software-wallet path**. Browser wallet/NEAR Connect interaction, USDC, public HTTPS backend hosting, effective anonymity and production setup safety remain unqualified. The proving setup is explicitly `UNSAFE_LOCAL_DEVELOPMENT_ONLY`; this is a testnet development deployment, not a production release or third-party security audit.

## Deployed group and evidence

- Registry: `c14f-c1b494d1.testnet`.
- Payer: `core14-0574c4-ebed76bb2c.testnet`.
- Ordinary recipient: `core14-forest-f2fd1a94fd.testnet`.
- Recovery recipient: `late.core14-0574c4-ebed76bb2c.testnet`.
- Vault A: `v0bea43bb3832da6145a7d07deb5bca4b.c14f-c1b494d1.testnet`.
- Vault B: `vef1c6d6d5654e7c07536611490443d52.c14f-c1b494d1.testnet`.
- Final verified snapshot: height **277614194**, hash `5UmiAmFiSN6MXRqH7bmw4yk3T8D3umhdjGU5TJqyGEsT`.
- [Public testnet policy](evidence/testnet-native-policy-2026-11-14.json), [transaction and balance evidence](evidence/testnet-wallet-2026-11-14.json), [successful read-only re-verification](evidence/testnet-wallet-reverification-2026-11-14.json).

The public policy is a native group and has no `tokenId`. Front's current connected payment workspace is FT-specific; this policy does not qualify that browser flow as USDC or native-NEAR wallet support. No hosted API origin is claimed: the development release uses a loopback API origin.

The release is `0.1.0-testnet-wallet.1`, manifest digest `6cc972cbb2bf1ee512e5ddc7abca2a043072b56a2192d6baf1137605b77750ce`. Its source tuple is Core `4f606ca7baaaef7b754412105bee728ef1995151`, Contract `a68f38096422b01286ce988c28550310f573c358`, Front `f817e7e74e86d17f0782f38b1e5a8eb526e890a7`. These are the deployment/release sources; later verification/recovery code changes do not change the deployed contract bytecode. Full contract/verifier hashes are retained in the policy.

## Observed transactions

| Step | Public transaction | Result |
| --- | --- | --- |
| Deploy and initialize | [44d1ejin…H2krv5](https://testnet.nearblocks.io/txns/44d1ejinSv6sdAMGEm8jDLQ3B3typdqGs5Di6bH2krv5) | FINAL, pinned code/configuration |
| Seal original intent | [Dm2qXrR8…G2Byjz](https://testnet.nearblocks.io/txns/Dm2qXrR8PbjM88sscJyHopzGnFssM6KxZXis61G2Byjz) | FINAL, same original hash and nonce |
| Deposit A | [H58XhKqP…67ztzi](https://testnet.nearblocks.io/txns/H58XhKqPjkS3rgZdBBUnX8cAXpDYPcekneCbXp67ztzi) | 0.1 NEAR principal, Active |
| Deposit B | [69VVRKHL…zjzvhr](https://testnet.nearblocks.io/txns/69VVRKHLMp3vAenzoUsM4MEiWRcTrZ2gNnwV1pzjzvhr) | 0.1 NEAR principal, Active |
| Ordinary payout from B | [E89i9Khi…gvGgUE](https://testnet.nearblocks.io/txns/E89i9KhiAhcQYBPBdo77pTavdPWpmqXeugsRN3gvGgUE) | Complete; recipient balance +0.1 NEAR |
| Missing-recipient payout | [FwoYLjZx…UWnQF](https://testnet.nearblocks.io/txns/FwoYLjZx6oWMksVFaUP6Dsc1qQ1p6icw9DNifFTUWnQF) | FINAL with an actual AccountDoesNotExist receipt; Retryable |
| Recover original payout | [Y445NDQD…1w19u](https://testnet.nearblocks.io/txns/Y445NDQDRJsEwYGn8yreiv1vcVUKj8wNp27xDH1w19u) | Complete, attempt 2; original recipient +0.1 NEAR |

The payer, registry and ordinary-recipient accounts were created through the official testnet helper and each observed with 10 testnet NEAR. Treasury/recovery child accounts were activated through signed transactions. Keys and encrypted note backups remain outside all three repositories in an owner-only directory; no private keys, passwords or note witnesses appear in the public evidence.

## Amounts, fees and recovery invariants

Each native deposit attached **0.12015 NEAR**: 0.1 principal, 0.00015 protocol fee and 0.02 storage attachment. Each initial withdrawal attached **0.02015 NEAR**: 0.00015 protocol fee and 0.02 storage attachment. Network gas is additional and storage attachment is not a promise about final net storage cost/refunds.

Both recipients received the full **0.1 NEAR**. The failed transfer reserved the original note/nullifier and fee; the recipient was then activated and `retry_withdrawal` used that same nullifier. The original vault, recipient and disclosure root remained unchanged. Retry attached only **0.02 NEAR** storage, with **zero additional protocol fee**. A confirmed Retryable state can retry immediately; the 20-block delay applies to resuming a still-Pending callback.

Deposit and withdrawal fees accrue in their respective vault/registry ledgers. Three explicit collection transactions transferred a total of **0.0006 NEAR** to treasury: two deposit fees and two completed withdrawal fees, each 0.15% added to the principal. Final outstanding notes, pending withdrawal fees and vault reservations were zero. The historical tree retains two outputs. Registry and both vaults had zero access keys at the verified snapshot.

## Read-only public re-verification

The policy file byte SHA-256 is `f6ca5b87c5ae8140f791d84d9464aec60f32f0da58a9cf050b46ad30bd371595`. This digest needs the same independent trust review as other deployment inputs.

No wallet, private key, note or server session is needed:

```bash
npm run testnet:verify-wallet -- docs/evidence/testnet-wallet-2026-11-14.json \
  e009bd0f600b23e0fabe30064ee3211446682946126d1b341aace34b5981a681 \
  /secure/new-wallet-reverification.json
```

Obtain the expected evidence digest through an authenticated independent source. The verifier checks testnet freshness and canonical snapshot, the deployed shared-group code/verifier/key bindings, all fourteen FINAL receipts and signatures, transaction intents where recorded, exact native attachments and recipients, the actual missing-account failure, original recovery identity, historical before-balances, final balances and collected fees. Outputs are exclusively created with mode 0600; malformed/changed evidence, stale/unavailable RPC or failed assertions exit nonzero.

This is RPC-based verification, not a light client. Historical reads require a provider retaining the snapshot; a later unavailable historical snapshot is not silently treated as passed. The executor privately selected the A-origin note for the B payout; public ZK receipts establish group membership and payout acceptance without revealing the private input-note linkage. That specific origin linkage remains an executor declaration.

The original deployment provider returned HTTP 429 with a deprecation notice during the seal's post-signing preflight. After its Retry-After window, explicit recovery completed the exact original transaction. Subsequent wallet operations and independent read-only verification used `https://test.rpc.fastnear.com`, listed in the [official NEAR provider directory](https://docs.near.org/api/rpc/providers). Use an explicitly reviewed RPC for new plans; there is no silent provider switch or automatic rebroadcast of a submitted uncertain transaction.

## Reproducing a new write run

Prepare separate funded testnet accounts and protected local key/backup storage, a reviewed development release and a fresh registry name of at most 30 characters. Use the existing deployment plan/preflight/execute/seal commands. A live registry must be keyless before accepting new notes. Keep mainnet credentials and existing deployment setups outside this run.

Create two vaults, independently verify their code/configuration and empty key lists, and generate/encrypt notes locally. Deposit one note per vault with the exact native quote. Generate the ordinary proof locally for a payout vault in the original shared group. For failure recovery, select a deliberately absent **owned test-recipient name**, retain that proof's original nullifier/vault/recipient/root, observe Retryable, activate that exact recipient and invoke `retry_withdrawal` with storage only. Do not substitute another destination or spend a note from a different group.

Keep durable unsigned transaction intents before signing, use one dispatch per new intent, and reconcile uncertain submitted hashes read-only. Never reset a journal or generate a fresh nonce to hide uncertainty. [Explicit pre-dispatch intent recovery](DEPLOYMENT.md#recover-an-exact-pre-dispatch-intent) is separate and cannot refresh the transaction. Export only allowlisted public references/balances and independently recheck the final snapshot.

## Privacy qualification remains separate

This run has one public payer signing deposits and withdrawals, two notes and two vaults. It establishes functionality and recovery, **not meaningful anonymity**. This initial run did not include automated cover traffic or a measured effective anonymity set. The later [bounded cover experiment](COVER_TRAFFIC.md) is separate; its artificial outputs do not add independent participants. Current addresses and a dated read-only snapshot are in [deployed addresses](DEPLOYED_ADDRESSES.md). See [privacy and cover traffic](PRIVACY.md#participation-and-cover-traffic).

Recorded validation: **513 Core tests**, SDK/type/compiled service restart/backup/recovery gates, real testnet execution and the public read-only verifier passed. Browser-wallet acceptance, USDC funding/settlement, hosted HTTPS and remote Actions success are separate observations and are not inferred from this run.
