import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexStore } from "../sdk/indexer/store.js";
import { SettlementIndexer } from "../sdk/indexer/worker.js";
import {
  TransactionDiscovery,
  type DiscoverySource,
  type ScanBlock,
} from "../sdk/indexer/discovery.js";
import { NearRpcIndexSource } from "../sdk/indexer/source.js";
import { parseActivityPage, parseIndexStatus } from "../sdk/client/activity.js";
import { indexFixture, blockHash } from "./fixtures/indexer.js";
async function setup(path = ":memory:") {
  const f = indexFixture(),
    store = new IndexStore(path, f.policy);
  f.records.push(f.record(0));
  await new SettlementIndexer(f.source, store).sync();
  const tx = f.transaction();
  const graph = {
    ...tx,
    transaction: { ...tx.transaction, receiver_id: "wrapper.test.near" },
    transaction_outcome: {
      outcome: { receipt_ids: tx.receipts_outcome.map((r) => r.id) },
    },
    receipts_outcome: tx.receipts_outcome.map((r) => ({
      ...r,
      outcome: { ...r.outcome, receipt_ids: [] as string[] },
    })),
  };
  f.transactions.set(f.ref.hash, graph);
  const source: DiscoverySource = {
    ...f.source,
    scanBlock: async (height) => ({
      block: { height, hash: blockHash(height) },
      previousHash: blockHash(height - 1),
      transactions: height === 9 ? [f.ref] : [],
    }),
  };
  const scanner = new TransactionDiscovery(source, store);
  return { ...f, store, source, scanner, graph };
}
test("all-shard discovery finds wrapper-originated settlement candidates and the normal verifier links them", async () => {
  const f = await setup();
  try {
    const result = await f.scanner.scan({ startHeight: 9, maxBlocks: 1 });
    assert.equal(result.processed, 1);
    assert.equal(result.state.lastComplete!.height, 9);
    assert.deepEqual(f.store.pending(10), [f.ref]);
    assert.equal(f.store.status().linkedRecords, 0);
    await new SettlementIndexer(f.source, f.store).linkPending();
    assert.equal(f.store.status().linkedRecords, 1);
    assert.equal(f.store.status().discovery.state!.candidatesFound, 1);
  } finally {
    f.store.close();
  }
});
test("discovery pauses inside a block, persists its offset and does not resubmit discovered references after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-discovery-")),
    path = join(dir, "index.sqlite");
  const f = await setup(path);
  let second: IndexStore | undefined;
  try {
    const other = { hash: blockHash(777), signer: f.payer };
    f.transactions.set(other.hash, {
      ...f.graph,
      transaction: { hash: other.hash, signer_id: other.signer },
      receipts_outcome: f.graph.receipts_outcome.map((r) => ({
        ...r,
        outcome: { ...r.outcome, executor_id: "unrelated.test.near", logs: [] },
      })),
    });
    f.source.scanBlock = async (h) => ({
      block: { height: h, hash: blockHash(h) },
      previousHash: blockHash(h - 1),
      transactions: [f.ref, other],
    });
    const first = await f.scanner.scan({
      startHeight: 9,
      maxBlocks: 1,
      maxTransactions: 1,
    });
    assert.equal(first.state.current!.offset, 1);
    f.store.close();
    second = new IndexStore(path, f.policy);
    const scanner = new TransactionDiscovery(f.source, second);
    const next = await scanner.scan({
      startHeight: 9,
      maxBlocks: 1,
      maxTransactions: 1,
    });
    assert.equal(next.state.lastComplete!.height, 9);
    assert.equal(next.state.scannedTransactions, 2);
    assert.equal(next.state.candidatesFound, 1);
    assert.deepEqual(second.pending(10), [f.ref]);
  } finally {
    second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("unknown, non-final and incomplete receipt graphs keep the cursor on the unresolved transaction", async () => {
  for (const mode of ["unknown", "nonfinal", "incomplete", "rpc"] as const) {
    const f = await setup();
    try {
      if (mode === "unknown") f.transactions.clear();
      if (mode === "nonfinal")
        f.transactions.set(f.ref.hash, {
          ...f.graph,
          final_execution_status: "EXECUTED",
        });
      if (mode === "incomplete")
        f.graph.receipts_outcome[0].outcome.receipt_ids.push(blockHash(999));
      if (mode === "rpc")
        f.source.transaction = async () => {
          throw new Error("secret upstream URL");
        };
      const result = await f.scanner.scan({ startHeight: 9, maxBlocks: 1 });
      assert.equal(result.state.current!.offset, 0);
      assert.ok(result.state.blocked);
      assert.equal(f.store.pending(10).length, 0);
      f.graph.receipts_outcome[0].outcome.receipt_ids = [];
      f.source.transaction = async () => f.graph;
      assert.equal(
        (await f.scanner.scan({ startHeight: 9, maxBlocks: 1 })).state.current,
        null,
      );
    } finally {
      f.store.close();
    }
  }
});
test("a changed finalized transaction list cannot invalidate an in-block resume offset", async () => {
  const f = await setup();
  try {
    const original = f.source.scanBlock;
    f.source.scanBlock = async (h) => ({
      ...(await original(h))!,
      transactions: [f.ref, { hash: blockHash(888), signer: f.payer }],
    });
    await f.scanner.scan({ startHeight: 9, maxBlocks: 1, maxTransactions: 1 });
    f.source.scanBlock = original;
    await assert.rejects(
      () => f.scanner.scan({ startHeight: 9, maxBlocks: 1 }),
      /chunk transaction list changed/,
    );
    assert.equal(f.store.discovery()!.current!.offset, 1);
  } finally {
    f.store.close();
  }
});
test("skipped heights need a later canonical parent link; pruned intermediate blocks never count as scanned", async () => {
  for (const valid of [true, false]) {
    const f = await setup();
    try {
      await f.scanner.scan({ startHeight: 9, maxBlocks: 1 });
      f.source.scanBlock = async (h) =>
        h === 10
          ? null
          : {
              block: { height: h, hash: blockHash(h) },
              previousHash: blockHash(valid ? 9 : 10),
              transactions: [],
            };
      if (valid)
        assert.equal(
          (await f.scanner.scan({ startHeight: 9, maxBlocks: 1 })).state
            .lastComplete!.height,
          11,
        );
      else {
        await assert.rejects(
          () => f.scanner.scan({ startHeight: 9, maxBlocks: 1 }),
          /Missing canonical/,
        );
        assert.equal(f.store.discovery()!.lastComplete!.height, 9);
      }
    } finally {
      f.store.close();
    }
  }
});
test("start height is immutable, finality regression stops discovery and cancelled RPCs do not advance it", async () => {
  const f = await setup();
  try {
    await f.scanner.scan({ startHeight: 9, maxBlocks: 1 });
    await assert.rejects(
      () => f.scanner.scan({ startHeight: 8 }),
      /start is fixed/,
    );
    f.state.height = 19;
    await assert.rejects(() => f.scanner.scan({ startHeight: 9 }), /behind/);
    f.state.height = 20;
    const controller = new AbortController();
    f.source.scanBlock = async (h) => {
      controller.abort();
      return {
        block: { height: h, hash: blockHash(h) },
        previousHash: blockHash(9),
        transactions: [],
      };
    };
    await assert.rejects(
      () => f.scanner.scan({ startHeight: 9, signal: controller.signal }),
      /abort/i,
    );
    assert.equal(f.store.discovery()!.lastComplete!.height, 9);
  } finally {
    f.store.close();
  }
});
test("discovery and queue persistence use one compare-and-swap transaction", async () => {
  const f = await setup();
  try {
    await f.scanner.scan({ startHeight: 9, maxBlocks: 1 });
    const saved = f.store.discovery()!;
    assert.throws(
      () =>
        f.store.advanceDiscovery(null, saved, [
          { hash: blockHash(998), signer: f.payer },
        ]),
      /Another worker/,
    );
    assert.deepEqual(f.store.pending(10), [f.ref]);
  } finally {
    f.store.close();
  }
});
test("browser activity validation rejects changed assets, inflated fees, duplicate ordering and wrong policies", async () => {
  const f = await setup();
  try {
    const page = f.store.activity({});
    assert.equal(parseActivityPage(page, f.policy).items.length, 1);
    assert.equal(
      parseIndexStatus(f.store.status(), f.policy).indexedRecords,
      1,
    );
    for (const modify of [
      (p: any) => (p.items[0].record.asset_token_id = "evil.test.near"),
      (p: any) => (p.items[0].record.protocol_fee_charged = "1501"),
      (p: any) => p.items.push(p.items[0]),
      (p: any) => (p.index.policy.feeRecipient = "evil.test.near"),
    ]) {
      const copy = structuredClone(page);
      modify(copy);
      assert.throws(() => parseActivityPage(copy, f.policy));
    }
  } finally {
    f.store.close();
  }
});
test("RPC discovery reads all new shard chunks in deterministic order and ignores reused chunks", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: string[] = [],
    f = indexFixture();
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push(
      request.method +
        ":" +
        (request.params.chunk_id ?? request.params.block_id),
    );
    const result =
      request.method === "block"
        ? {
            header: { hash: blockHash(9), height: 9, prev_hash: blockHash(8) },
            chunks: [
              { chunk_hash: blockHash(102), shard_id: 2, height_included: 8 },
              { chunk_hash: blockHash(101), shard_id: 1, height_included: 9 },
              { chunk_hash: blockHash(100), shard_id: 0, height_included: 9 },
            ],
          }
        : {
            header: { chunk_hash: request.params.chunk_id },
            transactions: [
              { hash: request.params.chunk_id, signer_id: f.payer },
            ],
          };
    return new Response(JSON.stringify({ result }));
  };
  const source = new NearRpcIndexSource(
    "sandbox",
    f.policy.registry,
    "http://127.0.0.1:1",
  );
  const block = await source.scanBlock(9);
  assert.deepEqual(
    block!.transactions.map((t) => t.hash),
    [blockHash(100), blockHash(101)],
  );
  assert.equal(calls.length, 3);
});

test("a corrupt in-block offset and a changed upper-final block cannot advance discovery", async () => {
  const f = await setup();
  try {
    f.source.scanBlock = async (h) => ({
      block: { height: h, hash: blockHash(999) },
      previousHash: blockHash(h - 1),
      transactions: [],
    });
    await assert.rejects(
      () => f.scanner.scan({ startHeight: 20, maxBlocks: 1 }),
      /upper checkpoint/,
    );
    assert.equal(f.store.discovery()!.current, null);
    const saved = f.store.discovery()!;
    assert.throws(
      () =>
        f.store.advanceDiscovery(saved, {
          ...saved,
          current: {
            block: { height: 20, hash: blockHash(20) },
            previousHash: blockHash(19),
            offset: 2,
            total: 1,
            digest: "00".repeat(32),
          },
        }),
      /Invalid discovery cursor/,
    );
    assert.equal(f.store.discovery()!.current, null);
  } finally {
    f.store.close();
  }
});
