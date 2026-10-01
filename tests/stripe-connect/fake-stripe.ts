// Stand-in for Stripe Connect OAuth. Production code talks to it through
// STRIPE_CONNECT_BASE_URL the same way Google sign-in talks to fake-google.
// Authorization codes are single-use: the first /oauth/token exchange
// succeeds and every later exchange of that same code is invalid_grant.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

interface IssuedCode {
  scope: string;
  stripeUserId: string;
  accessToken: string;
  livemode: boolean;
}

interface StripeCustomerRecord {
  name: string | null;
  email: string | null;
  created: number;
}

interface StripeInvoiceItemRecord {
  customer: string;
  amount: string;
  currency: string;
  description: string | null;
  metadata: Record<string, string>;
}

interface IssuedToken {
  scope: string;
  stripeUserId: string;
  stripeCustomers: Map<string, StripeCustomerRecord>;
  billingEntities: Record<BillingEntity, Map<string, Record<string, unknown>>>;
  invoiceLines: Map<string, Record<string, unknown>[]>;
  events: StripeEventRecord[];
  generatedInvoices: GeneratedInvoices | null;
  invoiceItems: Map<string, StripeInvoiceItemRecord>;
}

interface StripeEventRecord {
  id: string;
  type: string;
  created: number;
  data: { object: { id: string } };
}

type BillingEntity = "prices" | "subscriptions" | "invoices" | "credit_notes" | "charges" | "refunds";

interface GeneratedInvoices {
  invoiceCount: number;
  lineItemCount: number;
  createdStart: number;
  createdStepSeconds: number;
}

const BILLING_ENTITIES: BillingEntity[] = [
  "prices", "subscriptions", "invoices", "credit_notes", "charges", "refunds",
];

interface LoggedExchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
  receivedAt: number;
}

interface InvoiceItemFailure {
  remaining: number | "forever";
  status: number;
}

const pending = new Map<string, IssuedCode>();
const consumed = new Set<string>();
const issuedTokens = new Map<string, IssuedToken>();
const requests: LoggedExchange[] = [];
let invoiceItemFailure: InvoiceItemFailure | null = null;
let eventSequence = 0;

function letters(count: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(count);
  let out = "";
  for (let i = 0; i < count; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function finish(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length <= "Bearer ".length) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function lookupIssued(req: IncomingMessage): IssuedToken | null {
  const token = bearerToken(req);
  if (!token) return null;
  return issuedTokens.get(token) ?? null;
}

function parseCustomerFields(requestBody: string, contentType: string): { name: string | null; email: string | null } {
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(requestBody) as { name?: unknown; email?: unknown };
      return {
        name: typeof json.name === "string" ? json.name : null,
        email: typeof json.email === "string" ? json.email : null,
      };
    } catch {
      return { name: null, email: null };
    }
  }
  const params = new URLSearchParams(requestBody);
  return { name: params.get("name"), email: params.get("email") };
}

function listCustomers(
  issued: IssuedToken,
  email: string | null,
  startingAfter: string | null,
  limit: number,
  createdGte: number | null = null,
): { data: Array<{ id: string; object: string; name: string | null; email: string | null; created: number }>; has_more: boolean } {
  let rows = [...issued.stripeCustomers.entries()].map(([id, record]) => ({
    id,
    object: "customer",
    name: record.name,
    email: record.email,
    created: record.created,
  }));
  if (email !== null) rows = rows.filter((row) => row.email === email);
  if (createdGte !== null) rows = rows.filter((row) => row.created >= createdGte);
  if (startingAfter) {
    const index = rows.findIndex((row) => row.id === startingAfter);
    rows = index >= 0 ? rows.slice(index + 1) : [];
  }
  return {
    data: rows.slice(0, limit),
    has_more: rows.length > limit,
  };
}

