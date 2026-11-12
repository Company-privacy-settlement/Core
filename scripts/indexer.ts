import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SharedPolicySchema } from "../sdk/shared.js";
import { IndexStore } from "../sdk/indexer/store.js";
import { NearRpcIndexSource } from "../sdk/indexer/source.js";
import { SettlementIndexer } from "../sdk/indexer/worker.js";
import { IndexError, IndexTxRef } from "../sdk/indexer/types.js";
const mode = process.argv[2] ?? "once";
if (!["once", "watch", "status"].includes(mode) || process.argv.length > 3)
  throw new Error("Usage: npm run index -- once|watch|status");
const file = process.env.CORE_POLICY_FILE,
  db = process.env.CORE_INDEX_DB,
  rpc = process.env.CORE_RPC_URL;
if (!file || !db || (mode !== "status" && !rpc))
  throw new Error(
    "Set CORE_POLICY_FILE, CORE_INDEX_DB and CORE_RPC_URL for an actual deployment",
  );
const policy = SharedPolicySchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  ),
  store = new IndexStore(db, policy, mode === "status");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());
try {
  if (mode === "status") console.log(JSON.stringify(store.status(), null, 2));
  else {
    const worker = new SettlementIndexer(
        new NearRpcIndexSource(policy.network, policy.registry, rpc!),
        store,
      ),
      interval = z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .parse(process.env.CORE_INDEX_INTERVAL_MS ?? 5000);
    do {
      try {
        if (process.env.CORE_INDEX_TX_REFS) {
          const text = await readFile(process.env.CORE_INDEX_TX_REFS, "utf8");
          if (text.length > 200000)
            throw new Error(
              "Public transaction reference manifest is too large",
            );
          store.enqueue(z.array(IndexTxRef).max(1000).parse(JSON.parse(text)));
        }
        const synced = await worker.sync({ signal: controller.signal }),
          provenance = await worker.linkPending({ signal: controller.signal });
        console.log(
          JSON.stringify({ event: "index_sync", ...synced, provenance }),
        );
        if (mode === "once" && (provenance.readErrors > 0 || provenance.invalid > 0)) process.exitCode = 1;
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(
          JSON.stringify({
            event: "index_sync_failed",
            code:
              error instanceof IndexError ? error.code : "INDEX_READ_FAILED",
          }),
        );
        if (
          mode === "once" ||
          (error instanceof IndexError &&
            ["FINALITY_CONFLICT", "RECORD_MISMATCH"].includes(error.code))
        ) {
          process.exitCode = 1;
          break;
        }
      }
      if (mode === "once") break;
      await delay(interval, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  store.close();
}
