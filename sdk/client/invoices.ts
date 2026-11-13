import { canonical, sha256 } from "./crypto.js";
import {
  account,
  object,
  parsePolicy,
  feeQuote,
  preparedPayment,
} from "./payment.js";
import type { Policy } from "./types.js";
export const INVOICE_SIGNING_RECIPIENT = "core.invoice.v1";
type InvoiceTerms = {
  id: string;
  merchantAccount: string;
  recipient: string;
  title: string;
  reference: string;
  policy: Policy;
  units: number;
  createdAt: string;
  expiresAt: string;
  nonce: string;
};
export type Invoice = InvoiceTerms & ({ version: 1 } | { version: 2; paymentNonces: string[] });
export type InvoiceSignature = {
  accountId: string;
  publicKey: string;
  signature: string;
};
export type SignedInvoice = { invoice: Invoice; signature: InvoiceSignature };
export type InvoiceProof = {
  invoiceHash: string;
  merchantAccount: string;
  nonce: string;
  publicKey: string;
  signature: string;
};
export type InvoiceState =
  | "awaiting_payment"
  | "partial"
  | "paid"
  | "paid_late"
  | "overpaid"
  | "expired"
  | "partial_expired"
  | "review_required";
export type InvoiceStatus = {
  invoiceHash: string;
  settlementRoot: string | null;
  settlementRoots?: string[];
  reusedPaymentReferences?: number;
  state: InvoiceState;
  expectedTokens: string;
  paidTokens: string;
  remainingTokens: string;
  overpaidTokens: string;
  lateTokens: string;
  confirmedPayments: number;
  coverageLimited: boolean;
  checkedAt: { hash: string; height: number; updatedAt: string };
  chainFreshnessChecked: false;
  confirmations: {
    settlementRoot?: string;
    recordIndex: number;
    nullifier: string;
    blockHeight: number;
    late: boolean;
    transaction: { hash: string; signer: string } | null;
  }[];
};
function exact(o: Record<string, unknown>, keys: string[]) {
  if (Object.keys(o).sort().join("|") !== keys.sort().join("|"))
    throw new Error("Unexpected invoice fields");
}
function hex(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid invoice digest or nonce");
  return value;
}
function text(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid invoice text");
  return value;
}
function date(value: unknown) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Use a canonical UTC invoice time");
  return value;
}
export function parseInvoice(input: unknown): Invoice {
  const o = object(input);
  exact(o, [
    "version",
    "id",
    "merchantAccount",
    "recipient",
    "title",
    "reference",
    "policy",
    "units",
    "createdAt",
    "expiresAt",
    "nonce",
    ...(o.version === 2 ? ["paymentNonces"] : []),
  ]);
  if (
    (o.version !== 1 && o.version !== 2) ||
    typeof o.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      o.id,
    ) ||
    typeof o.units !== "number" ||
    !Number.isInteger(o.units) ||
    o.units < 1 ||
    o.units > 32
  )
    throw new Error("Invoice requires 1–32 fixed-denomination notes");
  const policy = parsePolicy(o.policy);
  feeQuote(policy);
  const createdAt = date(o.createdAt),
    expiresAt = date(o.expiresAt);
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(expiresAt) - Date.parse(createdAt) > 90 * 86400000
  )
    throw new Error("Invoice expiry must be within 90 days of issue");
  const recipient = account(o.recipient);
  if (
    recipient === policy.registry ||
    recipient.endsWith("." + policy.registry)
  )
    throw new Error("Invoice must pay an external recipient");
  const terms: InvoiceTerms = {
    id: o.id,
    merchantAccount: account(o.merchantAccount),
    recipient,
    title: text(o.title, 120),
    reference: text(o.reference, 80),
    policy,
    units: o.units,
    createdAt,
    expiresAt,
    nonce: hex(o.nonce),
  };
  if (o.version === 1) return { ...terms, version: 1 };
  const paymentNonces = parsePaymentNonces(o.paymentNonces, terms.units);
  if (paymentNonces.includes(terms.nonce)) throw new Error("Invoice signing and payment nonces must differ");
  return { ...terms, version: 2, paymentNonces };
}
function parsePaymentNonces(input: unknown, units?: number): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32 || (units !== undefined && input.length !== units))
    throw new Error("Provide one unique nonce per invoice payment unit");
  const values = input.map(hex);
  if (new Set(values).size !== values.length) throw new Error("Invoice payment nonces must be distinct");
  return values;
}
export function createInvoice(input: Omit<InvoiceTerms, "id" | "nonce">): Invoice {
  if (!Number.isInteger(input.units) || input.units < 1 || input.units > 32) throw new Error("Invoice requires 1–32 fixed-denomination notes");
  const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  return parseInvoice({ ...input, version: 2, id: crypto.randomUUID(), nonce: random(), paymentNonces: Array.from({ length: input.units }, random) });
}
export function parseSignedInvoice(input: unknown): SignedInvoice {
  const o = object(input);
  exact(o, ["invoice", "signature"]);
  const invoice = parseInvoice(o.invoice),
    s = object(o.signature);
  exact(s, ["accountId", "publicKey", "signature"]);
  if (
    s.accountId !== invoice.merchantAccount ||
    typeof s.publicKey !== "string" ||
    !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.publicKey) ||
    typeof s.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(s.signature) ||
    atob(s.signature).length !== 64
  )
    throw new Error("Invalid invoice merchant signature");
  return {
    invoice,
    signature: {
      accountId: account(s.accountId),
      publicKey: s.publicKey,
      signature: s.signature,
    },
  };
}
export async function invoiceHash(invoice: Invoice) {
  const i = parseInvoice(invoice);
  return sha256(`core:invoice:v${i.version}|` + canonical(i));
}
export async function invoiceRootsFromHash(hash: string, nonces: unknown): Promise<string[]> {
  hex(hash);
  return Promise.all(parsePaymentNonces(nonces).map(nonce => sha256(`core:invoice:payment:v2|${hash}|${nonce}`)));
}
export async function invoicePaymentRoots(invoice: Invoice): Promise<string[]> {
  const i = parseInvoice(invoice), digest = await invoiceHash(i);
  return i.version === 1 ? [await sha256("core:invoice:settlement:v1|" + digest)] : invoiceRootsFromHash(digest, i.paymentNonces);
}
export async function invoiceRoot(invoice: Invoice, paymentIndex?: number) {
  const roots = await invoicePaymentRoots(invoice);
  if (invoice.version === 2 && roots.length > 1 && paymentIndex === undefined) throw new Error("Choose a payment index for this v2 invoice");
  const index = paymentIndex ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= roots.length) throw new Error("Invalid invoice payment index");
  return roots[index];
}
export async function invoiceStatusRequest(invoice: Invoice) {
  const i = parseInvoice(invoice);
  return { invoiceHash: await invoiceHash(i), recipient: i.recipient, units: i.units, expiresAt: i.expiresAt,
    ...(i.version === 2 ? { version: 2 as const, paymentNonces: [...i.paymentNonces] } : {}) };
}
export async function assertInvoiceReferenceAvailable(invoice: Invoice, root: string, status: InvoiceStatus) {
  const roots = await invoicePaymentRoots(invoice);
  if (status.invoiceHash !== await invoiceHash(invoice) || !roots.includes(root)) throw new Error("Payment reference is not bound to this invoice");
  if (invoice.version === 2 ? status.settlementRoot !== null || canonical(status.settlementRoots) !== canonical(roots) : status.settlementRoot !== roots[0]) throw new Error("Invoice reference set differs from signed terms");
  validateInvoiceStatus(status, invoice);
  if (invoice.version === 2 && status.confirmations.some(c => c.settlementRoot === root))
    throw new Error("This payment reference already has an indexed payment; choose an unused reference");
}
export function invoiceMessage(hash: string, network: Policy["network"]) {
  return `Core invoice v1\nNetwork: ${network}\nDigest: ${hex(hash)}`;
}
export function nonceBytes(nonce: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex(nonce).match(/../g)!, (v) => parseInt(v, 16));
}
function base58(input: string) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of input) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error("Invalid merchant key");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of input) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
export async function invoiceSigningDigest(
  hash: string,
  network: Policy["network"],
  nonce: string,
) {
  const str = (s: string) => {
      const b = new TextEncoder().encode(s),
        length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, b.length, true);
      return [...length, ...b];
    },
    tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2147484061, true);
  const data = Uint8Array.from([
    ...tag,
    ...str(invoiceMessage(hash, network)),
    ...nonceBytes(nonce),
    ...str(INVOICE_SIGNING_RECIPIENT),
    0,
  ]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}
