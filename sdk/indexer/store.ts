import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../client/crypto.js";
import { SharedPolicySchema, type SharedPolicy } from "../shared.js";
import { recordFingerprint } from "../evidence.js";
import {
  ActivityQuery,
  InvoiceActivityQuery,
  CheckpointSchema,
  IndexError,
  IndexTxRef,
  ProvenanceSchema,
  FinalBlockSchema,
  sharedRecord,
  type ActivityItem,
  type Checkpoint,
  type Provenance,
} from "./types.js";
import type { ChainRecord } from "../evidence.js";
import { DiscoveryState } from './discovery.js';
export interface ActivityReader {
  readonly policy: SharedPolicy;
  status(): unknown;
  activity(query: ActivityQuery): unknown;
  invoiceActivity?(query: InvoiceActivityQuery): unknown;
}
const Cursor = z
  .object({
    version: z.literal(1),
    epoch: z.string().uuid(),
    upper: z.number().int().nonnegative().safe(),
    before: z.number().int().nonnegative().safe(),
    filters: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export class IndexStore implements ActivityReader {
  readonly policy: SharedPolicy;
  private db: DatabaseSync;
  private epoch: string;
  constructor(
    filename: string,
    policy: SharedPolicy,
    readonly readOnly = false,
  ) {
    this.policy = SharedPolicySchema.parse(policy);
    if (filename !== ":memory:") {
      const path = resolve(filename);
      if (!readOnly) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try {
          closeSync(openSync(path, "wx", 0o600));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
      const info = lstatSync(path);
      if (!info.isFile())
        throw new Error("Index database must be a regular file");
      filename = path;
    }
    this.db = new DatabaseSync(filename, { readOnly });
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (tables.length) {
        if (!tables.some((t) => t.name === "metadata"))
          throw new Error("Refusing an unrelated SQLite database");
        const existing = this.db
          .prepare("SELECT * FROM metadata WHERE id=1")
          .get();
        if (
          !existing ||
          existing.version !== 1 ||
          existing.policy !== canonical(this.policy)
        )
          throw new Error("Index schema or trusted policy mismatch");
      }
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
      if (readOnly) this.db.exec("PRAGMA query_only=ON;");
      else {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,policy TEXT NOT NULL,epoch TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records (record_index INTEGER PRIMARY KEY,kind TEXT NOT NULL,vault TEXT,recipient TEXT,nullifier TEXT,commitment TEXT,body TEXT NOT NULL,fingerprint TEXT NOT NULL,observed_at TEXT NOT NULL,provenance TEXT);
          CREATE INDEX IF NOT EXISTS record_kind ON records(kind,record_index);
          CREATE INDEX IF NOT EXISTS record_vault ON records(vault,record_index);
          CREATE INDEX IF NOT EXISTS record_nullifier ON records(nullifier,record_index);
          CREATE INDEX IF NOT EXISTS record_commitment ON records(commitment,record_index);
          CREATE INDEX IF NOT EXISTS record_recipient ON records(recipient,record_index);
          CREATE TABLE IF NOT EXISTS candidates (hash TEXT NOT NULL,signer TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,last_attempt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(hash,signer));
          CREATE TABLE IF NOT EXISTS discovery (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);`);
        this.db.exec('BEGIN IMMEDIATE');
        try{
          if(!this.db.prepare('PRAGMA table_info(records)').all().some(c=>c.name==='disclosure_root'))this.db.exec('ALTER TABLE records ADD COLUMN disclosure_root TEXT');
          this.db.exec("UPDATE records SET disclosure_root=json_extract(body,'$.disclosure_root') WHERE disclosure_root IS NULL; CREATE INDEX IF NOT EXISTS record_disclosure_root ON records(disclosure_root,kind,recipient,record_index); COMMIT");
        }catch(error){this.db.exec('ROLLBACK');throw error;}
        this.db
          .prepare("INSERT OR IGNORE INTO metadata VALUES (1,1,?,?)")
          .run(canonical(this.policy), randomUUID());
      }
      const meta = this.db.prepare("SELECT * FROM metadata WHERE id=1").get();
      if (
        !meta ||
        meta.version !== 1 ||
        meta.policy !== canonical(this.policy) ||
        typeof meta.epoch !== "string"
      )
        throw new Error("Index schema or trusted policy mismatch");
      this.epoch = meta.epoch;
      this.readSnapshot(() => {
        const cp = this.checkpoint(),
          count = this.db
            .prepare(
              "SELECT COUNT(*) AS n,MAX(record_index) AS last FROM records",
            )
            .get()!;
        if (
          Number(count.n) !== (cp?.nextIndex ?? 0) ||
          (count.n !== 0 && Number(count.last) !== cp!.nextIndex - 1)
        )
          throw new Error("Index checkpoint and records disagree");
      });
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  private readSnapshot<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private transaction<T>(fn: () => T): T {
    if (this.readOnly) throw new Error("Index is read-only");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  checkpoint(): Checkpoint | null {
    const row = this.db.prepare("SELECT body FROM checkpoint WHERE id=1").get();
    return row ? CheckpointSchema.parse(JSON.parse(String(row.body))) : null;
  }
  record(index: number): ActivityItem | null {
    const row = this.db
      .prepare("SELECT * FROM records WHERE record_index=?")
      .get(index);
    return row ? this.item(row) : null;
  }
  private item(row: Record<string, unknown>): ActivityItem {
    const record = sharedRecord(
      JSON.parse(String(row.body)),
      this.policy.tokenId,
      this.policy.denomination,
    );
    if (recordFingerprint(record) !== row.fingerprint)
      throw new Error("Stored record fingerprint mismatch");
    return {
      record,
      observedAt: FinalBlockSchema.parse(JSON.parse(String(row.observed_at))),
      provenance: row.provenance
        ? ProvenanceSchema.parse(JSON.parse(String(row.provenance)))
        : null,
    };
  }
  commit(
    expected: Checkpoint | null,
    next: Checkpoint,
    records: ChainRecord[],
  ) {
    next = CheckpointSchema.parse(next);
    const start = expected?.nextIndex ?? 0;
    if (
      next.nextIndex !== start + records.length ||
      records.some((r, i) => r.index !== start + i)
    )
      throw new IndexError("RECORD_MISMATCH", "Noncontiguous index batch");
    if (
      expected &&
      (next.block.height < expected.block.height ||
        next.sourceRecordCount < expected.sourceRecordCount ||
        (next.block.height === expected.block.height &&
          next.block.hash !== expected.block.hash))
    )
      throw new IndexError("FINALITY_CONFLICT", "Checkpoint regression");
    if (records.some((r) => r.block_height > next.block.height))
      throw new IndexError(
        "RECORD_MISMATCH",
        "Record exceeds the finalized checkpoint",
      );
    return this.transaction(() => {
      if (canonical(this.checkpoint()) !== canonical(expected))
        throw new IndexError(
          "INDEX_CONFLICT",
          "Another worker advanced the checkpoint",
        );
      const insert = this.db.prepare(
          "INSERT INTO records(record_index,kind,vault,recipient,nullifier,commitment,body,fingerprint,observed_at,disclosure_root) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (const input of records) {
        const r = sharedRecord(
          input,
          this.policy.tokenId,
          this.policy.denomination,
        );
        insert.run(
          r.index,
          r.kind,
          r.vault ?? null,
          r.recipient,
          r.nullifier,
          r.commitment,
          canonical(r),
          recordFingerprint(r),
          canonical(next.block),
          r.disclosure_root,
        );
      }
      this.db
        .prepare(
          "INSERT INTO checkpoint VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(canonical(next));
      return next;
    });
  }
  enqueue(refs: IndexTxRef[]) {
    if (refs.length > 1000)
      throw new Error("Enqueue at most 1000 public transaction references");
    const parsed = refs.map((r) => IndexTxRef.parse(r));
    this.transaction(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO candidates(hash,signer) VALUES(?,?)",
      );
      for (const r of parsed) insert.run(r.hash, r.signer);
      if (
        Number(
          this.db.prepare("SELECT COUNT(*) AS n FROM candidates").get()!.n,
        ) > 10000
      )
        throw new Error("Transaction candidate capacity reached");
    });
  }
  discovery():DiscoveryState|null{
    if(!this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='discovery'").get())return null;
    const row=this.db.prepare('SELECT body FROM discovery WHERE id=1').get();return row?DiscoveryState.parse(JSON.parse(String(row.body))):null;
  }
  advanceDiscovery(expected:DiscoveryState|null,next:DiscoveryState,refs:IndexTxRef[]=[]){
    next=DiscoveryState.parse(next);const parsed=refs.map(r=>IndexTxRef.parse(r));
    this.transaction(()=>{if(canonical(this.discovery())!==canonical(expected))throw new IndexError('INDEX_CONFLICT','Another worker advanced discovery');
      const insert=this.db.prepare('INSERT OR IGNORE INTO candidates(hash,signer) VALUES(?,?)');for(const r of parsed)insert.run(r.hash,r.signer);
      if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM candidates').get()!.n)>10000)throw new Error('Transaction candidate capacity reached');
      this.db.prepare('INSERT INTO discovery VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(canonical(next));
    });
  }
  pending(limit: number): IndexTxRef[] {
    z.number().int().min(1).max(100).parse(limit);
    return this.db
      .prepare(
        "SELECT hash,signer FROM candidates WHERE state='pending' ORDER BY last_attempt,hash,signer LIMIT ?",
      )
      .all(limit)
      .map((r) => IndexTxRef.parse(r));
  }
  finishCandidate(
    ref: IndexTxRef,
    state: "pending" | "linked" | "unrelated" | "invalid",
    error: string | null,
    links: {
      index: number;
      fingerprint: string;
      provenance: Provenance;
    }[] = [],
  ) {
    this.transaction(() => {
      for (const link of links) {
        link.provenance = ProvenanceSchema.parse(link.provenance);
        if (canonical(link.provenance.transaction) !== canonical(ref))
          throw new IndexError(
            "RECORD_MISMATCH",
            "Provenance transaction differs from its candidate",
          );
        const row = this.db
          .prepare(
            "SELECT fingerprint,provenance FROM records WHERE record_index=?",
          )
          .get(link.index);
        if (!row || row.fingerprint !== link.fingerprint)
          throw new IndexError(
            "RECORD_MISMATCH",
            "Provenance no longer matches the stored record",
          );
        if (row.provenance) {
          const p = JSON.parse(String(row.provenance)) as Provenance;
          if (canonical(p.transaction) !== canonical(ref))
            throw new IndexError(
              "RECORD_MISMATCH",
              "A different transaction already anchors this record",
            );
        }
        this.db
          .prepare("UPDATE records SET provenance=? WHERE record_index=?")
          .run(canonical(link.provenance), link.index);
      }
      const change = this.db
        .prepare(
          "UPDATE candidates SET state=?,error=?,attempts=attempts+1,last_attempt=? WHERE hash=? AND signer=?",
        )
        .run(state, error, Date.now(), ref.hash, ref.signer);
      if (change.changes !== 1) throw new Error("Candidate was not enqueued");
    });
  }
  private statusSnapshot() {
    const checkpoint = this.checkpoint(),
      counts = this.db
        .prepare(
          "SELECT COUNT(*) AS total,SUM(provenance IS NOT NULL) AS linked FROM records",
        )
        .get()!,
      candidates = this.db
        .prepare("SELECT state,COUNT(*) AS n FROM candidates GROUP BY state")
        .all();
    return {
      enabled: true,
      policy: this.policy,
      checkpoint,
      indexedRecords: Number(counts.total),
      linkedRecords: Number(counts.linked ?? 0),
      remainingRecords: checkpoint
        ? checkpoint.sourceRecordCount - checkpoint.nextIndex
        : null,
      discovery:{enabled:this.discovery()!==null,state:this.discovery()},
      candidates: Object.fromEntries(
        candidates.map((r) => [r.state, Number(r.n)]),
      ),
      scope: "configured_registry_records" as const,
      claims: { completeBusinessHistory: false, taxFilingAccepted: false },
      chainFreshnessChecked: false,
    };
  }
  status() {
    return this.readSnapshot(() => this.statusSnapshot());
  }
  activity(input: ActivityQuery) {
    return this.readSnapshot(() => this.activitySnapshot(input));
  }
  invoiceActivity(input: InvoiceActivityQuery) {
    return this.readSnapshot(() => this.activitySnapshot(input, true));
  }
  private activitySnapshot(input: ActivityQuery | InvoiceActivityQuery, invoice = false) {
    const query = invoice ? InvoiceActivityQuery.parse(input) : ActivityQuery.parse(input),
      { cursor, limit, ...filters } = query,
      checkpoint = this.checkpoint();
    if (!checkpoint)
      throw new IndexError(
        "INDEX_NOT_READY",
        "Index has not completed its first finalized read",
      );
    // Cursor hashes are not authentication. They bind public pagination to one filter set and database generation.
    const filterHash = sha256Sync(canonical(filters));
    let upper = checkpoint.nextIndex,
      before = upper;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("encoding");
        const c = Cursor.parse(
          JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
        );
        if (
          c.epoch !== this.epoch ||
          c.filters !== filterHash ||
          c.upper > upper ||
          c.before > c.upper
        )
          throw new Error("binding");
        upper = c.upper;
        before = c.before;
      } catch {
        throw new IndexError(
          "INVALID_CURSOR",
          "Cursor does not match this database, snapshot or filter",
        );
      }
    }
    const where = ["record_index < ?", "record_index < ?"],
      params: (string | number)[] = [upper, before];
    for (const [key, value] of Object.entries(filters)) {
      if (key === 'disclosure_roots') {
        const roots = value as string[];
        where.push(`disclosure_root IN (${roots.map(() => '?').join(',')})`);
        params.push(...roots);
      } else {
        where.push(`${key} = ?`);
        params.push(value as string);
      }
    }
    const rows = this.db
        .prepare(
          `SELECT * FROM records${invoice ? ' INDEXED BY record_disclosure_root' : ''} WHERE ${where.join(" AND ")} ORDER BY record_index DESC LIMIT ?`,
        )
        .all(...params, limit + 1),
      items = rows.slice(0, limit).map((row) => this.item(row));
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            canonical({
              version: 1,
              epoch: this.epoch,
              upper,
              before: items.at(-1)!.record.index,
              filters: filterHash,
            }),
          ).toString("base64url")
        : null;
    return {
      items,
      nextCursor,
      snapshot: { upperExclusive: upper },
      index: this.statusSnapshot(),
      scope: "configured_registry_records" as const,
      note: "Journal events are not all completed payouts. Provenance is present only after a matching finalized receipt is verified.",
    };
  }
}
function sha256Sync(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
