import "./env.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LEDGER_TOTAL_CHANGED,
  PERIOD_CLOSE_STRIPE_BASE_DELAY_MS,
  PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS,
  PERIOD_CLOSE_STRIPE_MAX_DELAY_MS,
  PERIOD_CLOSE_STRIPE_REQUESTS_PER_MINUTE,
  PERIOD_CLOSE_SYNC_STALL_MS,
  buildLedgerReference,
  evaluateStalledPeriodCloseInvoiceSyncs,
  periodCloseStripeBackoffMs,
  syncPeriodCloseInvoice,
} from "../../services/ts-console/src/lib/periodCloseInvoiceSync.js";
import { appPool, createCustomer, superPool, withTenant } from "./db.js";
import { FAKE_STRIPE_URL, TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { billingSession } from "./session.js";

const suiteMarker = `teid-39-${randomUUID()}`;
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";

interface LoggedExchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
  receivedAt: number;
}

interface AlertRequest {
  body: string;
  eventType: string;
}

let token: string;
let alertServer: Server | null = null;
let alertOrigin = "";
const alerts: AlertRequest[] = [];
const createdCustomerIds: string[] = [];

function requestWithoutRedirect(target: string): Promise<{ status: number; location: string | null }> {
  const url = new URL(target);
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(url, { method: "GET" }, (res) => {
      res.resume();
      const location = res.headers.location;
      resolve({
        status: res.statusCode ?? 0,
        location: Array.isArray(location) ? location[0] ?? null : location ?? null,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fakeLog(): Promise<LoggedExchange[]> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_requests`);
  const body = await response.json() as { requests: LoggedExchange[] };
  return body.requests;
}

async function configureInvoiceItems(config: {
  failureMode: "none" | "persistent_5xx";
  status?: number;
  failCount?: number;
}): Promise<void> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceitems: config }),
  });
  if (!response.ok) throw new Error(`configure failed ${response.status} ${await response.text()}`);
  await response.text();
}

async function redeem(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const redirected = await requestWithoutRedirect(authorizeUrl);
  expect(redirected.status).toBe(302);
  expect(redirected.location).toBeTruthy();
  const location = new URL(redirected.location!, authorizeUrl);
  const code = location.searchParams.get("code");
  const state = location.searchParams.get("state");
  expect(code).toBeTruthy();
  expect(state).toBeTruthy();
  return { code: code!, state: state! };
}

async function connectReadWrite(): Promise<string> {
  const started = await call(`${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=read_write`, { token });
  expect(started.status).toBe(200);
  const redeemed = await redeem(started.body.url);
  const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
    method: "POST",
    token,
    body: { code: redeemed.code, state: redeemed.state },
  });
  expect(created.status).toBe(201);
  const log = await fakeLog();
  const hit = [...log].reverse().find((row) =>
    row.path === "/oauth/token" && row.requestBody.includes(`code=${redeemed.code}`) && row.responseStatus === 200,
  );
  if (!hit) throw new Error("no token exchange recorded");
  return JSON.parse(hit.responseBody).access_token as string;
}

async function seedStripeCustomer(accessToken: string, id: string): Promise<void> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_seed/customers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, customers: [{ id, name: "Period Close", email: `${id}@stripe.test` }] }),
  });
  if (!response.ok) throw new Error(`seed failed ${response.status} ${await response.text()}`);
}

async function linkCustomer(customerId: string, stripeCustomerId: string): Promise<void> {
  await withTenant(TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
       VALUES ($1, $2, $3, 'manual_create_in_stripe')`,
      [TENANT_ID, customerId, stripeCustomerId],
    );
  });
}

async function seedUsage(customerId: string, usageAmount: string, overageAmount: string): Promise<string> {
  const consumptionId = randomUUID();
  await withTenant(TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO usage_consumptions (id, tenant_id, customer_id, requested_amount, unit, occurred_at)
       VALUES ($1, $2, $3, $4, 'credits', '2026-08-15T12:00:00Z')`,
      [consumptionId, TENANT_ID, customerId, usageAmount],
    );
    await client.query(
      `INSERT INTO usage_consumption_lines (tenant_id, consumption_id, source_category, amount)
       VALUES ($1, $2, 'paid', $3), ($1, $2, 'overage', $4)`,
      [TENANT_ID, consumptionId, usageAmount, overageAmount],
    );
  });
  return consumptionId;
}

function syncUrl(customerId: string): string {
  return `${TS_CONSOLE_URL}/period-close/${customerId}/stripe-sync`;
}

function triggerSync(customerId: string) {
  return call(syncUrl(customerId), {
    method: "POST",
    token,
    body: { period_start: PERIOD_START, period_end: PERIOD_END },
  });
}

function invoiceCreates(log: LoggedExchange[], stripeCustomerId: string): LoggedExchange[] {
  return log.filter((row) =>
    row.method === "POST"
    && row.path === "/v1/invoiceitems"
    && row.requestBody.includes(`customer=${stripeCustomerId}`),
  );
}

function successfulCreates(log: LoggedExchange[], stripeCustomerId: string): LoggedExchange[] {
  return invoiceCreates(log, stripeCustomerId).filter((row) => row.responseStatus === 200);
}

async function prepareCustomer(usage: string, overage: string): Promise<{
  customerId: string;
  stripeCustomerId: string;
  consumptionId: string;
}> {
  const name = `${suiteMarker}-${randomUUID()}`;
  const customerId = await createCustomer(TENANT_ID, name);
  createdCustomerIds.push(customerId);
  const accessToken = await connectReadWrite();
  const stripeCustomerId = `cus_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  await seedStripeCustomer(accessToken, stripeCustomerId);
  await linkCustomer(customerId, stripeCustomerId);
  const consumptionId = await seedUsage(customerId, usage, overage);
  return { customerId, stripeCustomerId, consumptionId };
}

async function startAlertReceiver(): Promise<string> {
  if (alertServer) return alertOrigin;
  alertServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const eventType = String(req.headers["x-teideal-event-type"] ?? "");
    alerts.push({ body, eventType });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => alertServer!.listen(0, "127.0.0.1", resolve));
  const address = alertServer.address();
  if (!address || typeof address === "string") throw new Error("alert receiver did not bind");
  alertOrigin = `http://127.0.0.1:${address.port}`;
  return alertOrigin;
}

beforeAll(async () => {
  token = await billingSession();
  await startAlertReceiver();
  const endpoint = await call(`${TS_CONSOLE_URL}/webhook-endpoints`, {
    method: "POST",
    token,
    body: { url: `${alertOrigin}/webhook`, subscribed_events: ["period_close_sync.stalled"] },
  });
  expect(endpoint.status).toBe(201);
});

afterEach(async () => {
  await configureInvoiceItems({ failureMode: "none" });
});

afterAll(async () => {
  if (alertServer) {
    await new Promise<void>((resolve, reject) => alertServer!.close((error) => error ? reject(error) : resolve()));
  }
  if (createdCustomerIds.length > 0) {
    const client = await superPool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(`DELETE FROM period_close_invoice_line_items WHERE customer_id = ANY($1::uuid[])`, [createdCustomerIds]);
      await client.query(`DELETE FROM period_close_invoice_sync_attempts WHERE customer_id = ANY($1::uuid[])`, [createdCustomerIds]);
      await client.query(`DELETE FROM stripe_customer_links WHERE customer_id = ANY($1::uuid[])`, [createdCustomerIds]);
      await client.query(`DELETE FROM usage_consumption_lines WHERE consumption_id IN (SELECT id FROM usage_consumptions WHERE customer_id = ANY($1::uuid[]))`, [createdCustomerIds]);
      await client.query(`DELETE FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])`, [createdCustomerIds]);
      await client.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [createdCustomerIds]);
    } finally {
      await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
      client.release();
    }
  }
  await withTenant(TENANT_ID, (client) =>
    client.query(`DELETE FROM webhook_endpoints WHERE url LIKE $1`, [`${alertOrigin}%`]),
  );
});

