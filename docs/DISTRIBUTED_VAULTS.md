# Distributed vaults and fresh recipient accounts

The factory automatically deploys independent NEAR contract accounts without ever adding access keys to the children. Each holds its own funds and applies the same ZK spend rules. `discoverVaults` checks pinned bytecode, verification-key hashes, domains and empty access key lists at one finalized block. `chooseIndependentVault` selects from a caller-approved list without receiving funds. See [FACTORY.md](FACTORY.md) for deployment, verification and refunds.

```text
                         ┌─ vault A ─ ZK spend ─ fresh recipient address A
client selects vault ────┼─ vault B ─ ZK spend ─ fresh recipient address B
                         └─ vault C ─ ZK spend ─ fresh recipient address C
```

## Fresh implicit recipients

`createFreshRecipient(password)` generates an Ed25519 keypair on the recipient's device. Its 32-byte public key becomes a 64-character hexadecimal implicit NEAR account ID. Only the public address is submitted to the contract. A first native NEAR transfer creates the account on-chain; only the matching private key can spend from it. The SDK exports the private material only as an authenticated encrypted backup. The local demo verifies first-transfer account creation and the final balance.

Reference: [NEAR account model and implicit account creation](https://near.github.io/nearcore/DataStructures/Account.html).

Contracts must not derive wallet private keys from on-chain randomness, state or call arguments: these inputs are observable. A contract can create named subaccounts and add a client-supplied public key, but cannot then spend from an EOA without the corresponding external signer. Giving those private keys to an operator recreates custody. Use code-controlled vault accounts for automatic ZK-authorized spends.

## Scope of v1

Implemented: permissionless factory deployment of keyless vaults, failed-creation refunds, verified discovery, separate note domains, client-side selection, local implicit recipient generation, encrypted key export, and native withdrawals to fresh implicit accounts. Principal is deposited directly into a selected vault; only the account-creation budget passes through the factory.

Not implemented: shared commitments/nullifiers across vaults, private atomic cross-vault transfers, pooled liquidity routing, or a common anonymity set. A note from A cannot be redeemed in B. Depositing/withdrawing transparently between pools does not create a private bridge.

Distributing assets reduces concentration per account but divides the anonymity set; if only one deposit enters a vault, its exit can often be inferred. More wallets or more contract accounts do not themselves hide amounts, timing, funding edges or relayer identities. A production design that shares an anonymity set while distributing custody needs a separate cross-vault proof and asynchronous settlement design, including double-spend coordination and failure recovery on NEAR.
