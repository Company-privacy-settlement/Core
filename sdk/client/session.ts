import { canonical, sha256 } from "./crypto.js";
import { OperationJournal, transactionRef } from "./journal.js";
import {
  account,
  parsePolicy,
  preparedPayment,
  validatePrerequisite,
  validateRecovery,
} from "./payment.js";
import type {
  Attempt,
  Call,
  Gateway,
  Observation,
  Operation,
  Policy,
  Reference,
  TxRef,
  WalletPort,
} from "./types.js";
export type Review = {
  operationId: string;
  action: "sign" | "wait" | "reconcile" | "blocked" | "complete" | "refunded";
  message: string;
  observation: Observation;
  kind?: Attempt["kind"];
  call?: Call;
  callHash?: string;
  recordHash: string;
};
export type SettlementGuards = {
  beforeImport?: (payment: { payment: Call; reference: Reference }, payer: string, operations: readonly Operation[]) => Promise<void>;
  beforeSubmit?: (operation: Operation, review: Review, operations: readonly Operation[]) => Promise<() => void>;
  beforeDispatch?: (operation: Operation, review: Review) => Promise<void>;
};

export class SettlementSession {
  readonly policy: Policy;
  constructor(
    readonly journal: OperationJournal,
    readonly gateway: Gateway,
    readonly wallet: WalletPort,
    policy: Policy,
    private readonly guards: SettlementGuards = {},
  ) {
    this.policy = parsePolicy(policy);
  }
  private async trusted() {
    if (
      canonical(parsePolicy(await this.gateway.policy())) !==
      canonical(this.policy)
    )
      throw new Error(
        "API policy differs from the independently trusted policy",
      );
  }
  private async identity(payer: string) {
    const identity = await this.wallet.identity();
    if (
      identity.network !== this.policy.network ||
      identity.accountId !== payer
    )
      throw new Error("Connect the reviewed payer on the correct network");
  }
  async importPlan(plan: unknown) {
    await this.trusted();
    const identity = await this.wallet.identity();
    account(identity.accountId);
    await this.identity(identity.accountId);
    const prepared = await preparedPayment(
      plan,
      this.policy,
      identity.accountId,
    );
    return this.journal.update(async (operations, persist) => {
      await this.guards.beforeImport?.(prepared, identity.accountId, operations);
      if (operations.length >= 100)
        throw new Error(
          "Journal capacity reached; preserve a backup and start another journal",
        );
      const duplicate = operations.find(
        (o) =>
          canonical(o.policy) === canonical(this.policy) &&
          canonical(o.reference) === canonical(prepared.reference),
      );
      if (duplicate) return duplicate;
      const op: Operation = {
        id: crypto.randomUUID(),
        policy: this.policy,
        payer: identity.accountId,
        ...prepared,
        attempts: [],
        outcome: "open",
        createdAt: new Date().toISOString(),
      };
      operations.push(op);
      await persist();
      return op;
    });
  }
  private operation(operations: Operation[], id: string) {
    const o = operations.find((o) => o.id === id);
    if (!o || canonical(o.policy) !== canonical(this.policy))
      throw new Error("Operation not found in this trusted group");
    return o;
  }
  private async next(
    o: Operation,
    persist: () => Promise<void>,
  ): Promise<Review> {
    await this.trusted();
    const observation = await this.gateway.observe(o.reference),
      recordHash = await sha256(canonical(observation.record));
    const result = (
      action: Review["action"],
      message: string,
      kind?: Attempt["kind"],
      call?: Call,
    ): Promise<Review> =>
      Promise.resolve({
        operationId: o.id,
        action,
        message,
        observation,
        recordHash,
        ...(kind ? { kind } : {}),
        ...(call ? { call } : {}),
      }).then(async (r) => ({
        ...r,
        ...(call ? { callHash: await sha256(canonical(call)) } : {}),
      }));
    if (observation.complete || observation.refunded) {
      o.outcome = observation.complete ? "complete" : "refunded";
      await persist();
      return result(o.outcome, "Confirmed by finalized contract state");
    }
    // Even if a stale API read loses a completed record, never reopen a terminal journal entry.
    if (o.outcome !== "open")
      return result(
        "wait",
        "Previously finalized operation; current read is inconsistent",
      );
    const last = o.attempts.at(-1);
    if (last && ["signing", "submitted", "uncertain"].includes(last.state)) {
      // A bound deposit/withdrawal record proves token acceptance, not final payout.
      if (last.kind === "payment" && observation.record !== null) {
        last.state = "observed";
        await persist();
      } else if (last.transaction) {
        const checked = await this.gateway.verify(last.transaction, last.call);
        if (checked.status === "final" && checked.effect !== "unknown") {
          if (
            checked.transaction.hash !== last.transaction.hash ||
            checked.transaction.signer !== o.payer
          )
            throw new Error("Transaction verification binding mismatch");
          last.state =
            checked.effect === "accepted" ? "confirmed" : "not-accepted";
          await persist();
        } else
          return result(
            "reconcile",
            checked.status === "pending"
              ? "Transaction is not final yet; refresh before continuing"
              : "Transaction effect is uncertain; do not resend",
          );
      } else
        return result(
          "reconcile",
          "Signature outcome is unknown. Supply the transaction hash; do not resend",
        );
    }
    if (observation.record !== null) {
      if (observation.refundAvailable && observation.refundCall) {
        if (
          o.attempts.some(
            (a) =>
              a.kind === "refund" &&
              a.state === "confirmed" &&
              a.recordHash === recordHash,
          )
        )
          return result(
            "wait",
            "Confirmed refund claim is awaiting a new contract state",
          );
        const call = validateRecovery(
          observation.refundCall,
          this.policy,
          o.reference,
        );
        return result(
          "sign",
          "Claim the failed deposit refund",
          "refund",
          call,
        );
      }
      if (observation.retryAvailable && observation.retryCall) {
        if (
          o.attempts.some(
            (a) =>
              a.kind === "retry" &&
              a.state === "confirmed" &&
              a.recordHash === recordHash,
          )
        )
          return result(
            "wait",
            "Confirmed recovery is awaiting a new contract state",
          );
        return result(
          "sign",
          "Retry the original fixed destination; storage attachment is additional",
          "retry",
          validateRecovery(observation.retryCall, this.policy, o.reference),
        );
      }
      return result(
        "wait",
        "Token acceptance recorded; settlement is still processing",
      );
    }
    if (
      o.attempts.some(
        (a) =>
          a.kind === "payment" && ["confirmed", "observed"].includes(a.state),
      )
    )
      return result(
        "wait",
        "Token call accepted; waiting for the bound contract record",
      );
    const r = o.reference;
    const preflight = await this.gateway.preflight({
      operation: r.kind === "deposit" ? "deposit" : "withdraw",
      payer: o.payer,
      vault: r.kind === "deposit" ? r.vault : r.expectedVault,
      ...(r.kind === "withdrawal" ? { recipient: r.expectedRecipient } : {}),
    });
    if (!preflight.canPrepare || preflight.blockers.length)
      return result(
        "blocked",
        preflight.blockers.map((b) => `${b.code}: ${b.accountId}`).join("; ") ||
          "Prerequisites cannot be prepared",
      );
    const first = preflight.prerequisites[0];
    if (first) {
      const call = validatePrerequisite(first, this.policy, o.payer, r),
        hash = await sha256(canonical(call));
      if (
        o.attempts.some(
          (a) =>
            a.kind === "prerequisite" &&
            a.state === "confirmed" &&
            a.callHash === hash,
        )
      )
        return result(
          "wait",
          "Confirmed prerequisite still appears in preflight; wait for a fresh chain read",
        );
      return result(
        "sign",
        "Approve this prerequisite, then review the next step",
        "prerequisite",
        call,
      );
    }
    if (!preflight.prerequisitesSatisfied)
      return result("blocked", "Preflight is incomplete");
    return result(
      "sign",
      "Approve the token payment with the 0.15% add-on fee",
      "payment",
      o.payment,
    );
  }
  async review(id: string) {
    return this.journal.update(async (operations, persist) =>
      this.next(this.operation(operations, id), persist),
    );
  }
  async submitReviewed(id: string, reviewedCallHash: string) {
    return this.journal.update(async (operations, persist, check) => {
      const o = this.operation(operations, id);
      await this.identity(o.payer);
      const review = await this.next(o, persist);
      if (
        review.action !== "sign" ||
        !review.call ||
        !review.kind ||
        review.callHash !== reviewedCallHash
      )
        throw new Error(
          "The next step changed. Review it again before signing",
        );
      if (o.attempts.length >= 64)
        throw new Error(
          "Attempt limit reached; reconcile existing transactions",
        );
      if (this.guards.beforeDispatch && !this.wallet.supportsBeforeDispatch) throw new Error('This wallet adapter cannot enforce corporate dispatch authorization');
      const authorize = await this.guards.beforeSubmit?.(o, review, operations);
      check();
      const a: Attempt = {
        kind: review.kind,
        call: review.call,
        callHash: review.callHash,
        recordHash: review.recordHash,
        state: "signing",
      };
      o.attempts.push(a);
      await persist(); // No wallet call until the encrypted write is durable.
      check(); // Locking while storage or preflight was pending revokes dispatch.
      try { authorize?.(); }
      catch (error) {
        // Dispatch has not been invoked. Remove only this never-sent intent.
        o.attempts.pop(); await persist(); throw error;
      }
      try {
        let dispatched = false;
        const tx = await this.wallet.sign(a.call, {
          operationId: id,
          attempt: o.attempts.length - 1,
          identity: { network: this.policy.network, accountId: o.payer },
          authorize: () => { check(); authorize?.(); },
          ...(this.guards.beforeDispatch ? { beforeDispatch: async () => {
            check(); authorize?.(); if (dispatched) throw new Error('Dispatch authorization was already used'); dispatched = true;
            await this.guards.beforeDispatch!(o, review); check(); authorize?.();
          } } : {}),
        });
        if (this.guards.beforeDispatch && !dispatched) throw new Error('Wallet adapter omitted dispatch authorization');
        if (tx) {
          a.transaction = transactionRef(tx);
          if (a.transaction.signer !== o.payer)
            throw new Error("Wallet returned a different signer");
          a.state = "submitted";
        } else a.state = "uncertain";
        await persist();
      } catch (error) {
        a.state = "uncertain";
        await persist();
        throw error;
      }
      return { state: a.state, transaction: a.transaction };
    });
  }
  async reconcile(id: string, transaction: TxRef) {
    return this.journal.update(async (operations, persist) => {
      const o = this.operation(operations, id),
        a = o.attempts.at(-1),
        tx = transactionRef(transaction);
      await this.trusted();
      if (
        !a ||
        !["signing", "submitted", "uncertain"].includes(a.state) ||
        tx.signer !== o.payer
      )
        throw new Error("No matching uncertain attempt");
      if (a.transaction && a.transaction.hash !== tx.hash)
        throw new Error("An existing transaction hash cannot be replaced");
      const checked = await this.gateway.verify(tx, a.call);
      if (checked.status !== "final")
        throw new Error("Transaction is not final; try again later");
      if (
        checked.transaction.hash !== tx.hash ||
        checked.transaction.signer !== tx.signer
      )
        throw new Error("Transaction verification mismatch");
      a.transaction = tx;
      a.state =
        checked.effect === "accepted"
          ? "confirmed"
          : checked.effect === "not-accepted"
            ? "not-accepted"
            : "uncertain";
      await persist();
      return a.state;
    });
  }
}
