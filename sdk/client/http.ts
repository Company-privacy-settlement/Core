import { parsePolicy } from "./payment.js";
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
  private async request(path: string, body?: unknown) {
    const r = await fetch(this.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) throw new Error(`Core API request failed (${r.status})`);
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
}
