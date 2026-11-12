import { canonical, shaField } from "./crypto.js";
import type { Call, Policy, Reference } from "./types.js";
export const GAS = "300000000000000",
  STORAGE = 20_000_000_000_000_000_000_000n,
  BOND = 5_000_000_000_000_000_000_000n;
const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a public JSON object");
  return value as Record<string, unknown>;
}
export function account(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 64 ||
    !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value)
  )
    throw new Error("Invalid NEAR account");
  return value;
}
export function scalar(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 77 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) >= FIELD
  )
    throw new Error("Invalid scalar");
  return value;
}
function atomic(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 39 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) >= 1n << 128n
  )
    throw new Error("Invalid atomic amount");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid hash");
  return value;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join("|") !== keys.sort().join("|"))
    throw new Error("Unexpected fields in public call");
}
export function parsePolicy(input: unknown): Policy {
  const p = object(input);
  const allowed = [
    "network",
    "registry",
    "denomination",
    "feeRecipient",
    "registryWasmSha256",
    "vaultWasmSha256",
    "verifierSha256",
    ...(p.tokenId !== undefined ? ["tokenId"] : []),
  ];
  exact(p, allowed);
  if (p.network !== "sandbox" && p.network !== "testnet")
    throw new Error("Unsupported network");
  const registry = account(p.registry);
  if (registry.length > 30) throw new Error("Registry is too long");
  const denomination = atomic(p.denomination);
  if (
    BigInt(denomination) <= 0n ||
    BigInt(denomination) > ((1n << 128n) - 1n) / 256n
  )
    throw new Error("Invalid denomination");
  return {
    network: p.network,
    registry,
    denomination,
    feeRecipient: account(p.feeRecipient),
    registryWasmSha256: hash(p.registryWasmSha256),
    vaultWasmSha256: hash(p.vaultWasmSha256),
    verifierSha256: hash(p.verifierSha256),
    ...(p.tokenId !== undefined ? { tokenId: account(p.tokenId) } : {}),
  };
}
export function parseCall(input: unknown): Call {
  const c = object(input);
  exact(c, ["contract", "method", "args", "attachedYoctoNear", "gas"]);
  if (typeof c.method !== "string" || c.method.length > 64 || c.gas !== GAS)
    throw new Error("Unsupported function call or gas");
  return {
    contract: account(c.contract),
    method: c.method,
    args: object(c.args),
    attachedYoctoNear: atomic(c.attachedYoctoNear),
    gas: GAS,
  };
}
function vault(value: unknown, policy: Policy): string {
  const v = account(value);
  if (
    !new RegExp(
      `^v[a-f0-9]{32}\\.${policy.registry.replaceAll(".", "\\.")}$`,
    ).test(v)
  )
    throw new Error("Vault must be a direct protocol child");
  return v;
}
export function feeQuote(policy: Policy) {
  const d = BigInt(policy.denomination),
    fee = (d * 15n) / 10000n;
  if (!policy.tokenId || fee === 0n)
    throw new Error("Use an FT shared group with a nonzero fee");
  return {
    principalTokens: d.toString(),
    feeTokens: fee.toString(),
    depositTokens: (d + fee).toString(),
    storageYoctoNear: STORAGE.toString(),
  };
}
/** Accept an existing Core CLI FT plan. Ignore its display quote; derive every destination and amount. */
export async function preparedPayment(
  input: unknown,
  policyInput: Policy,
  payerInput: string,
): Promise<{ payment: Call; reference: Reference }> {
  const policy = parsePolicy(policyInput),
    payer = account(payerInput),
    plan = object(input);
  if (
    Object.keys(plan).some(
      (k) =>
        ![
          "quote",
          "storageTarget",
          "tokenCall",
          "completion",
          "checkedAtBlock",
          "prerequisite",
        ].includes(k),
    )
  )
    throw new Error(
      "Only a public Core FT call plan is accepted. Never import a private note or key.",
    );
  const call = parseCall(plan.tokenCall),
    q = feeQuote(policy);
  exact(call.args, ["receiver_id", "amount", "msg"]);
  if (
    call.contract !== policy.tokenId ||
    call.method !== "ft_transfer_call" ||
    call.attachedYoctoNear !== "1" ||
    typeof call.args.msg !== "string" ||
    call.args.msg.length > 4096
  )
    throw new Error("Wrong token call");
  const msg = object(JSON.parse(call.args.msg));
  const receipt = hash(msg.disclosure_root);
  if (call.args.receiver_id !== policy.registry) {
    const destination = vault(call.args.receiver_id, policy);
    exact(msg, ["commitment", "disclosure_root"]);
    const commitment = scalar(msg.commitment);
    if (commitment === "0" || call.args.amount !== q.depositTokens)
      throw new Error("Wrong deposit principal or add-on fee");
    return {
      payment: {
        ...call,
        args: {
          receiver_id: destination,
          amount: q.depositTokens,
          msg: JSON.stringify({ commitment, disclosure_root: receipt }),
        },
      },
      reference: {
        kind: "deposit",
        vault: destination,
        commitment,
        expectedOwner: payer,
        expectedDisclosureRoot: receipt,
      },
    };
  }
  exact(msg, [
    "vault",
    "recipient",
    "disclosure_root",
    "proof",
    "public_inputs",
  ]);
  const destination = vault(msg.vault, policy),
    recipient = account(msg.recipient);
  if (
    recipient === policy.registry ||
    recipient.endsWith(`.${policy.registry}`) ||
    call.args.amount !== q.feeTokens
  )
    throw new Error("Wrong withdrawal destination or fee");
  if (
    typeof msg.proof !== "string" ||
    !/^[A-Za-z0-9+/]{342}==$/.test(msg.proof) ||
    atob(msg.proof).length !== 256
  )
    throw new Error("Invalid proof encoding");
  if (!Array.isArray(msg.public_inputs) || msg.public_inputs.length !== 5)
    throw new Error("Expected five proof inputs");
  const inputs = msg.public_inputs.map(scalar);
  const domain = await shaField(
    `core:ft:v3|${policy.network}|${policy.registry}|${policy.tokenId}|${policy.denomination}`,
  );
  const context = await shaField(
    `core:action:ft:v3|${domain}|withdraw|${destination}|${recipient}|${receipt}`,
  );
  if (inputs[4] !== domain || inputs[3] !== context)
    throw new Error(
      "Proof does not bind this asset, vault, recipient and receipt",
    );
  return {
    payment: {
      ...call,
      args: {
        receiver_id: policy.registry,
        amount: q.feeTokens,
        msg: JSON.stringify({
          vault: destination,
          recipient,
          disclosure_root: receipt,
          proof: msg.proof,
          public_inputs: inputs,
        }),
      },
    },
    reference: {
      kind: "withdrawal",
      nullifier: inputs[0],
      expectedVault: destination,
      expectedRecipient: recipient,
      expectedDisclosureRoot: receipt,
    },
  };
}
export function validatePrerequisite(
  input: unknown,
  policy: Policy,
  payer: string,
  ref: Reference,
): Call {
  const c = parseCall(input),
    targets =
      ref.kind === "deposit"
        ? [ref.vault]
        : [ref.expectedVault, policy.registry, ref.expectedRecipient];
  if (c.method === "storage_deposit" && c.contract === policy.tokenId) {
    exact(c.args, ["account_id", "registration_only"]);
    if (
      c.args.registration_only !== true ||
      !targets.includes(account(c.args.account_id)) ||
      BigInt(c.attachedYoctoNear) > 10n ** 24n
    )
      throw new Error("Registration is outside the reviewed payment");
    return c;
  }
  const target = ref.kind === "deposit" ? ref.vault : policy.registry;
  if (c.method === "prepay_storage" && c.contract === target) {
    exact(c.args, ["account_id"]);
    if (
      c.args.account_id !== payer ||
      BigInt(c.attachedYoctoNear) <= 0n ||
      BigInt(c.attachedYoctoNear) > STORAGE + BOND
    )
      throw new Error("Storage credit is outside the reviewed payment");
    return c;
  }
  throw new Error("Unapproved prerequisite call");
}
export function validateRecovery(
  input: unknown,
  policy: Policy,
  ref: Reference,
): Call {
  const c = parseCall(input),
    args =
      ref.kind === "deposit"
        ? { commitment: ref.commitment }
        : { nullifier: ref.nullifier };
  if (
    c.contract !== (ref.kind === "deposit" ? ref.vault : policy.registry) ||
    canonical(c.args) !== canonical(args)
  )
    throw new Error("Recovery binding mismatch");
  if (
    c.method ===
      (ref.kind === "deposit" ? "retry_deposit" : "retry_withdrawal") &&
    c.attachedYoctoNear === STORAGE.toString()
  )
    return c;
  if (
    ref.kind === "deposit" &&
    c.method === "claim_deposit_refund" &&
    c.attachedYoctoNear === "1"
  )
    return c;
  throw new Error("Unapproved recovery call");
}
