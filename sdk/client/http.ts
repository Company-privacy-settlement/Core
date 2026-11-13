import { parsePolicy } from "./payment.js";
import { canonical } from "./crypto.js";
import { parseGroupCapacity } from './groups.js';
import {
  verifySignedInvoice,
  invoiceProof,
  invoiceHash,
  invoicePaymentRoots,
  invoiceStatusRequest,
  invoiceQuote,
  validateInvoiceStatus,
  type SignedInvoice,
  type InvoiceStatus,
} from "./invoices.js";
import {
  parseIndexStatus,
  parseActivityPage,
  type ActivityFilters,
} from "./activity.js";
import type {
  Call,
  Gateway,
  Policy,
  Preflight,
  Reference,
  Observation,
  TxRef,
  Verification,
} from "./types.js";
export class HttpGateway implements Gateway {
  readonly url: string;
  constructor(url: string) {
    const u = new URL(url);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
      )
    )
      throw new Error("Use an HTTPS API origin (HTTP is allowed on localhost)");
    this.url = u.origin;
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    const r = await fetch(this.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });
    if (!r.ok) {
      let code: string | undefined;
      try {
        const e = await r.json();
        if (
          [
            "INDEX_DISABLED",
            "INDEX_NOT_READY",
            "INDEX_READ_FAILED",
            "INVALID_CURSOR",
            "RATE_LIMITED", "TOO_MANY_REQUESTS", "RPC_BUDGET_EXCEEDED", "RATE_LIMIT_CAPACITY", "REQUEST_TIMEOUT",
          ].includes(e.error)
        )
          code = e.error;
      } catch {}
      const retry = r.headers.get('retry-after');
      const retryAfterSeconds = retry && /^[0-9]+$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 3600 ? Number(retry) : undefined;
      throw new CoreApiError(r.status, code, retryAfterSeconds);
    }
    return r.json();
  }
  async policy(): Promise<Policy> {
    return parsePolicy((await this.request("/v1/config")).policy);
  }
  preflight(request: Parameters<Gateway["preflight"]>[0]): Promise<Preflight> {
    return this.request("/v1/ft/preflight", request);
  }
  observe(reference: Reference): Promise<Observation> {
    return this.request("/v1/settlements/status", reference);
  }
  verify(transaction: TxRef, call: Call): Promise<Verification> {
    return this.request("/v1/transactions/verify", { transaction, call });
  }
  private async trusted(policy: Policy, signal?: AbortSignal) {
    if (canonical(parsePolicy((await this.request('/v1/config', undefined, signal)).policy)) !== canonical(policy))
      throw new Error("API policy differs from the trusted group");
  }
  async groupCapacity(policy: Policy, options: { signal?: AbortSignal } = {}) {
    await this.trusted(policy, options.signal);
    return parseGroupCapacity(await this.request('/v1/group/capacity', undefined, options.signal), policy);
  }
  async verifyInvoice(input: SignedInvoice) {
    const signed = await verifySignedInvoice(input);
    await this.trusted(signed.invoice.policy);
    const result = await this.request(
      "/v1/invoices/verify",
      await invoiceProof(signed),
    );
    if (
      result.invoiceHash !== (await invoiceHash(signed.invoice)) ||
      result.merchantAccount !== signed.invoice.merchantAccount ||
      result.verified !== true ||
      result.claims?.legalIdentityVerified !== false ||
      result.claims?.kybVerified !== false
    )
      throw new Error(
        "Invoice signer is not a current merchant full-access key",
      );
    return signed;
  }
  async invoiceStatus(input: SignedInvoice): Promise<InvoiceStatus> {
    const signed = await this.verifyInvoice(input),
      hash = await invoiceHash(signed.invoice),
      result = await this.request("/v1/invoices/status", await invoiceStatusRequest(signed.invoice)),
      roots = await invoicePaymentRoots(signed.invoice);
    if (
      result.invoiceHash !== hash ||
      (signed.invoice.version === 1 ? result.settlementRoot !== roots[0] : result.settlementRoot !== null || canonical(result.settlementRoots) !== canonical(roots)) ||
      result.expectedTokens !== invoiceQuote(signed.invoice).principalTokens ||
      ![
        "awaiting_payment",
        "partial",
        "paid",
        "paid_late",
        "overpaid",
        "expired",
        "partial_expired",
        "review_required",
      ].includes(result.state) ||
      result.chainFreshnessChecked !== false ||
      !Array.isArray(result.confirmations) ||
      result.confirmations.length > 1000
    )
      throw new Error("Invalid invoice settlement status");
    return validateInvoiceStatus(result, signed.invoice);
  }
  async indexStatus(policy: Policy) {
    await this.trusted(policy);
    return parseIndexStatus(await this.request("/v1/index/status"), policy);
  }
  async activity(
    policy: Policy,
    query: ActivityFilters & { limit?: number; cursor?: string } = {},
  ) {
    await this.trusted(policy);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") params.set(k, String(v));
    return parseActivityPage(
      await this.request(
        "/v1/activity" + (params.size ? "?" + params.toString() : ""),
      ),
      policy,
    );
  }
}
export class CoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Core API request failed (${status}${code ? `: ${code}` : ""})${retryAfterSeconds ? `; try again in ${retryAfterSeconds} seconds` : ''}`);
  }
}
