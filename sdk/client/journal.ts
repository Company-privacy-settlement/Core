import { canonical, seal, sha256, unseal } from "./crypto.js";
import {
  account,
  object,
  parsePolicy,
  preparedPayment,
  validatePrerequisite,
  validateRecovery,
} from "./payment.js";
import type { JournalStorage, Operation, TxRef } from "./types.js";

export function transactionRef(input: unknown): TxRef {
  const t = object(input);
  if (
    Object.keys(t).sort().join("|") !== "hash|signer" ||
    typeof t.hash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(t.hash)
  )
    throw new Error("Invalid transaction reference");
  return { hash: t.hash, signer: account(t.signer) };
}
async function validate(input: unknown): Promise<Operation[]> {
  const data = object(input);
  if (
    Object.keys(data).sort().join("|") !== "operations|version" ||
    data.version !== 1 ||
    !Array.isArray(data.operations) ||
    data.operations.length > 100
  )
    throw new Error("Invalid operation journal");
  const ids = new Set<string>();
  for (const raw of data.operations) {
    const o = object(raw) as unknown as Operation;
    if (
      Object.keys(o).sort().join("|") !==
        "attempts|createdAt|id|outcome|payer|payment|policy|reference" ||
      typeof o.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(o.id) ||
      ids.has(o.id) ||
      typeof o.createdAt !== "string" ||
      !Number.isFinite(Date.parse(o.createdAt)) ||
      !["open", "complete", "refunded"].includes(o.outcome) ||
      !Array.isArray(o.attempts) ||
      o.attempts.length > 64
    )
      throw new Error("Invalid journal operation");
    ids.add(o.id);
    o.policy = parsePolicy(o.policy);
    account(o.payer);
    const prepared = await preparedPayment(
      { tokenCall: o.payment },
      o.policy,
      o.payer,
    );
    if (
      canonical(prepared.payment) !== canonical(o.payment) ||
      canonical(prepared.reference) !== canonical(o.reference)
    )
      throw new Error("Journal payment binding mismatch");
    for (const a of o.attempts) {
      if (
        Object.keys(a).some(
          (k) =>
            ![
              "kind",
              "call",
              "callHash",
              "recordHash",
              "state",
              "transaction",
            ].includes(k),
        ) ||
        ![
          "signing",
          "submitted",
          "confirmed",
          "observed",
          "uncertain",
          "not-accepted",
        ].includes(a.state) ||
        typeof a.recordHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(a.recordHash)
      )
        throw new Error("Invalid journal attempt");
      if (a.state === "observed" && a.kind !== "payment")
        throw new Error("Only payment acceptance can be observed");
      if (a.kind === "prerequisite")
        validatePrerequisite(a.call, o.policy, o.payer, o.reference);
      else if (a.kind === "payment") {
        if (canonical(a.call) !== canonical(o.payment))
          throw new Error("Journal payment changed");
      } else if (a.kind === "retry" || a.kind === "refund") {
        validateRecovery(a.call, o.policy, o.reference);
        if (
          (a.kind === "refund") !==
          (a.call.method === "claim_deposit_refund")
        )
          throw new Error("Recovery kind mismatch");
      } else throw new Error("Invalid attempt kind");
      if (a.callHash !== (await sha256(canonical(a.call))))
        throw new Error("Journal call hash mismatch");
      if (a.transaction && transactionRef(a.transaction).signer !== o.payer)
        throw new Error("Journal transaction signer mismatch");
      if (
        ["submitted", "confirmed", "not-accepted"].includes(a.state) &&
        !a.transaction
      )
        throw new Error("Transaction reference is required");
    }
  }
  return data.operations as Operation[];
}

/** Every mutation reloads the encrypted source while holding the storage's cross-context lock. */
export class OperationJournal {
  private password: string;
  private generation = 0;
  constructor(
    readonly storage: JournalStorage,
    password: string,
  ) {
    this.password = password;
  }
  lock() {
    this.generation++;
    this.password = "";
  }
  private async access<T>(action: (password: string, check: () => void) => Promise<T>): Promise<T> {
    const password = this.password, generation = this.generation;
    let active = true;
    const check = () => { if (!active || !password || !this.password || generation !== this.generation) throw new Error('Journal is locked'); };
    try {
      check();
      return await this.storage.exclusive(async () => {
        check(); const result = await action(password, check); check(); return result;
      });
    } finally { active = false; }
  }
  private async read(password: string, check: () => void) {
    const e = await this.storage.read();
    check();
    if (e === null)
      throw new Error("Create or restore an encrypted journal first");
    const decoded = await unseal(e, password); check();
    const operations = await validate(decoded); check(); return operations;
  }
  async create() {
    return this.access(async (password, check) => {
      const existing = await this.storage.read(); check();
      if (existing !== null)
        throw new Error("A journal already exists; unlock it instead");
      const envelope = await seal({ version: 1, operations: [] }, password); check();
      await this.storage.write(envelope); check();
    });
  }
  async list() {
    return this.access((password, check) => this.read(password, check));
  }
  async export() {
    return this.access(async (password, check) => {
      await this.read(password, check);
      const envelope = await this.storage.read(); check(); return envelope!;
    });
  }
  async restore(envelope: string) {
    return this.access(async (password, check) => {
      const existing = await this.storage.read(); check();
      if (existing !== null)
        throw new Error(
          "Restore into an empty journal storage to preserve existing operations",
        );
      const decoded = await unseal(envelope, password); check();
      await validate(decoded); check();
      await this.storage.write(envelope); check();
    });
  }
  async update<T>(
    fn: (operations: Operation[], persist: () => Promise<void>, check: () => void) => Promise<T>,
  ): Promise<T> {
    return this.access(async (password, check) => {
      const operations = await this.read(password, check);
      const persist = async () => {
        check(); await validate({ version: 1, operations }); check();
        const envelope = await seal({ version: 1, operations }, password); check();
        await this.storage.write(envelope); check();
      };
      return fn(operations, persist, check);
    });
  }
}

/** Refuse concurrent tabs and unsupported lock APIs; never fall back to an unsafe read/write race. */
export function browserJournalStorage(
  key = "core-live-journal-v1",
  label = 'Journal',
): JournalStorage {
  return {
    read: async () => localStorage.getItem(key),
    write: async (e) => {
      localStorage.setItem(key, e);
      if (localStorage.getItem(key) !== e)
        throw new Error(`${label} persistence failed`);
    },
    exclusive: async (fn) => {
      if (!navigator.locks)
        throw new Error("This browser needs Web Locks for encrypted storage");
      return navigator.locks.request(
        key,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              `${label} is in use by another tab or request`,
            );
          return fn();
        },
      );
    },
  };
}
