import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { StripeLikeExport } from "../../services/ts-console/src/lib/connectors/mockConnector.js";

export type FailureMode = "none" | "rate_limited" | "persistent_5xx" | "malformed_json" | "intermittent_5xx";

export interface FailureConfiguration {
  failureMode: FailureMode;
  failureRate?: number;
  recordCount?: number;
  pageSize?: number;
}

export interface LoggedConnectorRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: string;
  receivedAt: number;
  responseStatus: number;
}

const SAMPLE_FIXTURES: StripeLikeExport = {
  customers: [
    { id: "cus_001", name: "Ada Lovelace", email: "ada@example.test", created: 1_725_000_000 },
    { id: "cus_002", name: "Grace Hopper", email: null, created: 1_725_000_100 },
  ],
  prices: [
    { id: "price_001", product: { name: "Compute" }, unit_amount: 1299, currency: "usd", billing_scheme: "per_unit", created: 1_725_000_000 },
  ],
  contracts: [
    { id: "sub_001", customer: "cus_001", status: "active", start_date: 1_725_000_000, ended_at: null },
  ],
  invoices: [
    {
      id: "in_001",
      customer: "cus_001",
      amount_due: 2598,
      currency: "usd",
      status: "open",
      created: 1_725_000_200,
      due_date: 1_727_592_200,
      lines: [{
        id: "il_001",
        price: "price_001",
        description: "Compute usage",
        quantity: 2,
        unit_amount: 1299,
        amount: 2598,
        currency: "usd",
        period_start: 1_725_000_000,
        period_end: 1_727_592_000,
      }],
    },
  ],
  credits: [
    { id: "cn_001", customer: "cus_001", amount: 300, currency: "usd", reason: "service_credit", created: 1_725_000_300 },
  ],
  payments: [
    { id: "py_001", customer: "cus_001", invoice: "in_001", amount: 2298, currency: "usd", status: "succeeded", created: 1_725_000_400 },
  ],
  refunds: [
    { id: "re_001", payment: "py_001", amount: 100, currency: "usd", reason: "requested_by_customer", created: 1_725_000_500 },
  ],
};

function finish(res: ServerResponse, status: number, body: string, contentType = "application/json"): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function validConfiguration(value: unknown): value is FailureConfiguration {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const modes: FailureMode[] = ["none", "rate_limited", "persistent_5xx", "malformed_json", "intermittent_5xx"];
  if (typeof row.failureMode !== "string" || !modes.includes(row.failureMode as FailureMode)) return false;
  if (row.failureRate !== undefined && (
    typeof row.failureRate !== "number"
    || !Number.isFinite(row.failureRate)
    || row.failureRate < 0
    || row.failureRate > 1
  )) return false;
  if (row.recordCount !== undefined && (typeof row.recordCount !== "number" || !Number.isInteger(row.recordCount) || row.recordCount < 0)) return false;
  if (row.pageSize !== undefined && (typeof row.pageSize !== "number" || !Number.isInteger(row.pageSize) || row.pageSize <= 0)) return false;
  return true;
}

export class FakeConnectorTarget {
  readonly requests: LoggedConnectorRequest[] = [];
  private server: Server | null = null;
  private origin = "";
  private failureMode: FailureMode = "none";
  private failureRate = 0;
  private rateLimitedRemaining = 0;
  private recordCount = SAMPLE_FIXTURES.customers.length;
  private configuredPageSize: number | null = null;

  get baseUrl(): string {
    if (!this.origin) throw new Error("fake connector target is not started");
    return this.origin;
  }

  async start(port = 0): Promise<string> {
    if (this.server) return this.baseUrl;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fake connector target did not bind a TCP port");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.server = null;
    this.origin = "";
  }

