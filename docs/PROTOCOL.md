# Core v1 wire protocol

## Statement

All circuit values are canonical decimal encodings in BN254 Fr:

`r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.

`H2`, `H3` are circomlib Poseidon over two/three inputs. The contract uses light-poseidon with the same mathematical t=3 parameters. `poseidon-t3.bin` contains 195 round constants followed by the 3×3 MDS matrix as 32-byte little-endian canonical Fr values. Regenerate with `node scripts/export-poseidon.mjs` and check cross-language roots against the committed vectors.

```text
domain       = sha253("core:v1|" + network + "|" + account + "|" + denomination)
commitment   = H3(secret, nullifier, domain)
nullifierHash = H2(nullifier, domain)
contextHash  = sha253("core:action:v1|" + domain + "|" + kind + "|" + target + "|" + disclosureRoot)
authorization = H2(nullifier, contextHash)
```

`sha253` hashes UTF-8 with SHA-256, clears the three high bits of the first byte, then interprets the result as a big-endian integer. Every string shown uses its canonical decimal/NEAR-account/lowercase-hex representation. `kind` is `transfer` or `withdraw`; target is the output commitment or recipient account ID respectively.

The circuit proves that `commitment` is a leaf under `root`, derives the unique nullifier and binds the spend context. The 8 path-index inputs are constrained to bits. Authorization is a public Poseidon output that makes the context a constrained input even though the circuit does not parse the external action.

Public inputs, in exact order:

1. `nullifierHash`
2. `authorization`
3. `root`
4. `contextHash`
5. `domain`

The contract checks historical root membership, pinned domain, recomputed action context, unused nullifier, and the Groth16 equation. The fixed denomination makes value conservation one-note-in/one-note-out; a transfer keeps outstanding liabilities unchanged. Withdrawals consume a note, create a pending public payout, and decrement liabilities only after transfer success. Failure permanently preserves the nullifier and permits retries only to the originally proven recipient.

## Add-on settlement fees

Both deposit and withdrawal protocol fees are fixed at 15 bps (0.15%): `floor(denomination × 15 / 10,000)` in integer yoctoNEAR. Fees are paid on top of the principal. Deposit attaches `denomination + deposit_fee + storage_fee`; withdrawal attaches `withdrawal_fee + storage_fee` and still transfers the full denomination to its proven recipient. Transfers/retries attach storage only. No circuit or note commitment changes are needed because the private note always represents the full fixed denomination.

Deposit fees accrue immediately. Withdrawal fees enter a pending ledger and accrue only on successful payout; retries reuse the paid protocol fee. The vault reserves principal, pending withdrawal fees, earned fees, any fee transfer in flight, and storage stake before sending money. Permissionless `collect_protocol_fees` sends only earned fees to the immutable initialization-time recipient. Its callback restores accrued fees on transfer failure and rejects duplicate settlement. There is no fee-recipient setter or principal withdrawal privilege.

The `fee_recipient` constructor argument and additional state fields require a new deployment. Fee policy is pinned by vault bytecode and checked in factory discovery, including full-principal payout quotes.

## BN254 encoding

The proof is base64 of raw `A(G1,64) || B(G2,128) || C(G1,64)`. The pinned verification key is `alpha(G1) || beta(G2) || gamma(G2) || delta(G2) || IC[0..6](G1)`, 832 bytes. All Fq coordinates are 32-byte little-endian; G2 is `(x.c0,x.c1,y.c0,y.c1)`, matching snarkjs object order. No Borsh vector headers are included. Host functions reject invalid curve points. Noncanonical coordinate encodings and empty proof points are rejected before host calls.

Verification uses NEAR's `alt_bn128_g1_multiexp` and `alt_bn128_pairing_check` host functions:

```text
acc = IC[0] + Σ public[i]·IC[i+1]
e(-A,B) · e(alpha,beta) · e(acc,gamma) · e(C,delta) = 1
```

Reference: [NEAR host environment](https://docs.rs/near-sdk/5.30.1/near_sdk/env/), [NEAR host decoding implementation](https://github.com/near/nearcore/blob/master/runtime/near-vm-runner/src/logic/alt_bn128.rs).

## Receipts

The ordered fields are `sender, recipient, asset, amount, purpose, reference, occurredAt, credentialHash`. Each gets an independent 32-byte random salt.

```text
leaf = SHA256(JSON.stringify(["core:receipt:v1", fieldName, value, salt]))
node = SHA256("core:receipt:node:v1|" + leftHex + "|" + rightHex)
```

Eight leaves form a depth-3 binary tree. The root is passed to the contract and bound into each action proof; a disclosed field carries its salt and three sibling hashes. Record fields are integrity commitments to claims, not circuit-checked tax facts. Use fresh independent receipt roots for each operation to avoid linking private actions.

## Evidence and KYB

Contract journal records store an index, event kind, output commitment / nullifier / public recipient, receipt root, block height and decimal-string nanosecond timestamp. They do not store transaction hashes because a contract cannot read its enclosing transaction hash. Clients collect TX hash + signer + record index from the execution outcome.

New records also carry canonical string `amount`, `protocol_fee_charged`, `protocol_fee_earned`, and `storage_fee_charged`. A withdrawal request records the paid fee; its success records the earned fee with zero newly charged fee. Retries record zero protocol fee. Evidence fingerprints bind all four fields and summarize charged/earned amounts separately, avoiding double counting. Legacy records with none of the four fields remain readable and have no fee summary; partial fee fields are rejected. Fee collection emits separate events and does not alter the settlement journal indexes.

Evidence verification requires final execution, matching transaction identity, matching contract receipt executor, successful receipt status, matching `core_privacy` event, current journal record, and valid selected receipt openings. A final top-level transaction may succeed even when a nested payout fails; only a `withdrawal_succeeded` record or `Complete` payout establishes disbursement. `selected_transactions` deliberately makes no full-history or provenance-link claim.

KYB messages are Ed25519 signatures over the ordered canonical array built in `sdk/kyb.ts`. Issuer keys are pinned by the relying enterprise. Credentials bind a specific recipient note commitment, hashed business identity, jurisdiction, completed checks, timestamps and nonce. Credential signatures do not grant spending authority. Attach the credential hash to an independently salted receipt field and share the actual credential only with the intended verifier.

## Setup and versioning

Setup artifacts are ignored by Git; manifest SHA-256 hashes bind R1CS, witness WASM, proving key and verification key. Any circuit/setup change requires a new pinned verifier and a new pool. A setup manifest must only be written after successful key validation. This development ceremony is a single-machine setup, not a distributed trusted setup.

The contract has no migration or key-rotation entrypoint. Larger trees, FT support, split/merge and private credential eligibility require explicitly versioned pools and new tests.
