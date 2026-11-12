import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { IndexStore } from "../sdk/indexer/store.js";
import { SettlementIndexer } from "../sdk/indexer/worker.js";
import { NearRpcIndexSource } from "../sdk/indexer/source.js";
import { indexFixture, blockHash } from "./fixtures/indexer.js";
import type { Checkpoint } from "../sdk/indexer/types.js";
function setup(native = false) {
  const f = indexFixture(native),
    store = new IndexStore(":memory:", f.policy),
    worker = new SettlementIndexer(f.source, store);
  return { ...f, store, worker };
}
test("finalized index backfills contiguous bounded pages and resumes durably with a read-only connection", async () => {
  const f = indexFixture(),
    dir = await mkdtemp(join(tmpdir(), "core-index-")),
    path = join(dir, "activity.sqlite");
  let store: IndexStore | undefined;
  try {
    f.records.push(...Array.from({ length: 51 }, (_, i) => f.record(i)));
    store = new IndexStore(path, f.policy);
    let worker = new SettlementIndexer(f.source, store);
    let result = await worker.sync({ maxPages: 1 });
    assert.equal(result.added, 50);
    assert.equal(result.remainingRecords, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    store.close();
    store = undefined;
    store = new IndexStore(path, f.policy);
    worker = new SettlementIndexer(f.source, store);
    result = await worker.sync({ maxPages: 1 });
    assert.equal(result.added, 1);
    assert.equal(result.indexedRecords, 51);
    assert.equal(result.remainingRecords, 0);
    const reader = new IndexStore(path, f.policy, true);
    try {
      assert.equal(reader.activity({ limit: 2 }).items[0].record.index, 50);
      assert.throws(() => reader.enqueue([f.ref]), /read-only/);
    } finally {
      reader.close();
    }
    result = await worker.sync();
    assert.equal(result.added, 0);
    assert.equal(result.indexedRecords, 51);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("a bad middle record rolls back its whole page and never advances the checkpoint", async () => {
  const f = setup();
  try {
    f.records.push(f.record(0), f.record(1, { protocol_fee_earned: "0" }));
    await assert.rejects(() => f.worker.sync(), /fees/);
    assert.equal(f.store.checkpoint(), null);
    assert.equal(f.store.record(0), null);
    const valid = [f.record(0), f.record(1, { protocol_fee_earned: "0" })],
      cp: Checkpoint = {
        block: { hash: blockHash(20), height: 20 },
        nextIndex: 2,
        sourceRecordCount: 2,
        updatedAt: new Date().toISOString(),
      };
    assert.throws(() => f.store.commit(null, cp, valid), /fees/);
    assert.equal(f.store.checkpoint(), null);
    assert.equal(f.store.record(0), null);
  } finally {
    f.store.close();
  }
});
test("missing/reordered pages and records above the finalized block fail closed", async () => {
  for (const mode of ["short", "reordered", "future"] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0), f.record(1));
      if (mode === "reordered") f.records.reverse();
      if (mode === "future") f.records[1].block_height = 21;
      if (mode === "short") {
        const view = f.source.contractView;
        f.source.contractView = async (a, m, args, b) =>
          m === "get_records" ? [] : view(a, m, args, b);
      }
      await assert.rejects(() => f.worker.sync());
      assert.equal(f.store.checkpoint(), null);
    } finally {
      f.store.close();
    }
  }
});
test("changed finalized hash, regressed head, decreasing record count and changed tail never rewrite history", async () => {
  for (const mode of [
    "hash",
    "head",
    "count",
    "tail",
    "same-block-growth",
  ] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0));
      await f.worker.sync();
      const cp = f.store.checkpoint();
      f.state.height = 21;
      if (mode === "hash")
        f.source.blockAt = async (h) => ({ height: h, hash: blockHash(999) });
      if (mode === "head") f.state.height = 19;
      if (mode === "same-block-growth") {
        f.state.height = 20;
        f.records.push(f.record(1));
      }
      if (mode === "count") f.records.length = 0;
      if (mode === "tail") f.records[0].disclosure_root = "cd".repeat(32);
      await assert.rejects(
        () => f.worker.sync(),
        (e) =>
          !!e &&
          typeof e === "object" &&
          "code" in e &&
          e.code === (mode === "head" ? "STALE_FINALITY" : "FINALITY_CONFLICT"),
      );
      assert.deepEqual(f.store.checkpoint(), cp);
      assert.equal(f.store.record(0)!.record.disclosure_root, "ab".repeat(32));
    } finally {
      f.store.close();
    }
  }
});
test("index verifies group policy, asset and named vault before recording an event", async () => {
  for (const mode of ["code", "keys", "asset", "vault"] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0));
      if (mode === "code") f.source.codeSha256 = async () => "00".repeat(32);
      if (mode === "keys") f.source.accessKeys = async () => [{}];
      if (mode === "asset") f.records[0].asset_token_id = "other.test.near";
      if (mode === "vault") f.records[0].vault = "other.test.near";
      await assert.rejects(() => f.worker.sync());
      assert.equal(f.store.checkpoint(), null);
    } finally {
      f.store.close();
    }
  }
});
test("compare-and-swap checkpoint refuses a second worker using a stale snapshot", async () => {
  const f = setup();
  try {
    const cp: Checkpoint = {
      block: { height: 20, hash: blockHash(20) },
      nextIndex: 1,
      sourceRecordCount: 1,
      updatedAt: new Date().toISOString(),
    };
    f.store.commit(null, cp, [f.record(0)]);
    assert.throws(
      () => f.store.commit(null, cp, [f.record(0)]),
      /Another worker/,
    );
    assert.equal(f.store.status().indexedRecords, 1);
  } finally {
    f.store.close();
  }
});
test("stable filtered pagination excludes later appends and rejects malformed or cross-filter cursors", async () => {
  const f = setup();
  try {
    f.records.push(f.record(0), f.record(1), f.record(2));
    await f.worker.sync();
    const page = f.store.activity({ limit: 1, kind: "deposit" });
    assert.equal(page.items[0].record.index, 2);
    assert.ok(page.nextCursor);
    f.state.height = 21;
    f.records.push(f.record(3));
    await f.worker.sync();
    const next = f.store.activity({
      limit: 2,
      kind: "deposit",
      cursor: page.nextCursor,
    });
    assert.deepEqual(
      next.items.map((r) => r.record.index),
      [1, 0],
    );
    assert.equal(next.snapshot.upperExclusive, 3);
    assert.equal(next.nextCursor, null);
    assert.throws(
      () => f.store.activity({ cursor: page.nextCursor!, kind: "transfer" }),
      /Cursor/,
    );
    assert.throws(() => f.store.activity({ cursor: "..bad" }), /Cursor/);
    assert.throws(() => f.store.activity({ limit: 51 }));
    assert.equal(
      f.store.activity({ vault: f.vault, commitment: "2" }).items.length,
      1,
    );
  } finally {
    f.store.close();
  }
});
test("policy mismatch is rejected on reopen and a rebuilt database invalidates old cursors", async () => {
  const f = indexFixture(),
    dir = await mkdtemp(join(tmpdir(), "core-index-")),
    path = join(dir, "index.sqlite");
  try {
    const first = new IndexStore(path, f.policy);
    first.commit(
      null,
      {
        block: { height: 20, hash: blockHash(20) },
        nextIndex: 2,
        sourceRecordCount: 2,
        updatedAt: new Date().toISOString(),
      },
      [f.record(0), f.record(1)],
    );
    const cursor = first.activity({ limit: 1 }).nextCursor!;
    first.close();
    assert.throws(
      () =>
        new IndexStore(path, { ...f.policy, feeRecipient: "other.test.near" }),
      /policy mismatch/,
    );
    const rebuilt = new IndexStore(":memory:", f.policy);
    try {
      rebuilt.commit(
        null,
        {
          block: { height: 20, hash: blockHash(20) },
          nextIndex: 0,
          sourceRecordCount: 0,
          updatedAt: new Date().toISOString(),
        },
        [],
      );
      assert.throws(() => rebuilt.activity({ cursor }), /Cursor/);
    } finally {
      rebuilt.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("finalized receipts correlate transactions to immutable records and failed outer transactions remain explicit", async () => {
  for (const failed of [false, true]) {
    const f = setup();
    try {
      f.records.push(f.record(0), f.record(1));
      await f.worker.sync();
      f.store.enqueue([f.ref, f.ref]);
      const tx = f.transaction();
      if (failed)
        (tx as unknown as { status: unknown }).status = {
          Failure: { ActionError: {} },
        };
      f.transactions.set(f.ref.hash, tx);
      assert.deepEqual(await f.worker.linkPending(), {
        linked: 1,
        pending: 0,
        unrelated: 0,
        invalid: 0,
        readErrors: 0,
      });
      assert.equal(f.store.status().linkedRecords, 2);
      const item = f.store.record(0)!;
      assert.equal(item.provenance!.transaction.hash, f.ref.hash);
      assert.equal(
        item.provenance!.outerOutcome,
        failed ? "failed" : "succeeded",
      );
      assert.equal(item.provenance!.receipts.length, 1);
      assert.equal(item.provenance!.receipts[0].blockHash, blockHash(10));
      assert.equal((await f.worker.linkPending()).linked, 0);
    } finally {
      f.store.close();
    }
  }
});
test("non-final, unknown, future-to-index and upstream-failed transaction lookups remain retryable", async () => {
  for (const mode of ["unknown", "optimistic", "future", "rpc"] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0));
      if (mode !== "future") await f.worker.sync();
      else await f.worker.sync({ maxPages: 1 });
      f.store.enqueue([f.ref]);
      if (mode === "optimistic")
        f.transactions.set(f.ref.hash, {
          ...f.transaction(),
          final_execution_status: "EXECUTED",
        });
      if (mode === "future") {
        f.records.push(f.record(1));
        f.transactions.set(f.ref.hash, f.transaction());
      }
      if (mode === "rpc")
        f.source.transaction = async () => {
          throw new Error("secret RPC URL");
        };
      const result = await f.worker.linkPending();
      assert.equal(result.pending, 1);
      assert.equal(f.store.status().linkedRecords, 0);
      assert.equal(f.store.pending(10).length, 1);
      f.source.transaction = async () => f.transaction();
      f.state.height = 21;
      await f.worker.sync();
      assert.equal((await f.worker.linkPending()).linked, 1);
    } finally {
      f.store.close();
    }
  }
});
test("wrong signer, forged record and conflicting receipt block cannot become provenance", async () => {
  for (const mode of ["signer", "record", "block"] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0));
      await f.worker.sync();
      f.store.enqueue([f.ref]);
      const tx = f.transaction();
      if (mode === "signer") tx.transaction.signer_id = "other.test.near";
      if (mode === "record")
        tx.receipts_outcome[0].outcome.logs[0] =
          tx.receipts_outcome[0].outcome.logs[0].replace(
            '"amount":"1000000"',
            '"amount":"1000001"',
          );
      if (mode === "block") tx.receipts_outcome[0].block_hash = blockHash(999);
      f.transactions.set(f.ref.hash, tx);
      assert.equal((await f.worker.linkPending()).invalid, 1);
      assert.equal(f.store.record(0)!.provenance, null);
    } finally {
      f.store.close();
    }
  }
});
test("spoofed executor and failed receipt logs are excluded without claiming a payout", async () => {
  for (const mode of ["executor", "failure"] as const) {
    const f = setup();
    try {
      f.records.push(f.record(0));
      await f.worker.sync();
      f.store.enqueue([f.ref]);
      const tx = f.transaction();
      if (mode === "executor")
        tx.receipts_outcome[0].outcome.executor_id = "evil.test.near";
      else
        (
          tx.receipts_outcome[0].outcome as unknown as { status: unknown }
        ).status = { Failure: {} };
      f.transactions.set(f.ref.hash, tx);
      assert.equal((await f.worker.linkPending()).unrelated, 1);
      assert.equal(f.store.status().linkedRecords, 0);
      assert.equal(f.store.status().claims.completeBusinessHistory, false);
    } finally {
      f.store.close();
    }
  }
});
test("native shared v2 records are indexed with the same finality and provenance rules", async () => {
  const f = setup(true);
  try {
    f.records.push(f.record(0));
    await f.worker.sync();
    f.store.enqueue([f.ref]);
    f.transactions.set(f.ref.hash, f.transaction());
    assert.equal((await f.worker.linkPending()).linked, 1);
    assert.equal(f.store.record(0)!.record.asset_token_id, null);
  } finally {
    f.store.close();
  }
});
test("cancellation before a write leaves its durable checkpoint untouched", async () => {
  const f = setup();
  try {
    f.records.push(f.record(0));
    const controller = new AbortController(),
      view = f.source.contractView;
    f.source.contractView = async (a, m, args, b) => {
      const result = await view(a, m, args, b);
      if (m === "get_records") controller.abort();
      return result;
    };
    await assert.rejects(
      () => f.worker.sync({ signal: controller.signal }),
      /abort/i,
    );
    assert.equal(f.store.checkpoint(), null);
  } finally {
    f.store.close();
  }
});
test("RPC index source uses canonical block heights and preserves archival-node errors", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let fail = false;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.params, { block_id: 20 });
    return new Response(
      JSON.stringify(
        fail
          ? { error: { cause: { name: "UNKNOWN_BLOCK" } } }
          : {
              result: {
                header: {
                  height: 20,
                  hash: blockHash(20),
                  extra: "valid real RPC field",
                },
              },
            },
      ),
    );
  };
  const source = new NearRpcIndexSource(
    "sandbox",
    "forest.test.near",
    "http://127.0.0.1:1",
  );
  assert.deepEqual(await source.blockAt(20), {
    height: 20,
    hash: blockHash(20),
  });
  fail = true;
  await assert.rejects(() => source.blockAt(20), /UNKNOWN_BLOCK/);
});
test("a corrupt on-disk checkpoint is refused instead of inventing a recovery offset", async () => {
  const f = indexFixture(),
    dir = await mkdtemp(join(tmpdir(), "core-index-")),
    path = join(dir, "index.sqlite");
  try {
    const store = new IndexStore(path, f.policy);
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO checkpoint VALUES(1,?)").run(
      JSON.stringify({
        block: { height: 20, hash: blockHash(20) },
        nextIndex: 1,
        sourceRecordCount: 1,
        updatedAt: new Date().toISOString(),
      }),
    );
    raw.close();
    assert.throws(() => new IndexStore(path, f.policy), /disagree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending provenance survives a process-style reopen and links after indexing catches up", async () => {
  const f = indexFixture(),
    dir = await mkdtemp(join(tmpdir(), "core-index-")),
    path = join(dir, "index.sqlite");
  let store: IndexStore | undefined;
  try {
    store = new IndexStore(path, f.policy);
    f.records.push(f.record(0));
    let worker = new SettlementIndexer(f.source, store);
    await worker.sync();
    store.enqueue([f.ref]);
    assert.equal((await worker.linkPending()).pending, 1);
    store.close();
    store = undefined;
    store = new IndexStore(path, f.policy);
    assert.deepEqual(store.pending(10), [f.ref]);
    f.transactions.set(f.ref.hash, f.transaction());
    worker = new SettlementIndexer(f.source, store);
    assert.equal((await worker.linkPending()).linked, 1);
    assert.equal(store.status().linkedRecords, 1);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("an unrelated SQLite file is refused without adding index tables", async () => {
  const f = indexFixture(),
    dir = await mkdtemp(join(tmpdir(), "core-index-")),
    path = join(dir, "other.sqlite");
  try {
    let raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve');",
    );
    raw.close();
    assert.throws(() => new IndexStore(path, f.policy), /unrelated/);
    raw = new DatabaseSync(path);
    try {
      assert.deepEqual(
        raw
          .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
          .all()
          .map((r) => r.name),
        ["unrelated"],
      );
      assert.equal(
        raw.prepare("SELECT value FROM unrelated").get()!.value,
        "preserve",
      );
    } finally {
      raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("provenance cannot advance on a changed finalized checkpoint or replace an existing transaction", async () => {
  const f = setup();
  try {
    f.records.push(f.record(0));
    await f.worker.sync();
    f.store.enqueue([f.ref]);
    f.transactions.set(f.ref.hash, f.transaction());
    const blockAt = f.source.blockAt;
    f.source.blockAt = async (h) => ({ height: h, hash: blockHash(999) });
    await assert.rejects(() => f.worker.linkPending(), /changed finalized/);
    assert.equal(f.store.status().linkedRecords, 0);
    assert.equal(f.store.pending(1).length, 1);
    f.source.blockAt = blockAt;
    await f.worker.linkPending();
    const other = { hash: blockHash(888), signer: f.payer },
      transaction = f.transaction();
    transaction.transaction.hash = other.hash;
    f.store.enqueue([other]);
    f.transactions.set(other.hash, transaction);
    assert.equal((await f.worker.linkPending()).invalid, 1);
    assert.equal(f.store.record(0)!.provenance!.transaction.hash, f.ref.hash);
  } finally {
    f.store.close();
  }
});
