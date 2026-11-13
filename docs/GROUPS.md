# Approved groups and capacity management

A shared group has **256 total tree outputs**. Deposits and private transfers both consume output slots; withdrawals do not free them. When a group fills, new deposits can use another independently approved group while existing notes retain their original withdrawal path.

This SDK/CLI flow selects deployments already present in a caller-held directory. It does not deploy contracts, move notes between groups, or fetch trust anchors from the API. Each group retains a separate note domain, tree and anonymity set. Principal still goes directly to a selected keyless vault.

## Approve a directory

Start from [approved-groups.template.json](../examples/approved-groups.template.json). Its placeholder addresses/hashes are not a deployment and fail validation until replaced. Independently verify and record each deployment's registry/vault code hashes, verification-key hash, treasury, token and denomination.

The version-1 file has 1–8 ordered `groups`, each with a unique `id`, explicit `depositsEnabled` boolean and full existing `SharedPolicy`. All entries must share the same network, asset/token account and denomination. Duplicate registries, mixed assets, unknown fields and malformed policies fail before RPC reads. Native NEAR groups omit `tokenId`; FT groups pin the exact same token address in every entry.

File order is the deposit priority. Keep the original group in the directory with `depositsEnabled: false` when retiring it for new deposits. This is a local client preference, not an on-chain pause, credential revocation or withdrawal restriction. Keep independently verified copies of old policies with note backups; deleting a directory entry does not migrate its notes. Existing single-policy commands remain usable with the original trusted policy.

## Inspect capacity and create a note

```sh
npm run cli -- groups-status approved-groups.json https://rpc.testnet.near.org

read -rs CORE_NOTE_PASSWORD
export CORE_NOTE_PASSWORD
npm run cli -- group-note approved-groups.json https://rpc.testnet.near.org receiver-note.encrypted.json
# Optional explicit preference, still subject to approval/capacity checks:
npm run cli -- group-note approved-groups.json https://rpc.testnet.near.org another-note.encrypted.json next
```

`groups-status` returns one shared `blockHash` and each group's pinned policy, 256-output `capacity`, `remainingOutputs`, `depositState` and verified catalog. States are:

| State | Meaning |
| --- | --- |
| `available` | Enabled, has free tree outputs, and a fully scanned verified vault can receive a deposit |
| `full` | Enabled, but its tree has used all 256 outputs |
| `disabled` | New deposits are disabled in this local directory; remaining output slots are still reported |
| `no_eligible_vault` | Enabled with tree capacity, but no ready verified vault currently accepts a deposit |

All directory reads use the finalized block obtained once from the first source. Enabled groups with remaining tree capacity are scanned completely, up to **1,000 vault records per group**; SDK callers may lower `maxRecordsPerGroup` to 1–1,000. Full/disabled groups inspect only the first catalog record for capacity reporting; `checkedRecords` and `nextIndex` remain explicit. Their capacity summary is not a complete withdrawal-liquidity inventory. Any invalid deployment, failed RPC, exceeded scan budget or inconsistent snapshot aborts discovery rather than silently trusting a partial fallback. The CLI uses one explicitly supplied trusted RPC URL for all groups.

`group-note` chooses the first `available` group, or requires the named preference to be available. It writes the existing AES-GCM encrypted note format with owner-only permissions and refuses to overwrite an existing file. Standard output contains only the public commitment, selected policy/group ID and snapshot metadata. Retain that policy/directory with the encrypted backup. Never send the note password, note secret or nullifier to the API.

## Prepare a deposit and preserve its group

```sh
npm run cli -- group-deposit-args approved-groups.json https://rpc.testnet.near.org \
  receiver-note.encrypted.json FRESH_DISCLOSURE_ROOT
# An explicit verified member is optional:
npm run cli -- group-deposit-args approved-groups.json https://rpc.testnet.near.org \
  receiver-note.encrypted.json FRESH_DISCLOSURE_ROOT selected-vault.testnet
```

The CLI decrypts and validates the note locally, finds its approved policy by its cryptographic domain, and queries only that group. It rejects a foreign note, a disabled deposit preference, a full tree or an ineligible selected vault. If capacity changed after note creation, it **does not substitute a different group**. If funds have not been sent, create a fresh note for another available group. Keep any funded note and use its original group for recovery/withdrawal.

