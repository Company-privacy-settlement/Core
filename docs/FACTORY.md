# Permissionless keyless vault factory

This document specifies the retained **v1 independent factory**. Paths and build artifacts are relative to [Contract](https://github.com/Company-privacy-settlement/Contract). Shared v2/v3 groups use the [forest specification](https://github.com/Company-privacy-settlement/Contract/blob/main/docs/SHARED.md); see the [service overview](https://github.com/Company-privacy-settlement/Core/blob/main/docs/SERVICE.md) for current integration. Networking and SDK helpers live in Core.

`contracts/factory` embeds the optimized vault WASM. Its constructor pins the network label, denomination, verification key and fee recipient. Each child inherits the same fixed recipient and the 0.15% deposit/withdrawal add-on fee policy. There are no setters, arbitrary calls into children, key-installation methods or admin withdrawals.

Deploy `artifacts/core_factory.wasm` to an account ID of at most 30 characters, fund its code storage, then initialize `new(network, denomination, verification_key, fee_recipient)` from that account with at least 1 NEAR. `init-args` generates the same constructor arguments as for the pool. A factory deployer can replace its code while keys remain; the SDK requires empty key lists for both factory and vault. Key removal on public networks is not automated.

## API

| Method | Inputs | Deposit |
| --- | --- | --- |
| `get_config` | none | none |
| `predict_vault` | `creator`, 64-character lowercase hex `salt` | none |
| `create_vault` | `salt` | exact `creation_deposit` from config; use 300 Tgas |
| `get_vault` | `account_id` | none |
| `list_vaults` | `from_index`, `limit` (up to 50) | none |
| `get_refund` | `creator` | none |
| `claim_refund` | none; refunds caller only | 1 yoctoNEAR |

Address: `v{SHA256("core:vault:v1|" + creator + "|" + salt)[0:32]}.{factory}`. `creator` is the caller, so another user cannot front-run the same salt into the same address. A registry address is reserved once requested; use a new salt after failure.

Each child batch atomically creates the account, transfers funding, deploys pinned code and calls `new_from_factory`. That initializer accepts only the direct parent and cannot reinitialize state. No child access key is added. A private callback changes registry state from `Pending` to `Ready` or `Failed`.

Forwarded funding is `(vault WASM bytes + 65,536) × storage byte cost + 1 NEAR`; query the live quote. An additional 0.05 NEAR stays in the factory as registry storage reserve, including on failure. Successful creation funding covers the vault's code/state reserve; it is not a shielded note and is not redeemable by the creator. Settlement principal must go directly to `vault.deposit`.

## Failure recovery

A failed child batch credits the forwarded funding to its original creator. Automatic protocol refunds can arrive after the callback, so the creator pulls the credit with `claim_refund`. The solvency guard may require retrying after pending protocol refunds settle. A failed refund transfer restores the credit. In-flight claims cannot be duplicated or redirected, and callbacks cannot settle one operation twice.

The sandbox demo deliberately occupies a predicted child, observes the actual creation failure, rejects another user's refund claim, and verifies the creator's refund. It then removes its disposable factory key and proves an ordinary user can still deploy a keyless vault. Public-network keys are not touched.

## Verified discovery

Fill `examples/factory-policy.json` using independently trusted artifacts: factory WASM SHA-256, vault WASM SHA-256, verifier SHA-256, network, denomination and `feeRecipient`. `artifacts/build-manifest.json` contains both code hashes. The verifier hash is SHA-256 of the decoded base64 verification key, not its JSON file. Copying a hash from an untrusted factory does not establish trust. Discovery also verifies fee rates, add-on deposit/withdrawal amounts, full recipient payout, and the fixed fee recipient. Protocol fees are collected from vaults directly; the factory's creation/refund budgets are separate.

`discoverVaults` pins one finalized block for all reads. It verifies factory bytecode, configuration and empty access key list; complete registry pages; `Ready` status and direct-child addresses; and each child's bytecode, empty keys, denomination, verifier, note domain and storage fee. It scans at most 200 records per invocation and returns `nextIndex`. Full trees remain visible with `canDeposit: false`.

```bash
npm run cli -- discover-vaults examples/factory-policy.json https://rpc.testnet.near.org
npm run cli -- create-vault-args examples/factory-policy.json creator.testnet https://rpc.testnet.near.org
```

The second command validates the factory before preparing a signed-call payload; it does not sign or send funds. Both require an explicit trusted RPC URL. RPC authenticity remains a trust boundary.

## Scope

This factory distributes custody across independent vaults. It does not share trees, nullifiers or liquidity, and does not enable private cross-vault spends. The development Groth16 setup is still for local/testnet demonstrations.