  async configure(configuration: FailureConfiguration): Promise<void> {
    const response = await fetch(`${this.baseUrl}/_configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configuration),
    });
    if (!response.ok) throw new Error(`fake target configuration failed: ${response.status} ${await response.text()}`);
    await response.text();
  }

  async resetRequests(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/_reset`, { method: "POST" });
    if (!response.ok) throw new Error(`fake target reset failed: ${response.status}`);
    await response.text();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin || "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        finish(res, 200, JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/_requests") {
        finish(res, 200, JSON.stringify({ requests: this.requests }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/_reset") {
        this.requests.length = 0;
        finish(res, 200, JSON.stringify({ reset: true }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/_configure") {
        let payload: unknown;
        try {
          payload = JSON.parse(await readBody(req)) as unknown;
        } catch {
          finish(res, 400, JSON.stringify({ error: "invalid json" }));
          return;
        }
        if (!validConfiguration(payload)) {
          finish(res, 400, JSON.stringify({ error: "invalid failure configuration" }));
          return;
        }
        this.failureMode = payload.failureMode;
        this.failureRate = payload.failureRate ?? (payload.failureMode === "intermittent_5xx" ? 0.1 : 0);
        this.rateLimitedRemaining = payload.failureMode === "rate_limited" ? 3 : 0;
        if (payload.recordCount !== undefined) this.recordCount = payload.recordCount;
        if (payload.pageSize !== undefined) this.configuredPageSize = payload.pageSize;
        this.requests.length = 0;
        finish(res, 200, JSON.stringify({
          failureMode: this.failureMode,
          failureRate: this.failureRate,
          recordCount: this.recordCount,
          pageSize: this.configuredPageSize,
        }));
        return;
      }

      const body = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
      const logged: LoggedConnectorRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search,
        headers: { ...req.headers },
        body,
        receivedAt: Date.now(),
        responseStatus: 500,
      };
      this.requests.push(logged);

      const closeMatch = /^\/v1\/customers\/[^/]+\/close$/.test(url.pathname);
      if (req.method === "POST" && closeMatch) {
        logged.responseStatus = 200;
        finish(res, 200, JSON.stringify({ closed: true }));
        return;
      }

      const entityMatch = /^\/v1\/(customers|prices|contracts|invoices|credits|payments|refunds)$/.exec(url.pathname);
      if (req.method !== "GET" || !entityMatch) {
        logged.responseStatus = 404;
        finish(res, 404, JSON.stringify({ error: "not found" }));
        return;
      }

      const requestedLimit = Number(url.searchParams.get("limit") ?? this.configuredPageSize ?? 100);
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 5_000) : 100;
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      if (!Number.isInteger(cursor) || cursor < 0) {
        logged.responseStatus = 400;
        finish(res, 400, JSON.stringify({ error: "invalid cursor" }));
        return;
      }
      const logicalPage = Math.floor(cursor / limit);
      const deterministicFraction = (((logicalPage + 1) * 2_654_435_761) >>> 0) / 2 ** 32;
      const intermittentFailure = this.failureMode === "intermittent_5xx"
        && deterministicFraction < this.failureRate;

      if (this.failureMode === "rate_limited" && this.rateLimitedRemaining > 0) {
        this.rateLimitedRemaining -= 1;
        logged.responseStatus = 429;
        finish(res, 429, JSON.stringify({ error: "simulated rate limit" }));
        return;
      }
      if (this.failureMode === "persistent_5xx" || intermittentFailure) {
        logged.responseStatus = 500;
        finish(res, 500, JSON.stringify({ error: "simulated upstream failure" }));
        return;
      }
      if (this.failureMode === "malformed_json") {
        logged.responseStatus = 200;
        finish(res, 200, "{ definitely not json", "application/json");
        return;
      }

      const entity = entityMatch[1] as keyof StripeLikeExport;
      const page = this.page(entity, cursor, limit);
      logged.responseStatus = 200;
      finish(res, 200, JSON.stringify(page));
    } catch (error) {
      if (!res.headersSent) {
        finish(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private page(entity: keyof StripeLikeExport, cursor: number, limit: number): { data: unknown[]; next_cursor: string | null } {
    if (entity !== "customers" || this.recordCount === SAMPLE_FIXTURES.customers.length) {
      const rows = SAMPLE_FIXTURES[entity] as unknown[];
      const data = rows.slice(cursor, cursor + limit);
      const next = cursor + data.length;
      return { data, next_cursor: next < rows.length ? String(next) : null };
    }
    const end = Math.min(cursor + limit, this.recordCount);
    const data = Array.from({ length: Math.max(0, end - cursor) }, (_, index) => {
      const number = cursor + index;
      return {
        id: `cus_scale_${number.toString().padStart(6, "0")}`,
        name: `Scale Customer ${number}`,
        email: number % 2 === 0 ? `customer-${number}@example.test` : null,
        created: 1_725_000_000 + number,
      };
    });
    return { data, next_cursor: end < this.recordCount ? String(end) : null };
  }
}

export async function startFakeConnectorTarget(port = 0): Promise<FakeConnectorTarget> {
  const target = new FakeConnectorTarget();
  await target.start(port);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = await startFakeConnectorTarget(Number(process.env.FAKE_CONNECTOR_PORT ?? 8097));
  console.log(`fake-connector-target: listening on ${target.baseUrl}`);
}
