# Deployed contract and vault addresses

[Web address reference](https://core-private-settlement-0574c4.jiheon6768.chatgpt.site/docs/deployments/) · [Native qualification](TESTNET_WALLET.md) · [Deployment tooling](DEPLOYMENT.md)

This is the **native NEAR v2 reference group on NEAR testnet**, with fixed 0.1 NEAR notes. It is separate from the token-bound v3 browser/USDC flow. The addresses were rechecked read-only on 2026-11-14 at canonical FINAL height **277653473**, block `DtDeWuqVGdsCKKmZ8xCuKd1DeHfUsTHw9yCwhdkc7L2t`, through `https://test.rpc.fastnear.com`.

| Role | Account | Explorer |
| --- | --- | --- |
| Shared registry / forest contract | `c14f-c1b494d1.testnet` | [Registry](https://testnet.nearblocks.io/address/c14f-c1b494d1.testnet) |
| Independent vault A contract | `v0bea43bb3832da6145a7d07deb5bca4b.c14f-c1b494d1.testnet` | [Vault A](https://testnet.nearblocks.io/address/v0bea43bb3832da6145a7d07deb5bca4b.c14f-c1b494d1.testnet) |
| Independent vault B contract | `vef1c6d6d5654e7c07536611490443d52.c14f-c1b494d1.testnet` | [Vault B](https://testnet.nearblocks.io/address/vef1c6d6d5654e7c07536611490443d52.c14f-c1b494d1.testnet) |
| Fee recipient account | `treasury.core14-0574c4-ebed76bb2c.testnet` | [Fee account](https://testnet.nearblocks.io/address/treasury.core14-0574c4-ebed76bb2c.testnet) |

The fee account is not a vault or deposit endpoint. Use reviewed contract deposit/withdrawal calls with the matching policy; plain transfers to these accounts are not protocol deposits. Publishing an address does not provision a browser policy, backend services or payout liquidity.

## Verification and downloads

[Read-only address record](evidence/deployed-addresses-2026-11-14.json) · [Native policy JSON](evidence/testnet-native-policy-2026-11-14.json)

The current registry/vault code, verification-key pin, fee/configuration bindings, registry membership and empty access-key lists matched the reviewed policy at the same snapshot. Both vaults had zero available/reserved notes. The registry had **2 vaults, 6/256 total outputs, 0 outstanding notes and 16 journal records**. This is a snapshot, not a live feed or light-client proof.

| Pin | SHA-256 |
| --- | --- |
| Registry WASM | `79ed58b8cc65ee1b58692e104b1efc2f4779144229602575b0f8785910c017b9` |
| Vault WASM | `56f4b88e171ec1781a7856b06b659a9664d0036c20a203bbc4d910ae93c9f412` |
| Encoded verification key | `296120fd8a431089e51bfe703d2c42df9836d3df687120ef251ee91403f6ad45` |
| Native policy file bytes | `f6ca5b87c5ae8140f791d84d9464aec60f32f0da58a9cf050b46ad30bd371595` |

Obtain trusted policy pins independently. Matching a file hash establishes integrity against that pin; it does not establish the pin's authority or a production audit.

## Recorded settlement and current scope

The [original fourteen-transaction native qualification](TESTNET_WALLET.md) records real deposits, cross-vault payout and fixed-recipient failure recovery. Later [relay](RELAY.md) and [bounded cover](COVER_TRAFFIC.md) runs have separate evidence. Later outputs do not change historical anonymity claims, and artificial operator activity is not independent participation.

Public browser-wallet USDC settlement, accepted hosted API/indexer/Organization/relay HTTPS operations and [actual KYB/tax-provider qualification](PROVIDER_QUALIFICATION.md) remain open. The current setup is `UNSAFE_LOCAL_DEVELOPMENT_ONLY`, not a reviewed production setup. This native policy has no `tokenId` and must not be imported as a browser FT policy. Existing website access stays owner-private.
