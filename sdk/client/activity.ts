import { canonical } from "./crypto.js";
import { object, parsePolicy, account, scalar } from "./payment.js";
import type { Policy } from "./types.js";
export const activityKinds = [
  "deposit",
  "transfer",
  "withdrawal_requested",
  "withdrawal_failed",
  "withdrawal_retried",
  "withdrawal_succeeded",
] as const;
export type ActivityKind = (typeof activityKinds)[number];
export type ActivityFilters = {
  kind?: ActivityKind;
  vault?: string;
  recipient?: string;
  nullifier?: string;
  commitment?: string;
};
type Block = { hash: string; height: number };
export type IndexStatus = {
  enabled: true;
  policy: Policy;
  checkpoint: {
    block: Block;
    nextIndex: number;
    sourceRecordCount: number;
    updatedAt: string;
  } | null;
  indexedRecords: number;
  linkedRecords: number;
  remainingRecords: number | null;
  candidates: Record<string, number>;
  discovery?: {
    enabled: boolean;
    state: {
      startHeight: number;
      lastComplete: Block | null;
      current: { block: Block; offset: number; total: number } | null;
      scannedTransactions: number;
      candidatesFound: number;
      updatedAt: string;
      blocked: string | null;
    } | null;
  };
  chainFreshnessChecked: false;
  scope: "configured_registry_records";
  claims: { completeBusinessHistory: false; taxFilingAccepted: false };
};
export type IndexedRecord = {
  index: number;
  kind: ActivityKind;
  commitment: string | null;
  nullifier: string | null;
  vault: string | null;
  recipient: string | null;
  disclosure_root: string;
  block_height: number;
  timestamp_ns: string;
  amount: string;
  asset_token_id: string | null;
  protocol_fee_charged: string;
  protocol_fee_earned: string;
  storage_fee_charged: string;
};
export type IndexedActivity = {
  record: IndexedRecord;
  observedAt: Block;
  provenance: {
    transaction: { hash: string; signer: string };
    outerOutcome: "succeeded" | "failed";
    receipts: { id: string; blockHash: string }[];
    verifiedAt: Block;
  } | null;
};
export type ActivityPage = {
  items: IndexedActivity[];
  nextCursor: string | null;
  snapshot: { upperExclusive: number };
  index: IndexStatus;
  scope: "configured_registry_records";
};
const count = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error("Invalid index count");
  return v;
};
const hash = (v: unknown): string => {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(v))
    throw new Error("Invalid chain hash");
  return v;
};
const block = (v: unknown): Block => {
  const b = object(v);
  return { hash: hash(b.hash), height: count(b.height) };
};
const time = (v: unknown): string => {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
    throw new Error("Invalid index timestamp");
  return v;
};
const atomic = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(v) ||
    v.length > 39 ||
    BigInt(v) >= 1n << 128n
  )
    throw new Error("Invalid indexed amount");
  return v;
};
export function parseIndexStatus(input: unknown, policy: Policy): IndexStatus {
  const s = object(input);
  if (
    s.enabled !== true ||
    s.scope !== "configured_registry_records" ||
    s.chainFreshnessChecked !== false ||
    canonical(parsePolicy(s.policy)) !== canonical(policy)
  )
    throw new Error("Index policy or scope mismatch");
  const claims = object(s.claims);
  if (
    claims.completeBusinessHistory !== false ||
    claims.taxFilingAccepted !== false
  )
    throw new Error("Unsupported index claim");
  const indexedRecords = count(s.indexedRecords),
    linkedRecords = count(s.linkedRecords),
    c = s.checkpoint === null ? null : object(s.checkpoint),
    checkpoint = c
      ? {
          block: block(c.block),
          nextIndex: count(c.nextIndex),
          sourceRecordCount: count(c.sourceRecordCount),
          updatedAt: time(c.updatedAt),
        }
      : null;
  if (
    linkedRecords > indexedRecords ||
    (checkpoint &&
      (checkpoint.nextIndex !== indexedRecords ||
        checkpoint.sourceRecordCount < indexedRecords)) ||
    (!checkpoint && indexedRecords !== 0) ||
    s.remainingRecords !==
      (checkpoint ? checkpoint.sourceRecordCount - indexedRecords : null)
  )
    throw new Error("Inconsistent index coverage");
  const candidates: Record<string, number> = {};
  for (const [k, v] of Object.entries(object(s.candidates))) {
    if (!["pending", "linked", "unrelated", "invalid"].includes(k))
      throw new Error("Invalid provenance queue state");
    candidates[k] = count(v);
  }
  let discovery: IndexStatus["discovery"];
  if (s.discovery !== undefined) {
    const d = object(s.discovery);
    if (typeof d.enabled !== "boolean" || d.enabled !== (d.state !== null))
      throw new Error("Invalid discovery status");
    let state: null | NonNullable<IndexStatus["discovery"]>["state"] = null;
    if (d.state !== null) {
      const x = object(d.state),
        cur = x.current === null ? null : object(x.current);
      state = {
        startHeight: count(x.startHeight),
        lastComplete: x.lastComplete === null ? null : block(x.lastComplete),
        current: cur
          ? {
              block: block(cur.block),
              offset: count(cur.offset),
              total: count(cur.total),
            }
          : null,
        scannedTransactions: count(x.scannedTransactions),
        candidatesFound: count(x.candidatesFound),
        updatedAt: time(x.updatedAt),
        blocked:
          x.blocked === null
            ? null
            : typeof x.blocked === "string" && /^[A-Z_]{1,64}$/.test(x.blocked)
              ? x.blocked
              : (() => {
                  throw new Error("Invalid discovery error");
                })(),
      };
      if (state.current && state.current.offset > state.current.total)
        throw new Error("Invalid discovery offset");
    }
    discovery = { enabled: d.enabled, state };
  }
  return {
    enabled: true,
    policy,
    checkpoint,
    indexedRecords,
    linkedRecords,
    remainingRecords: s.remainingRecords as number | null,
    candidates,
    ...(discovery ? { discovery } : {}),
    scope: "configured_registry_records",
    claims: { completeBusinessHistory: false, taxFilingAccepted: false },
    chainFreshnessChecked: false,
  };
}
export function parseActivityPage(
  input: unknown,
  policy: Policy,
): ActivityPage {
  const p = object(input),
    index = parseIndexStatus(p.index, policy),
    upper = count(object(p.snapshot).upperExclusive);
  if (
    p.scope !== "configured_registry_records" ||
    upper > index.indexedRecords ||
    !Array.isArray(p.items) ||
    p.items.length > 50 ||
    (p.nextCursor !== null &&
      (typeof p.nextCursor !== "string" ||
        p.nextCursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(p.nextCursor)))
  )
    throw new Error("Invalid activity page");
  const items = p.items.map((value): IndexedActivity => {
    const item = object(value),
      r = object(item.record),
      kind = r.kind as ActivityKind;
    if (!activityKinds.includes(kind))
      throw new Error("Unsupported journal event");
    const root = r.disclosure_root;
    if (typeof root !== "string" || !/^[a-f0-9]{64}$/.test(root))
      throw new Error("Invalid receipt root");
    const record: IndexedRecord = {
      index: count(r.index),
      kind,
      commitment: r.commitment === null ? null : scalar(r.commitment),
      nullifier: r.nullifier === null ? null : scalar(r.nullifier),
      vault: r.vault === null ? null : account(r.vault),
      recipient: r.recipient === null ? null : account(r.recipient),
      disclosure_root: root,
      block_height: count(r.block_height),
      timestamp_ns: atomic(r.timestamp_ns),
      amount: atomic(r.amount),
      asset_token_id:
        r.asset_token_id === null ? null : account(r.asset_token_id),
      protocol_fee_charged: atomic(r.protocol_fee_charged),
      protocol_fee_earned: atomic(r.protocol_fee_earned),
      storage_fee_charged: atomic(r.storage_fee_charged),
    };
    if (
      record.amount !== policy.denomination ||
      record.asset_token_id !== (policy.tokenId ?? null) ||
      record.index >= upper
    )
      throw new Error("Activity asset or snapshot mismatch");
    const fee = ((BigInt(policy.denomination) * 15n) / 10000n).toString();
    if (
      record.protocol_fee_charged !==
        (["deposit", "withdrawal_requested"].includes(kind) ? fee : "0") ||
      record.protocol_fee_earned !==
        (["deposit", "withdrawal_succeeded"].includes(kind) ? fee : "0") ||
      record.storage_fee_charged !==
        ([
          "deposit",
          "transfer",
          "withdrawal_requested",
          "withdrawal_retried",
        ].includes(kind)
          ? "20000000000000000000000"
          : "0")
    )
      throw new Error("Indexed fee policy mismatch");
    if (
      kind === "deposit"
        ? record.commitment === null ||
          record.nullifier !== null ||
          record.vault === null ||
          record.recipient !== null
        : kind === "transfer"
          ? record.commitment === null ||
            record.nullifier === null ||
            record.vault !== null ||
            record.recipient !== null
          : record.commitment !== null ||
            record.nullifier === null ||
            record.vault === null ||
            record.recipient === null
    )
      throw new Error("Indexed action binding mismatch");
    if (
      record.vault &&
      !new RegExp(
        `^v[a-f0-9]{32}\\.${policy.registry.replaceAll(".", "\\.")}$`,
      ).test(record.vault)
    )
      throw new Error("Indexed vault is outside the trusted group");
    const observedAt = block(item.observedAt);
    if (
      record.block_height > observedAt.height ||
      (index.checkpoint && observedAt.height > index.checkpoint.block.height)
    )
      throw new Error("Activity is outside its observed final block");
    let provenance: IndexedActivity["provenance"] = null;
    if (item.provenance !== null) {
      const a = object(item.provenance),
        t = object(a.transaction);
      if (
        !["succeeded", "failed"].includes(String(a.outerOutcome)) ||
        !Array.isArray(a.receipts) ||
        a.receipts.length < 1 ||
        a.receipts.length > 50
      )
        throw new Error("Invalid provenance");
      provenance = {
        transaction: { hash: hash(t.hash), signer: account(t.signer) },
        outerOutcome: a.outerOutcome as "succeeded" | "failed",
        receipts: a.receipts.map((v) => {
          const x = object(v);
          return { id: hash(x.id), blockHash: hash(x.blockHash) };
        }),
        verifiedAt: block(a.verifiedAt),
      };
    }
    return { record, observedAt, provenance };
  });
  if (
    items.some(
      (item, i) => i > 0 && item.record.index >= items[i - 1].record.index,
    )
  )
    throw new Error("Activity page is not in descending order");
  return {
    items,
    nextCursor: p.nextCursor as string | null,
    snapshot: { upperExclusive: upper },
    index,
    scope: "configured_registry_records",
  };
}