export async function verifyInvoiceProofSignature(
  proof: InvoiceProof,
  network: Policy["network"],
) {
  const raw = base58(proof.publicKey.replace(/^ed25519:/, ""));
  if (raw.length !== 32) throw new Error("Invalid Ed25519 invoice key");
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "Ed25519",
    key,
    Uint8Array.from(atob(proof.signature), (c) => c.charCodeAt(0)),
    await invoiceSigningDigest(proof.invoiceHash, network, proof.nonce),
  );
}
export async function invoiceProof(
  input: SignedInvoice,
): Promise<InvoiceProof> {
  const s = parseSignedInvoice(input);
  return {
    invoiceHash: await invoiceHash(s.invoice),
    merchantAccount: s.invoice.merchantAccount,
    nonce: s.invoice.nonce,
    publicKey: s.signature.publicKey,
    signature: s.signature.signature,
  };
}
export async function verifySignedInvoice(input: unknown) {
  const s = parseSignedInvoice(input);
  if (
    !(await verifyInvoiceProofSignature(
      await invoiceProof(s),
      s.invoice.policy.network,
    ))
  )
    throw new Error("Invoice signature does not match its terms");
  return s;
}
export function invoiceQuote(invoice: Invoice) {
  const i = parseInvoice(invoice),
    q = feeQuote(i.policy),
    units = BigInt(i.units);
  return {
    principalTokens: (BigInt(i.policy.denomination) * units).toString(),
    withdrawalFeeTokens: (BigInt(q.feeTokens) * units).toString(),
    units: i.units,
    storageYoctoNearPerAttempt: q.storageYoctoNear,
  };
}
export function requireOpenInvoice(invoice: Invoice, now = Date.now()) {
  const i = parseInvoice(invoice);
  if (now < Date.parse(i.createdAt) - 300000 || now >= Date.parse(i.expiresAt))
    throw new Error("This invoice is expired or not yet valid");
}
export async function matchInvoicePlan(
  input: unknown,
  invoice: Invoice,
  payer: string,
  paymentIndex?: number,
) {
  requireOpenInvoice(invoice);
  const p = await preparedPayment(input, invoice.policy, payer);
  if (
    p.reference.kind !== "withdrawal" ||
    p.reference.expectedRecipient !== invoice.recipient ||
    !(await invoicePaymentRoots(invoice)).includes(p.reference.expectedDisclosureRoot ?? "")
    || (paymentIndex !== undefined && p.reference.expectedDisclosureRoot !== await invoiceRoot(invoice, paymentIndex))
  )
    throw new Error("Payment proof must bind this invoice root and recipient");
  return p;
}
export function invoiceLink(origin: string, signed: SignedInvoice) {
  const url = new URL("/pay/", origin);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Use an HTTPS checkout origin");
  let bytes = "";
  for (const b of new TextEncoder().encode(
    canonical(parseSignedInvoice(signed)),
  ))
    bytes += String.fromCharCode(b);
  url.hash =
    "invoice=" +
    btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return url.toString();
}
export function invoiceFromFragment(fragment: string) {
  const p = new URLSearchParams(fragment.replace(/^#/, "")),
    v = p.get("invoice");
  if (
    [...p.keys()].join("|") !== "invoice" ||
    !v ||
    v.length > 16000 ||
    !/^[A-Za-z0-9_-]+$/.test(v)
  )
    throw new Error("Invalid invoice link");
  const bytes = Uint8Array.from(
    atob(v.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  return parseSignedInvoice(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

export function validateInvoiceStatus(
  input: unknown,
  invoice: Invoice,
): InvoiceStatus {
  const s = object(input),
    p = invoiceQuote(invoice),
    expected = BigInt(p.principalTokens);
  const amount = (key: string) => {
    const v = s[key];
    if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 42)
      throw new Error("Invalid invoice totals");
    return BigInt(v);
  };
  const paid = amount("paidTokens"),
    remaining = amount("remainingTokens"),
    over = amount("overpaidTokens"),
    late = amount("lateTokens"),
    unit = BigInt(invoice.policy.denomination);
  if (
    s.expectedTokens !== p.principalTokens ||
    paid % unit !== 0n ||
    remaining !== (paid < expected ? expected - paid : 0n) ||
    over !== (paid > expected ? paid - expected : 0n) ||
    late > paid ||
    s.confirmedPayments !== Number(paid / unit) ||
    typeof s.coverageLimited !== "boolean" ||
    s.chainFreshnessChecked !== false ||
    !Array.isArray(s.confirmations) ||
    s.confirmations.length !== s.confirmedPayments ||
    s.confirmations.length > 1000
  )
    throw new Error("Inconsistent invoice settlement totals");
  const valid =
    s.state === "review_required"
      ? s.coverageLimited === true
      : s.coverageLimited === false &&
        (s.state === "paid"
          ? paid === expected && late === 0n
          : s.state === "paid_late"
            ? paid === expected && late > 0n
            : s.state === "overpaid"
              ? paid > expected
              : s.state === "partial" || s.state === "partial_expired"
                ? paid > 0n && paid < expected
                : s.state === "awaiting_payment" || s.state === "expired"
                  ? paid === 0n
                  : false);
  if (!valid)
    throw new Error("Invoice state does not match confirmed principal");
  const c = object(s.checkedAt);
  if (
    typeof c.hash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(c.hash) ||
    typeof c.height !== "number" ||
    !Number.isSafeInteger(c.height) ||
    c.height < 0 ||
    typeof c.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(c.updatedAt))
  )
    throw new Error("Invalid invoice checkpoint");
  if (invoice.version === 2 && (s.settlementRoot !== null || !Array.isArray(s.settlementRoots) || s.settlementRoots.length !== invoice.units || s.settlementRoots.some(r => typeof r !== "string" || !/^[a-f0-9]{64}$/.test(r)) || new Set(s.settlementRoots).size !== invoice.units))
    throw new Error("Invalid per-payment invoice references");
  const nullifiers = new Set<string>(), recordIndices = new Set<number>();
  let latePayments = 0;
  for (const entry of s.confirmations) {
    const r = object(entry);
    if (
      typeof r.nullifier !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(r.nullifier) ||
      nullifiers.has(r.nullifier) ||
      typeof r.recordIndex !== "number" ||
      !Number.isSafeInteger(r.recordIndex) ||
      r.recordIndex < 0 ||
      recordIndices.has(r.recordIndex) ||
      (invoice.version === 2 && !(s.settlementRoots as string[]).includes(String(r.settlementRoot))) ||
      typeof r.blockHeight !== "number" ||
      !Number.isSafeInteger(r.blockHeight) ||
      r.blockHeight < 0 ||
      r.blockHeight > c.height ||
      typeof r.late !== "boolean"
    )
      throw new Error("Invalid invoice confirmation");
    nullifiers.add(r.nullifier);
    recordIndices.add(r.recordIndex);
    if (r.late) latePayments++;
  }
  if (late !== BigInt(latePayments) * unit)
    throw new Error("Invoice late total differs from confirmed payments");
  if (invoice.version === 2) {
    const unique = new Set(s.confirmations.map(entry => object(entry).settlementRoot)).size;
    if (s.reusedPaymentReferences !== s.confirmations.length - unique) throw new Error("Invalid invoice reference reuse count");
  }
  return input as InvoiceStatus;
}
