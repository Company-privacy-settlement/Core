import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperationJournal,
  SettlementSession,
  preparedPayment,
  HttpGateway,
  canonical,
  type Call,
  type Gateway,
  type JournalStorage,
  type Observation,
  type TxRef,
} from "../sdk/client/index.js";
import { fileJournalStorage } from "../sdk/client-node.js";
import { seal, unseal, shaField } from "../sdk/client/crypto.js";
import { verifyTransaction } from "../sdk/transactions.js";
import { operationsFixture } from "./fixtures/operations.js";
const password = "correct journal passphrase";
const tx: TxRef = { hash: "1".repeat(44), signer: "alice.test.near" };
const receipt = "ab".repeat(32);
function memory() {
  let value: string | null = null,
    busy = false;
  return {
    read: async () => value,
    write: async (e) => {
      value = e;
    },
    exclusive: async (fn) => {
      if (busy) throw new Error("Journal busy");
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
  } satisfies JournalStorage;
}
function fixture() {
  const f = operationsFixture();
  const payment: Call = {
    contract: f.policy.tokenId!,
    method: "ft_transfer_call",
    args: {
      receiver_id: f.vault,
      amount: "1001500",
      msg: JSON.stringify({ commitment: "42", disclosure_root: receipt }),
    },
    attachedYoctoNear: "1",
    gas: "300000000000000",
  };
  const state = {
    identity: { network: f.policy.network, accountId: f.payer },
    signed: 0,
    prerequisites: [] as Call[],
    policy: f.policy,
    observation: {
      state: "NotFound",
      complete: false,
      refunded: false,
      retryAvailable: false,
      refundAvailable: false,
      retryCall: null,
      refundCall: null,
      record: null,
      checkedAtBlock: { hash: "block", height: 20 },
    } as Observation,
    verification: {
      status: "final",
      effect: "accepted",
      transaction: tx,
    } as Awaited<ReturnType<Gateway["verify"]>>,
  };
  const gateway: Gateway = {
    policy: async () => state.policy,
    observe: async () => state.observation,
    preflight: async () => ({
      canPrepare: true,
      prerequisitesSatisfied: state.prerequisites.length === 0,
      prerequisites: state.prerequisites,
      blockers: [],
      tokenAmountRequired: "1001500",
      payerTokenBalance: "2000000",
      checkedAtBlock: { hash: "block", height: 20 },
    }),
    verify: async () => state.verification,
  };
  const storage = memory(),
    journal = new OperationJournal(storage, password),
    wallet = {
      identity: async () => state.identity,
      sign: async () => {
        state.signed++;
        return tx;
      },
    };
  const session = new SettlementSession(journal, gateway, wallet, f.policy);
  return { ...f, payment, state, gateway, storage, journal, wallet, session };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
test('locking during journal decryption prevents plaintext from being returned', async t => {
  const f = fixture(); await f.journal.create();
  const entered = deferred(), gate = deferred(), original = crypto.subtle.decrypt, decrypt = original.bind(crypto.subtle);
  crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => { entered.resolve(); await gate.promise; return decrypt(...args); };
  t.after(() => { gate.resolve(); crypto.subtle.decrypt = original; });
  const pending = f.journal.list(); await entered.promise; f.journal.lock(); gate.resolve();
  await assert.rejects(pending, /locked/i);
});
test('locking during backup decryption prevents restoration into empty storage', async t => {
  const f = fixture(), envelope = await seal({ version: 1, operations: [] }, password);
  const entered = deferred(), gate = deferred(), original = crypto.subtle.decrypt, decrypt = original.bind(crypto.subtle);
  crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => { entered.resolve(); await gate.promise; return decrypt(...args); };
  t.after(() => { gate.resolve(); crypto.subtle.decrypt = original; });
  const pending = f.journal.restore(envelope); await entered.promise; f.journal.lock(); gate.resolve();
  await assert.rejects(pending, /locked/i); assert.equal(await f.storage.read(), null);
});
test('locking during durable intent storage prevents a later wallet prompt and keeps recovery conservative', async () => {
  const f = fixture(); await f.journal.create(); const op = await f.session.importPlan({ tokenCall: f.payment }), review = await f.session.review(op.id);
  const entered = deferred(), gate = deferred(), write = f.storage.write;
  f.storage.write = async envelope => { entered.resolve(); await gate.promise; await write(envelope); };
  const pending = f.session.submitReviewed(op.id, review.callHash!); await entered.promise; f.journal.lock(); gate.resolve();
  await pending.catch(() => {});
  assert.equal(f.state.signed, 0, 'locking before wallet dispatch must prevent the prompt');
  const reopened = new OperationJournal(f.storage, password), recovered = new SettlementSession(reopened, f.gateway, f.wallet, f.policy);
  assert.equal((await reopened.list())[0].attempts[0].state, 'signing');
  assert.equal((await recovered.review(op.id)).action, 'reconcile'); assert.equal(f.state.signed, 0);
});
test('locking an already-open wallet leaves a durable unresolved intent without automatic resend', async () => {
  const f = fixture(); await f.journal.create(); const op = await f.session.importPlan({ tokenCall: f.payment }), review = await f.session.review(op.id);
  const entered = deferred(), gate = deferred();
  f.wallet.sign = async () => { f.state.signed++; entered.resolve(); await gate.promise; return tx; };
  const pending = f.session.submitReviewed(op.id, review.callHash!); await entered.promise; f.journal.lock(); gate.resolve();
  await assert.rejects(pending, /locked/i); assert.equal(f.state.signed, 1);
  const reopened = new OperationJournal(f.storage, password), recovered = new SettlementSession(reopened, f.gateway, f.wallet, f.policy);
  assert.equal((await recovered.review(op.id)).action, 'reconcile'); assert.equal(f.state.signed, 1);
});
test('a delayed unsigned review cannot expose a new wallet call after journal locking', async () => {
  const f = fixture(); await f.journal.create(); const op = await f.session.importPlan({ tokenCall: f.payment });
  const entered = deferred(), gate = deferred(), preflight = f.gateway.preflight;
  f.gateway.preflight = async input => { entered.resolve(); await gate.promise; return preflight(input); };
  const pending = f.session.review(op.id); await entered.promise; f.journal.lock(); gate.resolve();
  await assert.rejects(pending, /locked/i); assert.equal(f.state.signed, 0);
});
test("journal encryption authenticates ciphertext and rejects wrong passwords and plaintext secrets in storage", async () => {
  const encrypted = await seal({ version: 1, operations: [] }, password);
  assert.ok(!encrypted.includes("operations"));
  assert.deepEqual(await unseal(encrypted, password), {
    operations: [],
    version: 1,
  });
  await assert.rejects(() => unseal(encrypted, "wrong journal password"));
  const altered = JSON.parse(encrypted);
  altered.iv = "AAAAAAAAAAAAAAAA";
  await assert.rejects(() => unseal(JSON.stringify(altered), password));
  await assert.rejects(() => seal({}, "short"));
});
test("public plan derives the exact principal plus fee and rejects keys, wrong tokens and changed amounts", async () => {
  const f = fixture();
  const prepared = await preparedPayment(
    { tokenCall: f.payment, quote: { untrusted: "ignore me" } },
    f.policy,
    f.payer,
  );
  assert.equal(prepared.payment.args.amount, "1001500");
  assert.equal(prepared.reference.kind, "deposit");
  await assert.rejects(() =>
    preparedPayment(
      { tokenCall: f.payment, secret: "private" },
      f.policy,
      f.payer,
    ),
  );
  await assert.rejects(() =>
    preparedPayment(
      { tokenCall: { ...f.payment, contract: "evil.test.near" } },
      f.policy,
      f.payer,
    ),
  );
  await assert.rejects(() =>
    preparedPayment(
      {
        tokenCall: {
          ...f.payment,
          args: { ...f.payment.args, amount: "1000000" },
        },
      },
      f.policy,
      f.payer,
    ),
  );
});
test("withdrawal import binds proof inputs to asset, recipient and disclosure root", async () => {
  const f = fixture(),
    domain = await shaField(
      `core:ft:v3|sandbox|${f.policy.registry}|${f.policy.tokenId}|1000000`,
    ),
    context = await shaField(
      `core:action:ft:v3|${domain}|withdraw|${f.vault}|${f.recipient}|${receipt}`,
    );
  const msg = {
    vault: f.vault,
    recipient: f.recipient,
    disclosure_root: receipt,
    proof: Buffer.alloc(256).toString("base64"),
    public_inputs: ["42", "2", "3", context, domain],
  };
  const plan = {
    tokenCall: {
      ...f.payment,
      args: {
        receiver_id: f.policy.registry,
        amount: "1500",
        msg: JSON.stringify(msg),
      },
    },
  };
  assert.equal(
    (await preparedPayment(plan, f.policy, f.payer)).reference.kind,
    "withdrawal",
  );
  msg.recipient = "evil.test.near";
  plan.tokenCall.args.msg = JSON.stringify(msg);
  await assert.rejects(() => preparedPayment(plan, f.policy, f.payer), /bind/);
});
test("signing is durably recorded before wallet invocation and an ambiguous result is never resent after reload", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment });
  f.wallet.sign = async () => {
    f.state.signed++;
    const saved = (await unseal((await f.storage.read())!, password)) as {
      operations: { attempts: { state: string }[] }[];
    };
    assert.equal(saved.operations[0].attempts[0].state, "signing");
    throw new Error("network lost after broadcast");
  };
  const review = await f.session.review(o.id);
  await assert.rejects(
    () => f.session.submitReviewed(o.id, review.callHash!),
    /network lost/,
  );
  const resumed = new SettlementSession(
    new OperationJournal(f.storage, password),
    f.gateway,
    f.wallet,
    f.policy,
  );
  assert.equal((await resumed.review(o.id)).action, "reconcile");
  await assert.rejects(
    () => resumed.submitReviewed(o.id, review.callHash!),
    /changed/,
  );
  assert.equal(f.state.signed, 1);
  await resumed.reconcile(o.id, tx);
  assert.equal((await resumed.review(o.id)).action, "wait");
});
test("persistence failure prevents wallet signing", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment }),
    r = await f.session.review(o.id);
  f.storage.write = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(
    () => f.session.submitReviewed(o.id, r.callHash!),
    /disk full/,
  );
  assert.equal(f.state.signed, 0);
});
test("changed wallet, trusted policy, or prerequisite cannot sign an old review", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment }),
    r = await f.session.review(o.id);
  f.state.identity = { ...f.state.identity, accountId: "bob.test.near" };
  await assert.rejects(
    () => f.session.submitReviewed(o.id, r.callHash!),
    /payer/,
  );
  f.state.identity.accountId = f.payer;
  f.state.prerequisites = [
    {
      contract: f.vault,
      method: "prepay_storage",
      args: { account_id: f.payer },
      attachedYoctoNear: "25000000000000000000000",
      gas: f.payment.gas,
    },
  ];
  await assert.rejects(
    () => f.session.submitReviewed(o.id, r.callHash!),
    /changed/,
  );
  f.state.policy = { ...f.policy, feeRecipient: "evil.test.near" };
  await assert.rejects(() => f.session.review(o.id), /policy differs/);
  assert.equal(f.state.signed, 0);
});
test("untrusted prerequisite destinations are rejected and confirmed credits are not purchased twice", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment });
  f.state.prerequisites = [
    {
      contract: "evil.test.near",
      method: "prepay_storage",
      args: { account_id: f.payer },
      attachedYoctoNear: "1",
      gas: f.payment.gas,
    },
  ];
  await assert.rejects(() => f.session.review(o.id), /Unapproved/);
  f.state.prerequisites[0] = { ...f.state.prerequisites[0], contract: f.vault };
  const r = await f.session.review(o.id);
  await f.session.submitReviewed(o.id, r.callHash!);
  assert.equal((await f.session.review(o.id)).action, "wait");
  assert.equal(f.state.signed, 1);
});
test("a bound pending record resolves lost payment response, and recovery keeps the original destination", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment });
  f.wallet.sign = async () => {
    throw new Error("lost");
  };
  const r = await f.session.review(o.id);
  await assert.rejects(() => f.session.submitReviewed(o.id, r.callHash!));
  f.state.observation = {
    ...f.state.observation,
    state: "Pending",
    record: { state: "Pending" },
    retryAvailable: true,
    retryCall: {
      contract: f.vault,
      method: "retry_deposit",
      args: { commitment: "42" },
      attachedYoctoNear: "20000000000000000000000",
      gas: f.payment.gas,
    },
  };
  assert.equal((await f.session.review(o.id)).kind, "retry");
  f.state.observation.retryCall!.args.commitment = "43";
  await assert.rejects(() => f.session.review(o.id), /binding mismatch/);
});
test("completed observer state is terminal and encrypted journal can be restored without overwriting history", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment });
  f.state.observation.complete = true;
  assert.equal((await f.session.review(o.id)).action, "complete");
  const backup = await f.journal.export(),
    copy = new OperationJournal(memory(), password);
  await copy.restore(backup);
  assert.equal((await copy.list())[0].outcome, "complete");
  await assert.rejects(() => copy.restore(backup), /empty/);
  f.state.observation.complete = false;
  assert.equal((await f.session.review(o.id)).action, "wait");
  f.journal.lock();
  await assert.rejects(() => f.journal.list(), /locked/);
});
test("storage lock refuses concurrent wallet requests while a signature is pending", async () => {
  const f = fixture();
  await f.journal.create();
  const o = await f.session.importPlan({ tokenCall: f.payment }),
    r = await f.session.review(o.id);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.wallet.sign = async () => {
    f.state.signed++;
    entered();
    await gate;
    return tx;
  };
  const first = f.session.submitReviewed(o.id, r.callHash!);
  await started;
  await assert.rejects(
    () => f.session.submitReviewed(o.id, r.callHash!),
    /busy/,
  );
  release();
  await first;
  assert.equal(f.state.signed, 1);
});
test("file journal uses atomic private writes and rejects a competing lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-journal-"));
  try {
    const path = join(dir, "journal.encrypted.json"),
      storage = fileJournalStorage(path),
      j = new OperationJournal(storage, password);
    await j.create();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await storage.exclusive(async () => {
      await assert.rejects(
        () => new OperationJournal(fileJournalStorage(path), password).list(),
        /locked/,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTTP gateway refuses credential-bearing or remote cleartext origins", () => {
  for (const url of [
    "http://api.example",
    "https://key:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
  ])
    assert.throws(() => new HttpGateway(url));
  assert.equal(
    new HttpGateway("http://127.0.0.1:3001").url,
    "http://127.0.0.1:3001",
  );
});
test("transaction verifier requires finality and the exact public action; outer FT failure remains uncertain", async () => {
  const f = fixture();
  const raw = {
    final_execution_status: "FINAL",
    transaction: {
      hash: tx.hash,
      signer_id: tx.signer,
      receiver_id: f.payment.contract,
      actions: [
        {
          FunctionCall: {
            method_name: f.payment.method,
            args: Buffer.from(JSON.stringify(f.payment.args)).toString(
              "base64",
            ),
            gas: f.payment.gas,
            deposit: "1",
          },
        },
      ],
    },
    status: {
      SuccessValue: Buffer.from('"1001500"').toString("base64"),
    } as unknown,
  };
  f.source.transaction = async () => raw;
  assert.equal(
    (
      (await verifyTransaction(f.source, f.policy, tx, f.payment)) as {
        effect: string;
      }
    ).effect,
    "accepted",
  );
  raw.final_execution_status = "EXECUTED";
  assert.equal(
    (await verifyTransaction(f.source, f.policy, tx, f.payment)).status,
    "pending",
  );
  raw.final_execution_status = "FINAL";
  raw.status = { Failure: { ActionError: {} } };
  assert.equal(
    (
      (await verifyTransaction(f.source, f.policy, tx, f.payment)) as {
        effect: string;
      }
    ).effect,
    "unknown",
  );
  raw.status = { SuccessValue: Buffer.from('"0"').toString("base64") };
  assert.equal(
    (
      (await verifyTransaction(f.source, f.policy, tx, f.payment)) as {
        effect: string;
      }
    ).effect,
    "not-accepted",
  );
  raw.transaction.actions[0].FunctionCall.deposit = "2";
  await assert.rejects(
    () => verifyTransaction(f.source, f.policy, tx, f.payment),
    /actions/,
  );
  raw.transaction.actions[0].FunctionCall.deposit = "1";
  raw.transaction.signer_id = "bob.test.near";
  await assert.rejects(
    () => verifyTransaction(f.source, f.policy, tx, f.payment),
    /signer/,
  );
  f.source.transaction = async () => null;
  assert.equal(
    (await verifyTransaction(f.source, f.policy, tx, f.payment)).status,
    "pending",
  );
});
