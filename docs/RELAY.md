# Noncustodial proof relay

[Privacy model](PRIVACY.md) · [Wallet execution](WALLET.md) · [Deployment](DEPLOYMENT.md) · [Privacy baseline](PRIVACY_BASELINE.md)

Core now provides an optional, separately operated **withdrawal and recovery sponsor**. A note holder submits only a public Groth16 withdrawal proof and its bound destination. The sponsor signs with its own dedicated account and pays gas, action storage and the additive withdrawal protocol fee. Principal stays in keyless vaults and goes directly to the proof-bound recipient. The relay never receives a user's signing key, note secret/nullifier witness, password or principal custody.

The existing contracts remain unchanged: their proof context binds network, registry, token/denomination, payout vault, recipient and disclosure root; their global nullifier permits one spend. Users may choose a compatible relay or use the existing direct withdrawal/recovery path. Relay availability does not grant custody or the power to redirect a payout.

## Observed validation — 2026-11-14

The compiled Node service ran over loopback HTTP against the **actual public NEAR testnet**:

- A separate sponsor, `r4.core14-0574c4-ebed76bb2c.testnet`, paid for a **0.1 NEAR** withdrawal. [FINAL sponsored transaction](https://testnet.nearblocks.io/txns/DoqjRCkQqb5JTv5SDEbafvXBzyBwbkCSP6NAUHN7E9xY).
- Recipient `core14-forest-f2fd1a94fd.testnet` received the entire 0.1 NEAR. The original payer's NEAR balance was unchanged during withdrawal; sponsor balance decreased.
- Recipient, amount and disclosure mutation requests were rejected before signing. Repeating the exact request, including after a real service-process restart, returned the existing operation. Sponsor nonce and balance stayed unchanged after the original execution.
- The same immutable native group from the original qualification was used. All original historical evidence remains pinned to its original snapshot. No contract upgrade or setup replacement was performed.

[Public service/transaction evidence](evidence/relay-native-testnet-2026-11-14.json) · [Independent RPC/intent/balance read-back](evidence/relay-native-reverification-2026-11-14.json) · [Real WASM/Groth16 native and FT sandbox report](evidence/relay-sandbox-2026-11-14.json)

The native preparation and sponsored withdrawal are three real FINAL transactions: create/fund sponsor, deposit the note and sponsored payout. The sender and sponsor are controlled by one test operator, and the sender funded the sponsor's gas reserve. This verifies sponsorship, **not funding unlinkability or effective anonymity**. The public service was local HTTP, not an external HTTPS deployment or browser-wallet acceptance. Public USDC remains separately blocked; the sandbox FT is a **TESTUSD fixture, not Circle-issued USDC**.

The sandbox also verified an actual failed native transfer and explicit recovery to its original destination, with storage only and no second protocol fee. Native contract calls bypassing the service rejected replay and changed-recipient proofs. Both native and FT recipients received full principal while the user balance stayed unchanged during withdrawal.

## Optional delayed delivery

The relay also supports user-selected randomized execution windows, durable waiting/cancellation/expiry, bounded batches of separate transactions and explicit recovery. See [Scheduled delivery](SCHEDULED_DELIVERY.md) for the browser flow, HTTP controls and limits. Genuine historical append roots are accepted after verification against the complete FINAL tree; a new deposit does not require recreating a waiting proof.

## Trust, fees and scope

The relay's only secret is its own dedicated sponsor key. It cannot generate a spend for somebody else's note or change a valid proof's destination/value. Amount is derived from the independently pinned fixed-denomination policy; requests have no editable amount, contract, method, gas or attachment fields. Proofs are verified locally against a verification key whose encoded bytes match the trusted policy before any sponsor nonce is allocated.

The sponsor explicitly funds:

| Operation | Native NEAR group | FT group |
| --- | --- | --- |
| Initial withdrawal | Gas + 0.02 NEAR action storage + 0.15% NEAR protocol fee | Gas + 1 yoctoNEAR + exact 0.15% token protocol fee; prepaid action storage required |
| Recovery | Gas + 0.02 NEAR storage | Gas + 0.02 NEAR storage; no second token protocol fee |
| Principal | Vault → recipient, full denomination | Vault → recipient, full denomination |

This version sponsors costs from operator funds. It does not collect reimbursements, charge a new relay fee or deduct anything from principal. Deposits remain in the existing wallet flow. FT sponsor/recipient/registry/vault registration and sponsor storage credit must be provisioned in advance; the public proof endpoint never forwards arbitrary registration/activation calls or takes user funds to pay them.

A relay observes submitted destinations, public proofs, timing and connection metadata. It may refuse service. A funded relationship between payer and sponsor remains visible. Use independent operators and measurements before making privacy claims.

## Run the separate service

Use Node.js 22.16+ and installed Core dependencies. Core's existing operations API remains read-only and does not gain a signing endpoint. Copy [the relay configuration template](../examples/relay.template.json), review it and supply:

1. An independently pinned native v2 or token-bound v3 policy file and its exact file SHA-256.
2. The matching Groth16 verification-key JSON. The relay needs no proving WASM, zkey or private note.
3. A dedicated sponsor NEAR JSON key file `{account_id, public_key, private_key}`, outside the repository, owned by the process user and mode 0600. The public key must match the secret and have FullAccess on that dedicated sponsor account. Do not use a customer key or a key shared with another writer.
4. A persistent, owner-only SQLite journal path and explicit cumulative sponsorship limits. A new journal must not be substituted after a crash or to forget unresolved attempts.
5. An explicitly selected HTTPS testnet RPC and exact allowed browser origins. Sandbox mode additionally permits HTTP for a local loopback RPC; its chain ID must not be mainnet/testnet. Mainnet is not accepted.

```bash
npm ci
npm run serve:relay -- /secure/relay-config.json
# Or compile once and run without tsx:
npm run build:service
npm run serve:relay:compiled -- /secure/relay-config.json
```

The service binds to `127.0.0.1` by default and by configuration. External hosting requires a separately configured HTTPS reverse proxy; it is not provisioned by this command. Startup rejects mismatched policy/verifier/key/journal identity. No key is returned by the API or stored in the job journal. Use one durable journal and one active writer set per dedicated sponsor key.

## Prepare and submit a public request

Generate the proof locally, including the original vault/recipient/disclosure context. Save only public withdrawal arguments `{vault, recipient, disclosure_root, proof, public_inputs}`. Then:

```bash
npm run relay:request -- /secure/policy.json POLICY_FILE_SHA256 \
  /path/public-withdrawal-args.json /path/new-relay-request.json
curl --fail-with-body http://127.0.0.1:3003/v1/relay/requests \
  -H 'Content-Type: application/json' \
  --data-binary @/path/new-relay-request.json
```

`core-relay-withdrawal-v1` includes the canonical `policyHash`, vault, recipient, disclosure root and five public inputs/256-byte proof. Unknown/private fields are rejected. The request helper creates a mode-0600 file exclusively and never overwrites an existing backup. The server verifies the proof and trusted group/vault/code/key bindings, unspent nullifier, liquidity and FT prerequisites.

Admission accepts the current root or a historical append root reconstructed from the complete commitment list verified against the current FINAL tree. A queued proof can survive new deposits. Arbitrary roots are rejected. A failed preflight does not spend the note; queued reservations retain the original payload for explicit recovery. The underlying contract's root-history behavior is unchanged.

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | Process liveness; not a settlement or public-hosting claim |
| `GET /v1/relay/config` | Public policy hash, sponsor and limits; establish policy trust independently |
| `POST /v1/relay/requests` | Verify and submit one new proof-authorized withdrawal, or return its existing state |
| `GET /v1/relay/requests/:id` | Fresh bound settlement observation and execution hashes |
| `POST /v1/relay/requests/:id/reconcile` with `{}` | Read the original hashes; never broadcast or generate a new nonce |
| `POST /v1/relay/requests/:id/retry` with `{"expectedAttempt":1}` | Explicit recovery only if the observer permits it for that original bound payout/attempt |

HTTP success, a FINAL outer transaction and payout completion are different facts. Always inspect `settlement.complete`/the bound contract state. Pending/unknown responses remain unresolved and do not trigger an automatic second payment.

## Replay protection and recovery

The SQLite journal stores canonical request IDs, a unique nullifier, immutable call bytes and one execution per original/recovery sequence. Exact duplicates return the same operation. A different payload/proof for a reserved nullifier is a conflict, even if an owner could produce another valid context proof. Concurrent requests and process restarts cannot allocate another dispatch for the existing execution.

Before signing, the service persists the exact unsigned transaction and its hash; before broadcasting it persists the submitted state. An exception, timeout or lost response remains unresolved. No automatic nonce refresh or rebroadcast occurs. Reconciliation verifies the original signed hash, sponsor/key/nonce, single exact call and observed FINAL receipts. Unknown execution blocks new sponsor signing until reconciled. A crash before a durable hash exists needs operator investigation; the service does not provide an unsafe reset.

Recovery takes the saved nullifier and the observer's exact original vault/recipient/root. It never accepts a replacement destination/amount or charges another token fee. Each `expectedAttempt` can produce at most one local execution; retry count and sponsorship budgets are bounded. The contract's global nullifier/reservation and payout state protect against replay through a different relay or direct call. Cross-relay races may still consume an unsuccessful sender's gas; they do not authorize a second principal payout.

Limits reserve the full configured gas-price ceiling times gas plus attachments, and token fees separately, cumulatively across restarts. Unused gas/storage refunds are not credited back into the reservation budget. Gas-price checks are admission/dispatch observations, not a protocol-enforced maximum gas price; actual protocol charging/refunds remain external. Account provisioning/prepayment costs are outside the execution journal budget. Fund and isolate the sponsor accordingly.

The journal identity binds policy, sponsor, public key and limits. Do not restore a stale journal or run separate journals for the same key to bypass its history; preserve unresolved original hashes and audit all writes before recovery. The keyless protocol remains usable through its direct recovery path independently of a particular relay.

## Local verification

```bash
npm run check
npm test
npm run test:relay-sandbox
```

The sandbox runs actual NEAR WASM and Groth16, keyless registry/vault checks, separate sponsor balances, full-principal payout, mutation/replay rejection and native failure recovery. Unit coverage includes duplicate concurrency, durable restart/lost-response reconciliation, fixed-call allowlisting, budgets, proof/key rejection and HTTP origin/schema checks. Public testnet evidence is distinct from the local FT fixture and from the earlier native CLI/browser demonstrations. Production setup/security review, public HTTPS operation, real browser wallet/USDC qualification and privacy efficacy remain separate gates.

Recorded local checks for this update: Core types and **549 tests** passed; the compiled service build and targeted relay/integration checks passed. CLI smoke checks reproduced the public request ID, enforced mode 0600 and overwrite refusal, and rejected an insecure sponsor-key file without revealing its contents or creating a journal. The native public report was independently re-read for three FINAL signed transactions, exact sponsored call bytes, historical balances, code/key bindings, original payout destination/amount and a single sponsor nonce increase. Hosted GitHub Actions success was not observed here.
