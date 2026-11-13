# Recipient preparation

[Service overview](SERVICE.md) · [Development roadmap](ROADMAP.md)

Check a receiving account before issuing an invoice or preparing a withdrawal. This read-only check separates account activation, registration on the trusted token contract, and payment review. It generates no keys, account-creation transaction, funding transfer, or payout.

## States

| State | Meaning | Next step |
| --- | --- | --- |
| `account_missing` | The account does not exist at the checked final block. Token registration may already exist independently. | Create or activate this exact account with a compatible NEAR wallet, then refresh. |
| `registration_required` | The account exists, but `storage_balance_of` on the pinned token returned null. | Review the proposed `storage_deposit` call. The payment session can present registration for separate wallet approval. |
| `ready` | The account exists and is registered on the pinned token at the checked block. | Continue payment review; this does not confirm payment or guarantee transfer success. |

A zero native balance does not by itself mean an account is absent. Only the RPC's `UNKNOWN_ACCOUNT` result establishes absence; transport, block and contract errors fail the check. The native account and token registration are separate records. See [NEAR account creation](https://docs.near.org/integrations/accounts) and the [NEP-145 storage standard](https://github.com/near/NEPs/blob/master/neps/nep-0145.md).

An ED25519 implicit address is 64 lowercase hexadecimal characters. Ethereum-style implicit addresses start with `0x`; other NEAR account types have different creation rules. The checker reports `near_implicit`, `eth_implicit`, or `named_or_other` for display; this is not proof of key ownership or permission to create an account. Follow the current wallet/account documentation rather than applying one creation method to every address. See [NEAR account IDs](https://docs.near.org/protocol/accounts-contracts/account-id).

## SDK and CLI

```ts
import { NearRpcOperationsSource, recipientReadiness } from '../sdk/operations.js';

const source = new NearRpcOperationsSource(policy.network, policy.registry, trustedRpcUrl);
const preparation = await recipientReadiness(source, policy, { recipient });
// preparation.state, preparation.checkedAtBlock, preparation.registrationCall
```

```bash
npm run cli -- recipient-readiness trusted-policy.json https://rpc.testnet.near.org receiver.testnet
```

```ts
import { HttpGateway } from '@company-privacy-settlement/core/client';

const gateway = new HttpGateway(trustedApiOrigin);
const preparation = await gateway.recipientReadiness(trustedPolicy, recipient, {
  signal: abortController.signal,
});
```

The HTTP client first compares `/v1/config` with the independently obtained policy. It validates the returned policy, destination, account-kind/state flags, final block, and exact registration call. Changing the account, token, amount, gas, or `registration_only` flag causes rejection. API data never replaces the caller's trusted policy.

## Read-only API

`POST /v1/recipients/readiness` accepts exactly:

```json
{ "recipient": "receiver.testnet" }
```

The deployment is server-configured. Query parameters, request-controlled RPCs, additional fields, private notes, keys, and passwords are rejected. The registry and its child accounts cannot be external recipients. The route costs 3 rate points and permits at most 16 source reads, subject to stricter deployment limits. Existing request deadlines and cancellation apply.

The checker verifies the pinned registry and up to one catalog member, then reads the account, token `storage_balance_bounds`, and token `storage_balance_of` at the same final block. This is not a full vault-liquidity scan. `registrationCall` is non-null only for an existing, unregistered account, and attaches exactly the observed minimum within the SDK's existing maximum of 1 NEAR. The call targets the pinned token with `storage_deposit({ account_id: recipient, registration_only: true })`; inspection does not submit it.

`activationAmountYoctoNear` is always null: account-creation costs are not estimated. `gasBudgetIncluded` and `chainFreshnessChecked` remain false. The minimum is a snapshot, not a price reservation. Gas, account activation, token registration, storage-credit bonds and the protocol's 0.15% add-on fees remain distinct. Payer balances, vault liquidity and finalized payout state still belong to preflight and settlement observation.

## Browser workspace

The invoice form offers **Check recipient** before signing. Signed invoice checkout pins the destination to the invoice and enables the check after independent policy/API verification. Prepared withdrawals expose the same check for their bound recipient. Refresh clears the previous result while checking; failed responses never retain a ready result. Editing policy, recipient or API origin invalidates the snapshot and cancels pending work.

The result is advisory preparation, not a payment-status cache, KYB result, token freeze check, wallet ownership proof, or guarantee that a later transaction will succeed. Account activation remains an explicit external wallet step; registration is reviewed separately in the existing payment flow.
