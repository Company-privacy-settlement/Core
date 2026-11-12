import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createReadOnlyApi } from "../server/api.js";
import { IndexStore } from "../sdk/indexer/store.js";
import { SettlementIndexer } from "../sdk/indexer/worker.js";
import { indexFixture } from "./fixtures/indexer.js";
async function api(
  t: { after(fn: () => Promise<void>): void },
  indexed = true,
) {
  const f = indexFixture(),
    store = new IndexStore(":memory:", f.policy),
    worker = new SettlementIndexer(f.source, store);
  f.records.push(f.record(0), f.record(1), f.record(2));
  if (indexed) await worker.sync();
  const server = createReadOnlyApi({
    source: f.source,
    policy: f.policy,
    index: store,
    allowedOrigins: ["http://localhost:3000"],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  return { ...f, store, worker, url: `http://127.0.0.1:${address.port}` };
}
test("activity API pages public records with explicit provenance and snapshot scope", async (t) => {
  const f = await api(t);
  f.store.enqueue([f.ref]);
  f.transactions.set(f.ref.hash, f.transaction());
  await f.worker.linkPending();
  const response = await fetch(f.url + "/v1/activity?limit=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const first = await response.json();
  assert.equal(first.items[0].record.index, 2);
  assert.equal(first.items[0].provenance.transaction.hash, f.ref.hash);
  assert.equal(first.scope, "configured_registry_records");
  assert.equal(first.index.chainFreshnessChecked, false);
  assert.equal(first.index.claims.completeBusinessHistory, false);
  f.state.height = 21;
  f.records.push(f.record(3));
  await f.worker.sync();
  const second = await (
    await fetch(f.url + `/v1/activity?limit=2&cursor=${first.nextCursor}`)
  ).json();
  assert.deepEqual(
    second.items.map((r: any) => r.record.index),
    [1, 0],
  );
  assert.equal(second.snapshot.upperExclusive, 3);
  const status = await (await fetch(f.url + "/v1/index/status")).json();
  assert.equal(status.indexedRecords, 4);
  assert.equal(status.linkedRecords, 3);
  assert.equal(status.remainingRecords, 0);
});
test("activity API rejects duplicate queries, wrong cursor/filter, invalid limits and write routes", async (t) => {
  const f = await api(t),
    first = await (await fetch(f.url + "/v1/activity?limit=1")).json();
  for (const path of [
    "/v1/activity?limit=51",
    "/v1/activity?limit=1&limit=2",
    "/v1/activity?rpcUrl=http://internal",
    "/v1/index/status?secret=x",
    `/v1/activity?cursor=${first.nextCursor}&kind=transfer`,
    "/v1/activity?cursor=malformed",
  ])
    assert.equal((await fetch(f.url + path)).status, 400, path);
  assert.equal(
    (
      await fetch(f.url + "/v1/activity", {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.url + "/v1/index/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ privateKey: "not-accepted" }),
      })
    ).status,
    404,
  );
});
test("uninitialized index has no fabricated activity and activity reads never query the chain", async (t) => {
  const f = await api(t, false);
  assert.equal((await fetch(f.url + "/v1/activity")).status, 503);
  const status = await (await fetch(f.url + "/v1/index/status")).json();
  assert.equal(status.checkpoint, null);
  await f.worker.sync();
  f.source.finalBlock = async () => {
    throw new Error("Activity must not perform chain RPC");
  };
  assert.equal((await fetch(f.url + "/v1/activity")).status, 200);
  f.store.activity = () => {
    throw new Error("Private local database path or stack");
  };
  const unavailable = await fetch(f.url + "/v1/activity");
  assert.equal(unavailable.status, 503);
  const error = await unavailable.json();
  assert.equal(error.error, "INDEX_READ_FAILED");
  assert.ok(!JSON.stringify(error).includes("Private local"));
});
test("optional index is disabled explicitly and a different policy cannot be attached to the API", async (t) => {
  const f = indexFixture(),
    server = createReadOnlyApi({ source: f.source, policy: f.policy });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/activity`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "INDEX_DISABLED");
  const other = new IndexStore(":memory:", {
    ...f.policy,
    feeRecipient: "other.test.near",
  });
  try {
    assert.throws(
      () =>
        createReadOnlyApi({ source: f.source, policy: f.policy, index: other }),
      /index does not match/,
    );
  } finally {
    other.close();
  }
});