function listBillingEntities(
  issued: IssuedToken,
  entity: BillingEntity,
  startingAfter: string | null,
  limit: number,
  createdGte: number | null,
): { data: Record<string, unknown>[]; has_more: boolean } {
  let rows: Record<string, unknown>[];
  if (entity === "invoices" && issued.generatedInvoices) {
    const generated = issued.generatedInvoices;
    let start = startingAfter?.startsWith("in_generated_")
      ? Number(startingAfter.slice("in_generated_".length)) + 1
      : 0;
    if (createdGte !== null && generated.createdStepSeconds > 0) {
      start = Math.max(start, Math.ceil((createdGte - generated.createdStart) / generated.createdStepSeconds));
    }
    start = Math.max(0, start);
    rows = [];
    for (let index = start; index < Math.min(generated.invoiceCount, start + limit + 1); index += 1) {
      const created = generated.createdStart + index * generated.createdStepSeconds;
      if (createdGte !== null && created < createdGte) continue;
      const baseLineCount = Math.floor(generated.lineItemCount / generated.invoiceCount);
      const extra = index < generated.lineItemCount % generated.invoiceCount ? 1 : 0;
      const lineCount = baseLineCount + extra;
      rows.push({
        id: `in_generated_${index}`,
        customer: "cus_generated",
        amount_due: (BigInt(lineCount) * 100n).toString(),
        currency: "usd",
        status: "paid",
        created,
        due_date: null,
        lines: {
          data: Array.from({ length: lineCount }, (_, lineIndex) => ({
            id: `il_generated_${index}_${lineIndex}`,
            price: "price_generated",
            quantity: "1",
            unit_amount: "100",
            amount: "100",
            currency: "usd",
          })),
          has_more: false,
        },
      });
    }
  } else {
    rows = [...issued.billingEntities[entity].values()];
    if (startingAfter) {
      const index = rows.findIndex((row) => row.id === startingAfter);
      rows = index >= 0 ? rows.slice(index + 1) : [];
    }
    if (createdGte !== null) {
      rows = rows.filter((row) => typeof row.created !== "number" || row.created >= createdGte);
    }
  }
  return { data: rows.slice(0, limit), has_more: rows.length > limit };
}

function recordEvent(issued: IssuedToken, type: string, objectId: string): void {
  eventSequence += 1;
  issued.events.push({
    id: `evt_fake_${eventSequence}`,
    type,
    created: Math.floor(Date.now() / 1_000),
    data: { object: { id: objectId } },
  });
}

function generatedInvoiceLines(issued: IssuedToken, invoiceId: string): Record<string, unknown>[] | null {
  const generated = issued.generatedInvoices;
  if (!generated || !invoiceId.startsWith("in_generated_")) return null;
  const index = Number(invoiceId.slice("in_generated_".length));
  if (!Number.isInteger(index) || index < 0 || index >= generated.invoiceCount) return null;
  const baseLineCount = Math.floor(generated.lineItemCount / generated.invoiceCount);
  const extra = index < generated.lineItemCount % generated.invoiceCount ? 1 : 0;
  return Array.from({ length: baseLineCount + extra }, (_, lineIndex) => ({
    id: `il_generated_${index}_${lineIndex}`,
    price: "price_generated",
    quantity: "1",
    unit_amount: "100",
    amount: "100",
    currency: "usd",
  }));
}

function allInvoiceLines(issued: IssuedToken, invoiceId: string): Record<string, unknown>[] | null {
  const overridden = issued.invoiceLines.get(invoiceId);
  if (overridden) return overridden;
  const generated = generatedInvoiceLines(issued, invoiceId);
  if (generated) return generated;
  const invoice = issued.billingEntities.invoices.get(invoiceId);
  const lines = invoice?.lines as { data?: unknown } | undefined;
  return lines && Array.isArray(lines.data) ? lines.data as Record<string, unknown>[] : null;
}

