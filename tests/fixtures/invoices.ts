import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { indexFixture } from "./indexer.js";
import {
  invoiceSigningDigest,
  invoiceHash,
  type Invoice,
  type SignedInvoice,
} from "../../sdk/client/invoices.js";
export async function invoiceFixture(units = 1) {
  const f = indexFixture(),
    keys = generateKeyPairSync("ed25519"),
    raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    publicKey = "ed25519:" + bs58.encode(raw);
  const invoice: Invoice = {
    version: 1,
    id: "12345678-1234-4234-9234-123456789abc",
    merchantAccount: f.payer,
    recipient: f.recipient,
    title: "Project milestone · 청구",
    reference: "INV-2026-001",
    policy: f.policy,
    units,
    createdAt: "2026-11-12T10:00:00.000Z",
    expiresAt: "2026-11-13T10:00:00.000Z",
    nonce: "ab".repeat(32),
  };
  async function signedInvoice(i = invoice): Promise<SignedInvoice> {
    const signature = sign(
      null,
      await invoiceSigningDigest(
        await invoiceHash(i),
        i.policy.network,
        i.nonce,
      ),
      keys.privateKey,
    ).toString("base64");
    return {
      invoice: i,
      signature: { accountId: i.merchantAccount, publicKey, signature },
    };
  }
  const signed = await signedInvoice();
  return { ...f, invoice, signed, publicKey, keys, signedInvoice };
}
