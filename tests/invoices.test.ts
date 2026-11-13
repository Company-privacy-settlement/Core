import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { invoiceFixture } from "./fixtures/invoices.js";
import {
  invoiceSigningDigest,
  invoiceHash,
  invoiceRoot,
  invoiceProof,
  verifySignedInvoice,
  invoiceQuote,
  requireOpenInvoice,
  invoiceLink,
  invoiceFromFragment,
  matchInvoicePlan,
  parseInvoice,
} from "../sdk/client/invoices.js";
import {
  verifyInvoiceMerchant,
  indexedInvoiceStatus,
} from "../sdk/invoices.js";
import { IndexStore } from "../sdk/indexer/store.js";
import { SettlementIndexer } from "../sdk/indexer/worker.js";
import { createReadOnlyApi } from "../server/api.js";
import { shaField } from "../sdk/client/crypto.js";
import { validateInvoiceStatus } from "../sdk/client/invoices.js";
const before = Date.parse("2026-11-12T12:00:00.000Z"),
  after = Date.parse("2026-11-14T12:00:00.000Z");
test("merchant invoice signature authenticates every term and preserves UTF-8 fragment roundtrips", async () => {
  const f = await invoiceFixture();
  assert.deepEqual(await verifySignedInvoice(f.signed), f.signed);
  const url = new URL(invoiceLink("https://checkout.example", f.signed));
  assert.equal(url.pathname, "/pay/");
  assert.equal(url.search, "");
  assert.deepEqual(invoiceFromFragment(url.hash), f.signed);
  for (const [key, value] of [
    ["recipient", "other.test.near"],
    ["title", "Other work"],
    ["units", 2],
    ["expiresAt", "2026-11-14T10:00:00.000Z"],
    ["nonce", "cd".repeat(32)],
  ] as const) {
    const copy = structuredClone(f.signed);
    Object.assign(copy.invoice, { [key]: value });
    await assert.rejects(() => verifySignedInvoice(copy));
  }
});
test("NEP-413 invoice digest agrees with an independent Borsh payload including the None callback tag", async () => {
  const f = await invoiceFixture(),
    hash = await invoiceHash(f.invoice),
    message = `Core invoice v1\nNetwork: sandbox\nDigest: ${hash}`,
    str = (s: string) => {
      const b = Buffer.from(s),
        n = Buffer.alloc(4);
      n.writeUInt32LE(b.length);
      return Buffer.concat([n, b]);
    },
    tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const expected = createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        str(message),
        Buffer.from(f.invoice.nonce, "hex"),
        str("core.invoice.v1"),
        Buffer.from([0]),
      ]),
    )
    .digest();
  assert.deepEqual(
    Buffer.from(await invoiceSigningDigest(hash, "sandbox", f.invoice.nonce)),
    expected,
  );
});
test("wallet ownership requires a current full-access key and exact configured network", async () => {
  const f = await invoiceFixture(),
    proof = await invoiceProof(f.signed);
  f.source.accessKeys = async () => [
    { public_key: f.publicKey, access_key: { permission: "FullAccess" } },
  ];
  assert.equal(
    (await verifyInvoiceMerchant(f.source, f.policy, proof)).verified,
    true,
  );
  f.source.accessKeys = async () => [
    {
      public_key: f.publicKey,
      access_key: {
        permission: { FunctionCall: { receiver_id: "evil.test.near" } },
      },
    },
  ];
  assert.equal(
    (await verifyInvoiceMerchant(f.source, f.policy, proof)).verified,
    false,
  );
  f.source.accessKeys = async () => [];
  assert.equal(
    (await verifyInvoiceMerchant(f.source, f.policy, proof)).verified,
    false,
  );
  await assert.rejects(
    () =>
      verifyInvoiceMerchant(
        f.source,
        { ...f.policy, network: "testnet" },
        proof,
      ),
    /source differs/,
  );
});
test("invoice fees are additive per note, dates and ranges reject invalid requests", async () => {
  const f = await invoiceFixture(3);
  assert.equal(invoiceQuote(f.invoice).principalTokens, "3000000");
  assert.equal(invoiceQuote(f.invoice).withdrawalFeeTokens, "4500");
  requireOpenInvoice(f.invoice, before);
  assert.throws(() => requireOpenInvoice(f.invoice, after), /expired/);
  for (const change of [
    { units: 0 },
    { units: 33 },
    { expiresAt: f.invoice.createdAt },
    { recipient: f.policy.registry },
    { privateKey: "bad" },
  ])
    assert.throws(() => parseInvoice({ ...f.invoice, ...change }));
});
async function indexed(units = 2) {
  const f = await invoiceFixture(units),
    store = new IndexStore(":memory:", f.policy),
    root = await invoiceRoot(f.invoice);
  const payment = (i: number, change: Record<string, unknown> = {}) =>
    f.record(i, {
      kind: "withdrawal_succeeded",
      commitment: null,
      nullifier: String(i + 1),
      recipient: f.recipient,
      disclosure_root: root,
      protocol_fee_charged: "0",
      protocol_fee_earned: "1500",
      storage_fee_charged: "0",
      timestamp_ns: (BigInt(before) * 1000000n).toString(),
      ...change,
    });
  const request = {
    invoiceHash: await invoiceHash(f.invoice),
    recipient: f.recipient,
    units,
    expiresAt: f.invoice.expiresAt,
  };
  return {
    ...f,
    store,
    root,
    payment,
    request,
    worker: new SettlementIndexer(f.source, store),
  };
}
test("indexed invoice moves from awaiting to partial to paid with unique completed nullifiers", async () => {
  const f = await indexed();
  try {
    await f.worker.sync();
    assert.equal(
      (await indexedInvoiceStatus(f.store, f.policy, f.request, before)).state,
      "awaiting_payment",
    );
    f.state.height++;
    f.records.push(f.payment(0));
    await f.worker.sync();
    let s = await indexedInvoiceStatus(f.store, f.policy, f.request, before);
    assert.equal(s.state, "partial");
    assert.equal(s.remainingTokens, "1000000");
    f.state.height++;
    f.records.push(f.payment(1));
    await f.worker.sync();
    s = await indexedInvoiceStatus(f.store, f.policy, f.request, before);
    assert.equal(s.state, "paid");
    assert.equal(s.paidTokens, "2000000");
    assert.equal(s.chainFreshnessChecked, false);
    assert.equal(s.confirmations.length, 2);
  } finally {
    f.store.close();
  }
});
test("requests, other recipients and other invoice roots never count as paid", async () => {
  const f = await indexed(1);
  try {
    f.records.push(
      f.payment(0, { disclosure_root: "ff".repeat(32) }),
      f.payment(1, { recipient: "other.test.near" }),
      f.payment(2, {
        kind: "withdrawal_requested",
        protocol_fee_charged: "1500",
        protocol_fee_earned: "0",
        storage_fee_charged: "20000000000000000000000",
      }),
    );
    await f.worker.sync();
    const s = await indexedInvoiceStatus(f.store, f.policy, f.request, before);
    assert.equal(s.paidTokens, "0");
    assert.equal(s.state, "awaiting_payment");
  } finally {
    f.store.close();
  }
});
test("expiry, late settlement, overpayment and repeated nullifiers remain explicit", async () => {
  const f = await indexed(1);
  try {
    await f.worker.sync();
    assert.equal(
      (await indexedInvoiceStatus(f.store, f.policy, f.request, after)).state,
      "expired",
    );
    f.state.height++;
    f.records.push(
      f.payment(0, {
        timestamp_ns: (
          BigInt(Date.parse(f.invoice.expiresAt)) * 1000000n
        ).toString(),
      }),
    );
    await f.worker.sync();
    assert.equal(
      (await indexedInvoiceStatus(f.store, f.policy, f.request, after)).state,
      "paid_late",
    );
    f.state.height++;
    f.records.push(f.payment(1, { nullifier: "1" }));
    await f.worker.sync();
    assert.equal(
      (await indexedInvoiceStatus(f.store, f.policy, f.request, after))
        .confirmedPayments,
      1,
    );
    f.state.height++;
    f.records.push(f.payment(2));
    await f.worker.sync();
    const s = await indexedInvoiceStatus(f.store, f.policy, f.request, after);
    assert.equal(s.state, "overpaid");
    assert.equal(s.overpaidTokens, "1000000");
  } finally {
    f.store.close();
  }
});
test("a known incomplete journal cannot report a fully reconciled invoice", async () => {
  const f = await indexed(1);
  try {
    f.records.push(...Array.from({ length: 51 }, (_, i) => f.payment(i)));
    await f.worker.sync({ maxPages: 1 });
    const s = await indexedInvoiceStatus(f.store, f.policy, f.request, before);
    assert.equal(s.coverageLimited, true);
    assert.equal(s.state, "review_required");
  } finally {
    f.store.close();
  }
});
test("invoice public endpoints omit business terms, enforce strict inputs and verify merchant key ownership", async (t) => {
  // The fixture has fixed invoice dates; the HTTP status route reads Date.now().
  t.mock.method(Date, "now", () => before);
  const f = await indexed(1);
  await f.worker.sync();
  f.source.accessKeys = async (a) =>
    a === f.invoice.merchantAccount
      ? [{ public_key: f.publicKey, access_key: { permission: "FullAccess" } }]
      : [];
  const server = createReadOnlyApi({
    source: f.source,
    policy: f.policy,
    index: f.store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.store.close();
  });
  const post = (p: string, body: unknown) =>
    fetch(`http://127.0.0.1:${a.port}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let r = await post("/v1/invoices/verify", await invoiceProof(f.signed));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).verified, true);
  r = await post("/v1/invoices/status", f.request);
  assert.equal((await r.json()).state, "awaiting_payment");
  r = await post("/v1/invoices/verify", {
    ...(await invoiceProof(f.signed)),
    title: "secret terms",
  });
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes("secret terms"));
});

test("checkout accepts only a withdrawal proof for this invoice recipient and committed terms", async () => {
  const f = await invoiceFixture(),
    i = {
      ...f.invoice,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    root = await invoiceRoot(i),
    domain = await shaField(
      `core:ft:v3|sandbox|${f.policy.registry}|${f.policy.tokenId}|${f.policy.denomination}`,
    );
  async function plan(disclosureRoot: string) {
    const context = await shaField(
      `core:action:ft:v3|${domain}|withdraw|${f.vault}|${f.recipient}|${disclosureRoot}`,
    );
    return {
      tokenCall: {
        contract: f.policy.tokenId!,
        method: "ft_transfer_call",
        args: {
          receiver_id: f.policy.registry,
          amount: "1500",
          msg: JSON.stringify({
            vault: f.vault,
            recipient: f.recipient,
            disclosure_root: disclosureRoot,
            proof: Buffer.alloc(256).toString("base64"),
            public_inputs: ["42", "2", "3", context, domain],
          }),
        },
        attachedYoctoNear: "1",
        gas: "300000000000000",
      },
    };
  }
  assert.equal(
    (await matchInvoicePlan(await plan(root), i, f.payer)).reference.kind,
    "withdrawal",
  );
  await assert.rejects(
    () => plan("ff".repeat(32)).then((p) => matchInvoicePlan(p, i, f.payer)),
    /invoice root/,
  );
});
test("browser invoice totals cannot claim paid without matching confirmed principal", async () => {
  const f = await indexed(1);
  try {
    await f.worker.sync();
    const status = await indexedInvoiceStatus(
      f.store,
      f.policy,
      f.request,
      before,
    );
    assert.equal(
      validateInvoiceStatus(status, f.invoice).state,
      "awaiting_payment",
    );
    assert.throws(
      () => validateInvoiceStatus({ ...status, state: "paid" }, f.invoice),
      /state/,
    );
    assert.throws(
      () =>
        validateInvoiceStatus({ ...status, paidTokens: "1000000" }, f.invoice),
      /totals/,
    );
  } finally {
    f.store.close();
  }
});