NEAR/FT calls keep the existing **0.15% fee added to principal**, storage prerequisites, token registration and sender binding. Actual wallet approval/broadcast and fresh preflight checks remain explicit. The capacity snapshot reserves no slot; another deposit or private transfer can fill it before the wallet transaction executes. Check the original contract's final state and existing refund/retry rules.

## Spend an original note

```sh
npm run cli -- group-spend-args approved-groups.json https://rpc.testnet.near.org \
  original-note.encrypted.json withdraw-action.json public-withdrawal.json
```

The command finds and validates the original group locally even when `depositsEnabled` is false or its tree is full. It verifies original-group liquidity, reconstructs that group's tree and proves locally before preparing the existing wallet call. An explicit action `vault` must be a verified member of that same group. No other directory group is queried to redirect a withdrawal. The original recipient/receipt/nullifier bindings and fixed-destination retry behavior remain in force.

Private transfers also stay within the note's original group and need a remaining output slot. The CLI's underlying spend path and final contract checks remain authoritative. There is no private cross-group transfer or automatic note conversion.

## SDK

```ts
import { ApprovedGroupsSchema, discoverApprovedGroups, chooseDepositGroup, approvedGroupForNote, type GroupSourceFactory } from '../sdk/groups.js';
import { NearRpcSharedSource } from '../sdk/shared.js';

const directory = ApprovedGroupsSchema.parse(trustedLocalJson);
const factory: GroupSourceFactory = policy => new NearRpcSharedSource(policy.network, policy.registry, trustedRpcUrl);
const status = await discoverApprovedGroups(factory, directory);
const selected = chooseDepositGroup(status); // or chooseDepositGroup(status, 'next')
// The existing createNote(selected.catalog.pool) produces a compatible note.
const original = await approvedGroupForNote(directory, decryptedLocalNote);
// Use original.group.policy for the existing discovery/proof/withdrawal flow.
```

The Core HTTP service, Front journal and signed invoices use one independently trusted group at a time. A signed invoice cannot be changed to another group by this directory; payer notes and invoice policy must match. Public-network group deployment and policy distribution remain separate work. Contract bytecode, circuit domains, trusted setup and cross-group privacy guarantees do not change.

## Front group selection

Front Settlements exposes **Choose from approved groups** for testnet FT directories. The directory is parsed locally and kept in memory. It accepts the same ordered policy entries as the CLI and rejects included API origins or private-note fields. Enter each group's Core API origin separately; importing a directory starts no network reads.

Each check first compares `/v1/config` with the independent policy, then reads `/v1/group/capacity`. That endpoint verifies the registry and at most the first catalog member at one finalized block and reports `capacity`, `usedOutputs`, `remainingOutputs`, `outstandingNotes`, `depositCapacityAvailable`, `depositVaultObserved`, `checkedVaults` and `vaultScanComplete`, together with the policy/block. It does not scan every vault, reserve capacity or assert wall-clock freshness of the RPC head. Missing eligibility in a partial first-member scan requires complete CLI discovery, not a claim that all members are unavailable.

**Use for deposits** requires an enabled directory entry, free outputs and an observed eligible member. **Use for recovery** also accepts full or deposit-disabled groups and blocks new deposit-plan imports. Both actions recheck the API before applying the policy and use that group's separate journal namespace. Lock the journal before changing the policy/API. Failed refreshes, edited row origins and invalid replacement directories clear prior verification; cancelled/obsolete responses cannot apply a selection.

Private notes and proofs stay in the CLI. The workspace imports public plans and validates them against the selected policy before a wallet call. Existing note and invoice bindings remain authoritative; group selection does not redirect an old note. Checkout keeps its signed policy and has no group switcher.

## Validation

`npm test` includes native/FT capacity selection, same-block reads, disabled/full-group handling, later eligible members, fail-closed budgets/deployment checks, local note-domain matching, CLI backup permissions and original-group request routing. It runs without proving artifacts.

After the existing `zk:setup`, run `npm run test:groups-proof` for an additional CLI proof check. It constructs a full 256-output tree, uses a deposit-disabled original group and prepares a real Groth16 withdrawal proof through `group-spend-args`. Assertions bind the original root/domain, vault, recipient and exact 0.15% add-on fee. The report is `demo-output/groups-proof-validation.json`. RPC responses are local fixtures and no transaction is broadcast; this validates proof/plan generation, not public-network payout execution.