const port = Number(process.env.FAKE_STRIPE_PORT ?? 8092);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/healthz") {
      finish(res, 200, JSON.stringify({ status: "ok" }), "application/json");
      return;
    }
    // The debug read is not itself an OAuth exchange. Logging it would make
    // the captured body contain the log.
    if (req.method === "GET" && path === "/_requests") {
      finish(res, 200, JSON.stringify({ requests }), "application/json");
      return;
    }
    if (req.method === "POST" && path === "/_seed/customers") {
      const requestBody = await readBody(req);
      let payload: { access_token?: unknown; customers?: unknown } = {};
      try {
        payload = JSON.parse(requestBody) as { access_token?: unknown; customers?: unknown };
      } catch {
        finish(res, 400, JSON.stringify({ error: "invalid json" }), "application/json");
        return;
      }
      if (typeof payload.access_token !== "string" || !issuedTokens.has(payload.access_token)) {
        finish(res, 400, JSON.stringify({ error: "unknown access_token" }), "application/json");
        return;
      }
      if (!Array.isArray(payload.customers)) {
        finish(res, 400, JSON.stringify({ error: "customers must be an array" }), "application/json");
        return;
      }
      const issued = issuedTokens.get(payload.access_token)!;
      const seeded: string[] = [];
      for (const row of payload.customers) {
        if (typeof row !== "object" || row === null) continue;
        const record = row as { id?: unknown; name?: unknown; email?: unknown; created?: unknown };
        const id = typeof record.id === "string" && record.id.length > 0
          ? record.id
          : `cus_seed_${letters(14)}`;
        issued.stripeCustomers.set(id, {
          name: typeof record.name === "string" ? record.name : null,
          email: typeof record.email === "string" ? record.email : null,
          created: typeof record.created === "number" ? record.created : Math.floor(Date.now() / 1_000),
        });
        seeded.push(id);
      }
      finish(res, 200, JSON.stringify({ seeded: seeded.length, ids: seeded }), "application/json");
      return;
    }
    if (req.method === "POST" && path === "/_seed/invoice_lines") {
      const requestBody = await readBody(req);
      const payload = JSON.parse(requestBody) as {
        access_token?: unknown;
        invoice_id?: unknown;
        lines?: unknown;
      };
      if (typeof payload.access_token !== "string" || !issuedTokens.has(payload.access_token)) {
        finish(res, 400, JSON.stringify({ error: "unknown access_token" }), "application/json");
        return;
      }
      if (typeof payload.invoice_id !== "string" || !Array.isArray(payload.lines)) {
        finish(res, 400, JSON.stringify({ error: "invoice_id and lines are required" }), "application/json");
        return;
      }
      const lines = payload.lines.filter((line): line is Record<string, unknown> =>
        typeof line === "object" && line !== null && typeof (line as { id?: unknown }).id === "string");
      issuedTokens.get(payload.access_token)!.invoiceLines.set(payload.invoice_id, lines);
      finish(res, 200, JSON.stringify({ seeded: lines.length }), "application/json");
      return;
    }
    const seedEntity = BILLING_ENTITIES.find((entity) => path === `/_seed/${entity}`);
    if (req.method === "POST" && seedEntity) {
      const requestBody = await readBody(req);
      let payload: {
        access_token?: unknown;
        records?: unknown;
        generated?: unknown;
        [key: string]: unknown;
      } = {};
      try {
        payload = JSON.parse(requestBody) as typeof payload;
      } catch {
        finish(res, 400, JSON.stringify({ error: "invalid json" }), "application/json");
        return;
      }
      if (typeof payload.access_token !== "string" || !issuedTokens.has(payload.access_token)) {
        finish(res, 400, JSON.stringify({ error: "unknown access_token" }), "application/json");
        return;
      }
      const issued = issuedTokens.get(payload.access_token)!;
      const records = Array.isArray(payload.records)
        ? payload.records
        : Array.isArray(payload[seedEntity]) ? payload[seedEntity] as unknown[] : [];
      let seeded = 0;
      for (const value of records) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if (typeof record.id !== "string" || record.id.length === 0) continue;
        issued.billingEntities[seedEntity].set(record.id, record);
        if (seedEntity === "invoices") {
          const lines = record.lines as { data?: unknown } | undefined;
          if (!issued.invoiceLines.has(record.id) && lines && Array.isArray(lines.data)) {
            issued.invoiceLines.set(record.id, lines.data as Record<string, unknown>[]);
          }
          recordEvent(issued, "invoice.updated", record.id);
        } else if (seedEntity === "credit_notes") {
          recordEvent(issued, "credit_note.created", record.id);
        } else if (seedEntity === "charges" && record.refunded === true) {
          recordEvent(issued, "charge.refunded", record.id);
        } else if (seedEntity === "refunds") {
          const chargeId = record.charge ?? record.payment;
          if (typeof chargeId === "string" && issued.billingEntities.charges.has(chargeId)) {
            recordEvent(issued, "charge.refunded", chargeId);
          }
        }
        seeded += 1;
      }
      if (seedEntity === "invoices" && payload.generated && typeof payload.generated === "object") {
        const generated = payload.generated as Record<string, unknown>;
        const invoiceCount = Number(generated.invoice_count);
        const lineItemCount = Number(generated.line_item_count);
        const createdStart = Number(generated.created_start);
        const createdStepSeconds = Number(generated.created_step_seconds ?? 1);
        if (![invoiceCount, lineItemCount, createdStart, createdStepSeconds].every(Number.isFinite)
          || !Number.isInteger(invoiceCount) || !Number.isInteger(lineItemCount)
          || !Number.isInteger(createdStart) || !Number.isInteger(createdStepSeconds)
          || invoiceCount < 1 || lineItemCount < 0 || createdStepSeconds < 0) {
          finish(res, 400, JSON.stringify({ error: "invalid generated invoice configuration" }), "application/json");
          return;
        }
        issued.generatedInvoices = { invoiceCount, lineItemCount, createdStart, createdStepSeconds };
        seeded += invoiceCount;
      }
      finish(res, 200, JSON.stringify({ seeded }), "application/json");
      return;
    }
    if (req.method === "POST" && path === "/_revoke") {
      const requestBody = await readBody(req);
      const payload = JSON.parse(requestBody) as { access_token?: unknown };
      if (typeof payload.access_token === "string") issuedTokens.delete(payload.access_token);
      finish(res, 200, JSON.stringify({ revoked: true }), "application/json");
      return;
    }
    if (req.method === "POST" && path === "/_reset") {
      requests.length = 0;
      invoiceItemFailure = null;
      finish(res, 200, JSON.stringify({ reset: true }), "application/json");
      return;
    }
    if (req.method === "POST" && path === "/_configure") {
      const requestBody = await readBody(req);
      let payload: { invoiceitems?: unknown } = {};
      try {
        payload = JSON.parse(requestBody) as { invoiceitems?: unknown };
      } catch {
        finish(res, 400, JSON.stringify({ error: "invalid json" }), "application/json");
        return;
      }
      const config = payload.invoiceitems;
      if (config === undefined || config === null) {
        invoiceItemFailure = null;
        finish(res, 200, JSON.stringify({ invoiceitems: { failureMode: "none" } }), "application/json");
        return;
      }
      if (typeof config !== "object") {
        finish(res, 400, JSON.stringify({ error: "invalid failure configuration" }), "application/json");
        return;
      }
      const row = config as { failureMode?: unknown; status?: unknown; failCount?: unknown };
      if (row.failureMode === "none" || row.failureMode === undefined) {
        invoiceItemFailure = null;
      } else if (row.failureMode === "persistent_5xx") {
        const status = row.status === undefined ? 503 : row.status;
        if (typeof status !== "number" || !Number.isInteger(status) || status < 500) {
          finish(res, 400, JSON.stringify({ error: "status must be a 5xx integer" }), "application/json");
          return;
        }
        let remaining: number | "forever" = "forever";
        if (row.failCount !== undefined) {
          if (typeof row.failCount !== "number" || !Number.isInteger(row.failCount) || row.failCount < 0) {
            finish(res, 400, JSON.stringify({ error: "failCount must be a non-negative integer" }), "application/json");
            return;
          }
          remaining = row.failCount;
        }
        invoiceItemFailure = { remaining, status };
      } else {
        finish(res, 400, JSON.stringify({ error: "invalid failureMode" }), "application/json");
        return;
      }
      finish(res, 200, JSON.stringify({
        invoiceitems: invoiceItemFailure === null
          ? { failureMode: "none" }
          : { failureMode: "persistent_5xx", status: invoiceItemFailure.status, remaining: invoiceItemFailure.remaining },
      }), "application/json");
      return;
    }

    const requestBody = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
    let responseStatus = 404;
    let responseBody = "";

    if (req.method === "GET" && path === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        responseStatus = 400;
        responseBody = JSON.stringify({ error: "redirect_uri is required" });
        finish(res, responseStatus, responseBody, "application/json");
      } else {
        const scope = url.searchParams.get("scope") === "read_write" ? "read_write" : "read_only";
        const code = `ac_test_${letters(20)}`;
        const issued: IssuedCode = {
          scope,
          stripeUserId: `acct_${letters(16)}`,
          accessToken: `sk_test_fake_${letters(24)}`,
          livemode: url.searchParams.get("livemode") === "true",
        };
        pending.set(code, issued);
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        responseStatus = 302;
        responseBody = redirect.toString();
        res.statusCode = 302;
        res.setHeader("Location", redirect.toString());
        res.end();
      }
    } else if (req.method === "POST" && path === "/oauth/token") {
      const params = new URLSearchParams(requestBody);
      const code = params.get("code") ?? "";
      if (consumed.has(code) || !pending.has(code)) {
        responseStatus = 400;
        responseBody = JSON.stringify({ error: "invalid_grant" });
      } else {
        const issued = pending.get(code)!;
        pending.delete(code);
        consumed.add(code);
        issuedTokens.set(issued.accessToken, {
          scope: issued.scope,
          stripeUserId: issued.stripeUserId,
          stripeCustomers: new Map(),
          billingEntities: Object.fromEntries(BILLING_ENTITIES.map((entity) => [entity, new Map()])) as Record<BillingEntity, Map<string, Record<string, unknown>>>,
          invoiceLines: new Map(),
          events: [],
          generatedInvoices: null,
          invoiceItems: new Map(),
        });
        responseStatus = 200;
        responseBody = JSON.stringify({
          access_token: issued.accessToken,
          stripe_user_id: issued.stripeUserId,
          scope: issued.scope,
          livemode: issued.livemode,
          token_type: "bearer",
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && path === "/v1/customers") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const limitRaw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
        const listed = listCustomers(
          issued,
          url.searchParams.get("email"),
          url.searchParams.get("starting_after"),
          limit,
          url.searchParams.get("created[gte]") === null
            ? null
            : Number(url.searchParams.get("created[gte]")),
        );
        responseStatus = 200;
        responseBody = JSON.stringify({
          object: "list",
          url: "/v1/customers",
          has_more: listed.has_more,
          data: listed.data,
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "POST" && path === "/v1/customers") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else if (issued.scope === "read_only") {
        responseStatus = 403;
        responseBody = JSON.stringify({ error: "read_only" });
      } else {
        const fields = parseCustomerFields(requestBody, String(req.headers["content-type"] ?? ""));
        const id = `cus_${letters(14)}`;
        const created = Math.floor(Date.now() / 1_000);
        issued.stripeCustomers.set(id, { name: fields.name, email: fields.email, created });
        responseStatus = 200;
        responseBody = JSON.stringify({
          id,
          object: "customer",
          name: fields.name,
          email: fields.email,
          created,
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && path === "/v1/events") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const limitRaw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
        const createdRaw = url.searchParams.get("created[gte]");
        const createdGte = createdRaw === null ? null : Number(createdRaw);
        const types = new Set(url.searchParams.getAll("type[]"));
        let rows = [...issued.events].reverse();
        if (types.size > 0) rows = rows.filter((event) => types.has(event.type));
        if (createdGte !== null && Number.isFinite(createdGte)) {
          rows = rows.filter((event) => event.created >= createdGte);
        }
        const startingAfter = url.searchParams.get("starting_after");
        if (startingAfter) {
          const index = rows.findIndex((event) => event.id === startingAfter);
          rows = index >= 0 ? rows.slice(index + 1) : [];
        }
        responseStatus = 200;
        responseBody = JSON.stringify({
          object: "list",
          url: "/v1/events",
          has_more: rows.length > limit,
          data: rows.slice(0, limit),
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && /^\/v1\/invoices\/[^/]+\/lines$/.test(path)) {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const invoiceId = decodeURIComponent(path.split("/")[3]);
        let rows = allInvoiceLines(issued, invoiceId);
        if (rows === null) {
          responseStatus = 404;
          responseBody = JSON.stringify({ error: "not_found" });
        } else {
          const startingAfter = url.searchParams.get("starting_after");
          if (startingAfter) {
            const index = rows.findIndex((line) => line.id === startingAfter);
            rows = index >= 0 ? rows.slice(index + 1) : [];
          }
          const limitRaw = Number(url.searchParams.get("limit") ?? 100);
          const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
          responseStatus = 200;
          responseBody = JSON.stringify({
            object: "list",
            url: `/v1/invoices/${invoiceId}/lines`,
            has_more: rows.length > limit,
            data: rows.slice(0, limit),
          });
        }
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && /^\/v1\/(invoices|credit_notes|charges)\/[^/]+$/.test(path)) {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const [, , rawEntity, rawId] = path.split("/");
        const entity = rawEntity as Extract<BillingEntity, "invoices" | "credit_notes" | "charges">;
        const id = decodeURIComponent(rawId);
        const record = issued.billingEntities[entity].get(id);
        if (!record) {
          responseStatus = 404;
          responseBody = JSON.stringify({ error: "not_found" });
        } else {
          responseStatus = 200;
          responseBody = JSON.stringify(record);
        }
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && BILLING_ENTITIES.some((entity) => path === `/v1/${entity}`)) {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const entity = BILLING_ENTITIES.find((candidate) => path === `/v1/${candidate}`)!;
        const limitRaw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
        const createdRaw = url.searchParams.get("created[gte]");
        const createdGte = createdRaw === null ? null : Number(createdRaw);
        const listed = listBillingEntities(
          issued,
          entity,
          url.searchParams.get("starting_after"),
          limit,
          createdGte !== null && Number.isFinite(createdGte) ? createdGte : null,
        );
        responseStatus = 200;
        responseBody = JSON.stringify({
          object: "list",
          url: `/v1/${entity}`,
          has_more: listed.has_more,
          data: listed.data,
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "POST" && path === "/v1/invoiceitems") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else if (issued.scope === "read_only") {
        responseStatus = 403;
        responseBody = JSON.stringify({ error: "read_only" });
      } else if (invoiceItemFailure && invoiceItemFailure.remaining !== 0) {
        responseStatus = invoiceItemFailure.status;
        responseBody = JSON.stringify({ error: "simulated upstream failure" });
        if (invoiceItemFailure.remaining !== "forever") invoiceItemFailure.remaining -= 1;
      } else {
        const params = new URLSearchParams(requestBody);
        const customer = params.get("customer") ?? "";
        const amount = params.get("amount") ?? "";
        const currency = params.get("currency") ?? "usd";
        const description = params.get("description");
        const metadata: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          const match = /^metadata\[([^\]]+)\]$/.exec(key);
          if (match) metadata[match[1]] = value;
        }
        if (!customer || !amount) {
          responseStatus = 400;
          responseBody = JSON.stringify({ error: "customer and amount are required" });
        } else {
          const id = `ii_${letters(16)}`;
          issued.invoiceItems.set(id, { customer, amount, currency, description, metadata });
          responseStatus = 200;
          responseBody = JSON.stringify({
            id,
            object: "invoiceitem",
            customer,
            amount,
            currency,
            description,
            metadata,
          });
        }
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "POST" && path === "/oauth/deauthorize") {
      const params = new URLSearchParams(requestBody);
      responseStatus = 200;
      responseBody = JSON.stringify({ stripe_user_id: params.get("stripe_user_id") ?? "" });
      finish(res, responseStatus, responseBody, "application/json");
    } else if (responseStatus === 404) {
      responseBody = JSON.stringify({ error: "not_found" });
      finish(res, 404, responseBody, "application/json");
    }

    requests.push({
      method: req.method ?? "GET",
      path,
      query: url.search,
      requestBody,
      responseStatus,
      // Scale fixtures can return tens of thousands of generated lines per
      // page. Keep request attribution without retaining the whole 2M-line
      // dataset in the debug log after each response has been sent.
      responseBody: responseBody.length > 100_000
        ? JSON.stringify({ truncated: true, characters: responseBody.length })
        : responseBody,
      receivedAt: Date.now(),
    });
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-stripe: listening on http://127.0.0.1:${port}`);
});