describe("TEID-39 period-close Stripe invoice sync", () => {
  it("TEID-39-T1 writes usage and overage line items totaling $425.00", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    const response = await triggerSync(customerId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("succeeded");

    const created = successfulCreates(await fakeLog(), stripeCustomerId);
    expect(created).toHaveLength(2);
    const amounts = created.map((row) => new URLSearchParams(row.requestBody).get("amount")).sort();
    expect(amounts).toEqual(["34000", "8500"]);
    expect(amounts.reduce((sum, value) => sum + BigInt(value ?? "0"), 0n).toString()).toBe("42500");
  });

  it("TEID-39-T2 stamps a reconstructable ledger_reference on each Stripe invoice item", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    const response = await triggerSync(customerId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("succeeded");

    const created = successfulCreates(await fakeLog(), stripeCustomerId);
    expect(created).toHaveLength(2);
    for (const row of created) {
      const params = new URLSearchParams(row.requestBody);
      const amount = params.get("amount");
      const category = amount === "34000" ? "usage" : "overage";
      const expected = buildLedgerReference(TENANT_ID, customerId, PERIOD_START, category);
      expect(params.get("metadata[ledger_reference]")).toBe(expected);
      expect(params.get("description")).toContain(expected);
    }
  });

  it("TEID-39-T3 re-trigger returns existing line items and does not create duplicates", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    const first = await triggerSync(customerId);
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("succeeded");
    const afterFirst = successfulCreates(await fakeLog(), stripeCustomerId);
    expect(afterFirst).toHaveLength(2);

    const second = await triggerSync(customerId);
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(2);
    expect(second.body.data.map((row: { category: string }) => row.category).sort()).toEqual(["overage", "usage"]);
    expect(successfulCreates(await fakeLog(), stripeCustomerId)).toHaveLength(2);
  });

  it("TEID-39-T4 retries Stripe 503s with backoff and fires one stall alert after 1 hour", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    await configureInvoiceItems({ failureMode: "persistent_5xx", status: 503 });
    alerts.length = 0;
    const started = Date.now();
    const response = await triggerSync(customerId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("failed");
    const attempts = invoiceCreates(await fakeLog(), stripeCustomerId);
    expect(attempts.length).toBeGreaterThanOrEqual(PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS);
    expect(attempts.every((row) => row.responseStatus === 503)).toBe(true);
    expect(successfulCreates(await fakeLog(), stripeCustomerId)).toHaveLength(0);

    const attempt = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ id: string; started_at: Date }>(
        `SELECT id, started_at FROM period_close_invoice_sync_attempts
         WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [customerId],
      )).rows[0],
    );
    expect(attempt).toBeTruthy();
    const stallAt = new Date(new Date(attempt.started_at).getTime() + PERIOD_CLOSE_SYNC_STALL_MS + 1);
    await evaluateStalledPeriodCloseInvoiceSyncs(appPool, stallAt);
    await evaluateStalledPeriodCloseInvoiceSyncs(appPool, stallAt);
    const stallAlerts = alerts.filter((row) => row.eventType === "period_close_sync.stalled");
    expect(stallAlerts).toHaveLength(1);
    const payload = JSON.parse(stallAlerts[0].body) as { message: string; customer_id: string; period_start: string };
    expect(payload.customer_id).toBe(customerId);
    expect(payload.period_start).toBe(PERIOD_START);
    expect(payload.message).toContain(customerId);
    expect(payload.message).toContain(PERIOD_START);
    expect(payload.message.toLowerCase()).not.toContain("http 503");
    expect(payload.message.toLowerCase()).not.toContain("simulated upstream failure");
    expect(Date.now() - started).toBeLessThan(PERIOD_CLOSE_SYNC_STALL_MS);
  }, 60_000);

  it("TEID-39-T5 spaces retries on ConnectorHttpClient backoff and stays within the RPM budget", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    await configureInvoiceItems({ failureMode: "persistent_5xx", status: 503 });
    const response = await triggerSync(customerId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("failed");

    const attempts = invoiceCreates(await fakeLog(), stripeCustomerId);
    expect(attempts.length).toBeGreaterThanOrEqual(PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS);
    expect(attempts.length).toBe(PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS);
    const gaps = attempts.slice(1).map((row, index) => row.receivedAt - attempts[index].receivedAt);
    for (let index = 0; index < gaps.length; index += 1) {
      const expected = periodCloseStripeBackoffMs(index + 1);
      expect(expected).toBe(Math.min(
        PERIOD_CLOSE_STRIPE_BASE_DELAY_MS * 2 ** index,
        PERIOD_CLOSE_STRIPE_MAX_DELAY_MS,
      ));
      expect(gaps[index]).toBeGreaterThanOrEqual(expected);
      expect(gaps[index]).toBeLessThan(expected + 750);
    }
    const elapsedMs = attempts.at(-1)!.receivedAt - attempts[0].receivedAt;
    expect(elapsedMs).toBeGreaterThan(0);
    const observedRpm = ((attempts.length - 1) * 60_000) / elapsedMs;
    expect(observedRpm).toBeLessThanOrEqual(PERIOD_CLOSE_STRIPE_REQUESTS_PER_MINUTE);

    const attempt = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ started_at: Date }>(
        `SELECT started_at FROM period_close_invoice_sync_attempts
         WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [customerId],
      )).rows[0],
    );
    const before = alerts.length;
    await evaluateStalledPeriodCloseInvoiceSyncs(
      appPool,
      new Date(new Date(attempt.started_at).getTime() + PERIOD_CLOSE_SYNC_STALL_MS + 1),
    );
    expect(alerts.length).toBeGreaterThan(before);
    expect(attempts.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("TEID-39-T6 concurrent syncs create one Stripe item per category", async () => {
    const { customerId, stripeCustomerId } = await prepareCustomer("340.00", "85.00");
    const [first, second] = await Promise.all([triggerSync(customerId), triggerSync(customerId)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
    const created = first.status === 202 ? first : second;
    const duplicate = first.status === 200 ? first : second;
    expect(created.body.status).toBe("succeeded");
    expect(duplicate.body.data).toHaveLength(2);
    expect(successfulCreates(await fakeLog(), stripeCustomerId)).toHaveLength(2);
  });

  it("TEID-39-T7 aborts when the ledger total changes before the Stripe write", async () => {
    const { customerId, stripeCustomerId, consumptionId } = await prepareCustomer("340.00", "85.00");
    const stale = await syncPeriodCloseInvoice({
      pool: appPool,
      tenantId: TENANT_ID,
      customerId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      beforeStripeWrite: async () => {
        await withTenant(TENANT_ID, async (client) => {
          await client.query(
            `INSERT INTO usage_consumption_lines (tenant_id, consumption_id, source_category, amount)
             VALUES ($1, $2, 'paid', 60.00)`,
            [TENANT_ID, consumptionId],
          );
        });
      },
    });
    expect(stale.status).toBe("failed");
    expect(stale.errorMessage).toBe(LEDGER_TOTAL_CHANGED);
    expect(successfulCreates(await fakeLog(), stripeCustomerId)).toHaveLength(0);
    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM period_close_invoice_sync_attempts
         WHERE customer_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [customerId],
      )).rows[0],
    );
    expect(stored.status).toBe("failed");
    expect(stored.error_message).toContain("ledger total changed");

    const retry = await triggerSync(customerId);
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe("succeeded");
    const created = successfulCreates(await fakeLog(), stripeCustomerId);
    expect(created).toHaveLength(2);
    const amounts = created.map((row) => new URLSearchParams(row.requestBody).get("amount")).sort();
    expect(amounts).toEqual(["40000", "8500"]);
    expect(amounts).not.toContain("34000");
  });
});
