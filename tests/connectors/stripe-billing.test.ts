// TEID-65 Stripe acceptance tests. Environment must be initialized before the
// in-process connector imports stripeConnect.ts and decodes OAuth tokens.
import "./env.js";
import { afterAll, describe, expect, it } from "vitest";
import type { Connector } from "../../services/ts-console/src/lib/connectors/connector.js";
import { createConnectorHttpClient } from "../../services/ts-console/src/lib/connectors/httpClient.js";
import { MockConnector } from "../../services/ts-console/src/lib/connectors/mockConnector.js";
import { StripeBillingConnector, STRIPE_BILLING_ENTITY_TYPES } from "../../services/ts-console/src/lib/connectors/stripeBillingConnector.js";
import {
  backfillTick,
  connectorIncrementalIntervalMs,
  incrementalTick,
  runConnectorSync,
  type SyncConnectorRow,
} from "../../services/ts-console/src/lib/connectors/syncWorker.js";
import { getSyncHealth } from "../../services/ts-console/src/lib/connectors/syncHealth.js";
import { pool, withTenant } from "./db.js";
import { FAKE_STRIPE_URL, TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { billingSession } from "./session.js";

interface ConnectedStripe {
  connectionId: string;
  connectorId: string;
  accessToken: string;
}

interface FakeRequest {
  path: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
}

class NetworkFailingConnector implements Connector {
  private readonly delegate: MockConnector;
  constructor(readonly connectorType: string) {
    this.delegate = new MockConnector({
      baseUrl: "http://127.0.0.1:1",
      httpClient: createConnectorHttpClient({
        baseUrl: "http://127.0.0.1:1",
        maxAttempts: 1,
        timeoutMs: 200,
      }),
    });
  }
  listCustomers(...args: Parameters<Connector["listCustomers"]>) { return this.delegate.listCustomers(...args); }
  listPrices(...args: Parameters<Connector["listPrices"]>) { return this.delegate.listPrices(...args); }
  listContracts(...args: Parameters<Connector["listContracts"]>) { return this.delegate.listContracts(...args); }
  listInvoices(...args: Parameters<Connector["listInvoices"]>) { return this.delegate.listInvoices(...args); }
  listCredits(...args: Parameters<Connector["listCredits"]>) { return this.delegate.listCredits(...args); }
  listPayments(...args: Parameters<Connector["listPayments"]>) { return this.delegate.listPayments(...args); }
  listRefunds(...args: Parameters<Connector["listRefunds"]>) { return this.delegate.listRefunds(...args); }
}

async function fakeRequests(): Promise<FakeRequest[]> {
  return (await (await fetch(`${FAKE_STRIPE_URL}/_requests`)).json() as { requests: FakeRequest[] }).requests;
}

async function oauthConnection(token: string, scope: "read_only" | "read_write") {
  const started = await call<{ url: string }>(
    `${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=${scope}`,
    { token },
  );
  expect(started.status).toBe(200);
  const redirected = await fetch(started.body.url, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const location = new URL(redirected.headers.get("location")!, started.body.url);
  const code = location.searchParams.get("code")!;
  const state = location.searchParams.get("state")!;
  const created = await call<{ id: string }>(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
    method: "POST",
    token,
    body: { code, state },
  });
  expect(created.status).toBe(201);
  const exchange = [...await fakeRequests()].reverse().find((request) =>
    request.path === "/oauth/token" && request.requestBody.includes(`code=${code}`) && request.responseStatus === 200);
  if (!exchange) throw new Error("fake Stripe token exchange was not logged");
  return {
    connectionId: created.body.id,
    accessToken: (JSON.parse(exchange.responseBody) as { access_token: string }).access_token,
  };
}

async function connectAndRegister(displayName: string): Promise<ConnectedStripe> {
  const session = await billingSession();
  const connected = await oauthConnection(session, "read_only");
  const registered = await call<{ id: string; status: string }>(`${TS_CONSOLE_URL}/connectors/stripe/register`, {
    method: "POST",
    token: session,
    body: { stripe_connection_id: connected.connectionId, display_name: displayName },
  });
  expect(registered.status).toBe(201);
  expect(registered.body.status).toBe("connected");
  return { ...connected, connectorId: registered.body.id };
}

async function seed(accessToken: string, entity: string, records: unknown[] | null, generated?: Record<string, unknown>) {
  const payload = entity === "customers"
    ? { access_token: accessToken, customers: records ?? [] }
    : { access_token: accessToken, records, generated };
  const response = await fetch(`${FAKE_STRIPE_URL}/_seed/${entity}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

async function connectorRow(id: string): Promise<SyncConnectorRow> {
  return withTenant(TENANT_ID, async (client) => (await client.query<SyncConnectorRow>(
    `SELECT id, tenant_id, connector_type, display_name, status, stripe_connection_id,
            backfill_completed_at, cursor_high_water
     FROM connectors WHERE id = $1`,
    [id],
  )).rows[0]);
}

async function deleteFixture(id: string, connectionId: string) {
  await withTenant(TENANT_ID, async (client) => {
    await client.query("DELETE FROM connectors WHERE id = $1", [id]);
    // teideal_app has no DELETE grant on stripe_connections (production only
    // ever soft-disconnects it); match that here instead of hard-deleting.
    await client.query("UPDATE stripe_connections SET status = 'disconnected' WHERE id = $1", [connectionId]);
  });
}

afterAll(async () => {
  await withTenant(TENANT_ID, async (client) => {
    await client.query("DELETE FROM connectors WHERE display_name LIKE 'TEID-65 %'");
  });
  await pool.end();
});

describe("TEID-65 Stripe Billing connector", () => {
  it("TEID-65-T1 completes real read-only OAuth registration and exposes Connected health immediately", async () => {
    const startedAt = Date.now();
    const fixture = await connectAndRegister("TEID-65 T1 Stripe");
    try {
      const health = await call<{ data: Array<Record<string, unknown>> }>(`${TS_CONSOLE_URL}/connectors/sync-health`, {
        token: await billingSession(),
      });
      expect(health.status).toBe(200);
      expect(health.body.data.find((row) => row.connector_id === fixture.connectorId)).toMatchObject({
        status: "connected",
        backfill_completed_at: null,
        last_error: null,
      });
      expect(Date.now() - startedAt).toBeLessThan(60_000);
    } finally {
      await deleteFixture(fixture.connectorId, fixture.connectionId);
    }
  });

  it("TEID-65-T2 rejects Stripe-granted write scope and creates no connector", async () => {
    const session = await billingSession();
    const connected = await oauthConnection(session, "read_write");
    try {
      const response = await call<{ error: string }>(`${TS_CONSOLE_URL}/connectors/stripe/register`, {
        method: "POST",
        token: session,
        body: { stripe_connection_id: connected.connectionId, display_name: "TEID-65 T2 Rejected" },
      });
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/must be read-only/i);
      const count = await withTenant(TENANT_ID, async (client) => (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM connectors WHERE display_name = 'TEID-65 T2 Rejected'`,
      )).rows[0].count);
      expect(count).toBe(0);
    } finally {
      await withTenant(TENANT_ID, async (client) => {
        await client.query("UPDATE stripe_connections SET status = 'disconnected' WHERE id = $1", [connected.connectionId]);
      });
    }
  });

  it("TEID-65-T3 imports exact counts for all seven entities and embedded invoice lines", async () => {
    const fixture = await connectAndRegister("TEID-65 T3 Counts");
    const created = Math.floor(Date.now() / 1_000);
    try {
      await seed(fixture.accessToken, "customers", [{ id: "cus_65_1", name: "A", email: "a@test", created }]);
      await seed(fixture.accessToken, "prices", [{ id: "price_65_1", product: "prod_65", unit_amount: "100", currency: "usd", billing_scheme: "per_unit", created }]);
      await seed(fixture.accessToken, "subscriptions", [{ id: "sub_65_1", customer: "cus_65_1", status: "active", start_date: created, ended_at: null, created }]);
      await seed(fixture.accessToken, "invoices", [{
        id: "in_65_1", customer: "cus_65_1", amount_due: "200", currency: "usd", status: "paid",
        created, due_date: null, lines: { data: [
          { id: "il_65_1", price: "price_65_1", quantity: "1", unit_amount: "100", amount: "100", currency: "usd" },
          { id: "il_65_2", price: "price_65_1", quantity: "1", unit_amount: "100", amount: "100", currency: "usd" },
        ] },
      }]);
      await seed(fixture.accessToken, "credit_notes", [{ id: "cn_65_1", customer: "cus_65_1", amount: "25", currency: "usd", reason: "adjustment", created }]);
      await seed(fixture.accessToken, "charges", [{ id: "ch_65_1", customer: "cus_65_1", invoice: "in_65_1", amount: "200", currency: "usd", status: "succeeded", created }]);
      await seed(fixture.accessToken, "refunds", [{ id: "re_65_1", payment: "ch_65_1", amount: "25", currency: "usd", reason: null, created }]);
      const sync = await call<{ completed: boolean; recordsSynced: number }>(`${TS_CONSOLE_URL}/connectors/${fixture.connectorId}/sync`, {
        method: "POST", token: await billingSession(),
      });
      expect(sync.status).toBe(200);
      expect(sync.body.completed).toBe(true);
      const counts = await withTenant(TENANT_ID, async (client) => (await client.query<{ entity_type: string; count: number }>(
        `SELECT entity_type, count(*)::int AS count FROM connector_records
         WHERE connector_id = $1 GROUP BY entity_type ORDER BY entity_type`,
        [fixture.connectorId],
      )).rows);
      expect(Object.fromEntries(counts.map((row) => [row.entity_type, row.count]))).toEqual({
        contract: 1, credit: 1, customer: 1, invoice: 1, payment: 1, price: 1, refund: 1,
      });
      const lineCount = await withTenant(TENANT_ID, async (client) => (await client.query<{ count: number }>(
        `SELECT COALESCE(sum(jsonb_array_length(data->'lines')), 0)::int AS count
         FROM connector_records WHERE connector_id = $1 AND entity_type = 'invoice'`,
        [fixture.connectorId],
      )).rows[0].count);
      expect(lineCount).toBe(2);
    } finally {
      await deleteFixture(fixture.connectorId, fixture.connectionId);
    }
  });

  it("TEID-65-T4 limits first sync to 24 months and the hourly incremental path picks up a new invoice", async () => {
    const fixture = await connectAndRegister("TEID-65 T4 Window");
    const now = new Date();
    const invoices = Array.from({ length: 30 }, (_, index) => {
      const createdAt = new Date(now);
      createdAt.setUTCMonth(createdAt.getUTCMonth() - index);
      // The 24-months-ago cutoff is itself computed a moment later, from the
      // server's own clock reading when the sync attempt starts. Index 24
      // lands essentially on that cutoff, so push it (and everything meant
      // to fall outside the window) back by an extra day -- otherwise
      // whether it's included depends on sub-second timing between this
      // line and the server resolving "now", which is not what T4 is
      // actually testing.
      if (index >= 24) createdAt.setUTCDate(createdAt.getUTCDate() - 1);
      return { id: `in_65_month_${index}`, customer: "cus_month", amount_due: "100", currency: "usd", status: "paid", created: Math.floor(createdAt.getTime() / 1_000), due_date: null, lines: { data: [] } };
    });
    try {
      await seed(fixture.accessToken, "invoices", invoices);
      const first = await call(`${TS_CONSOLE_URL}/connectors/${fixture.connectorId}/sync`, { method: "POST", token: await billingSession() });
      expect(first.status).toBe(200);
      expect((await connectorRow(fixture.connectorId)).backfill_completed_at).not.toBeNull();
      const count = await withTenant(TENANT_ID, async (client) => (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM connector_records WHERE connector_id = $1 AND entity_type = 'invoice'`,
        [fixture.connectorId],
      )).rows[0].count);
      expect(count).toBe(24);
      const newCreated = Math.floor(Date.now() / 1_000) + 2;
      await seed(fixture.accessToken, "invoices", [{ id: "in_65_incremental", customer: "cus_month", amount_due: "500", currency: "usd", status: "open", created: newCreated, due_date: null, lines: { data: [] } }]);
      expect(await incrementalTick(pool, new Date(Date.now() + 3_000))).toBeGreaterThanOrEqual(1);
      const exists = await withTenant(TENANT_ID, async (client) => (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM connector_records WHERE connector_id = $1 AND external_id = 'in_65_incremental'`,
        [fixture.connectorId],
      )).rows[0].count);
      expect(exists).toBe(1);
      expect(connectorIncrementalIntervalMs()).toBeLessThanOrEqual(60 * 60_000);
    } finally {
      await deleteFixture(fixture.connectorId, fixture.connectionId);
    }
  });

  it("TEID-65-T5 re-resolves a revoked token mid-sync and preserves plain-English health plus the last success", async () => {
    const fixture = await connectAndRegister("TEID-65 T5 Revoked");
    try {
      const firstRow = await connectorRow(fixture.connectorId);
      await runConnectorSync(pool, TENANT_ID, firstRow, new StripeBillingConnector(pool, TENANT_ID, fixture.connectionId), {
        entityTypes: STRIPE_BILLING_ENTITY_TYPES, timeBudgetMs: null,
      });
      await withTenant(TENANT_ID, async (client) => {
        await client.query("UPDATE connectors SET backfill_completed_at = now() WHERE id = $1", [fixture.connectorId]);
      });
      const before = (await getSyncHealth(pool, TENANT_ID)).find((row) => row.connector_id === fixture.connectorId)!;
      const created = Math.floor(Date.now() / 1_000) + 5;
      await seed(fixture.accessToken, "customers", Array.from({ length: 101 }, (_, index) => ({ id: `cus_revoke_${index}`, name: `Customer ${index}`, email: null, created })));
      const baseClient = createConnectorHttpClient({ baseUrl: FAKE_STRIPE_URL, maxAttempts: 1, timeoutMs: 2_000 });
      let revoked = false;
      const revokingClient = {
        async get(path: string, headers?: Record<string, string>) {
          const response = await baseClient.get(path, headers);
          if (!revoked) {
            revoked = true;
            await fetch(`${FAKE_STRIPE_URL}/_revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: fixture.accessToken }) });
          }
          return response;
        },
      };
      const row = await connectorRow(fixture.connectorId);
      await expect(runConnectorSync(
        pool,
        TENANT_ID,
        row,
        new StripeBillingConnector(pool, TENANT_ID, fixture.connectionId, { httpClient: revokingClient }),
        { entityTypes: STRIPE_BILLING_ENTITY_TYPES, timeBudgetMs: null },
      )).rejects.toThrow();
      const healthResponse = await call<{ data: Awaited<ReturnType<typeof getSyncHealth>> }>(
        `${TS_CONSOLE_URL}/connectors/sync-health`,
        { token: await billingSession() },
      );
      expect(healthResponse.status).toBe(200);
      const after = healthResponse.body.data.find((health) => health.connector_id === fixture.connectorId)!;
      expect(after.last_sync_at).toBe(before.last_sync_at);
      expect(after.last_error).toMatch(/authorization is no longer valid/i);
      expect(after.last_error).not.toMatch(/401|\{"error"/);
    } finally {
      await deleteFixture(fixture.connectorId, fixture.connectionId);
    }
  });

  it("TEID-65-T6 persists two million generated invoice lines within the scaled CI budget", async () => {
    const fixture = await connectAndRegister("TEID-65 T6 Scale");
    const lineItemCount = 2_000_000;
    const budgetMs = Number(process.env.CONNECTOR_BACKFILL_SCALE_BUDGET_MS ?? 15 * 60_000);
    // Manual production-target run: CONNECTOR_BACKFILL_SCALE_BUDGET_MS=14400000 (4 hours).
    try {
      await seed(fixture.accessToken, "invoices", null, {
        invoice_count: 20_000,
        line_item_count: lineItemCount,
        created_start: Math.floor(Date.now() / 1_000) - 3600,
        created_step_seconds: 0,
      });
      const started = Date.now();
      let row = await connectorRow(fixture.connectorId);
      while (row.backfill_completed_at === null) {
        await backfillTick(pool, new Date());
        row = await connectorRow(fixture.connectorId);
        if (Date.now() - started >= budgetMs) throw new Error("scaled connector backfill budget exhausted");
      }
      expect(row.backfill_completed_at).not.toBeNull();
      const storedLines = await withTenant(TENANT_ID, async (client) => (await client.query<{ count: string }>(
        `SELECT COALESCE(sum(jsonb_array_length(data->'lines')), 0)::text AS count
         FROM connector_records WHERE connector_id = $1 AND entity_type = 'invoice'`,
        [fixture.connectorId],
      )).rows[0].count);
      expect(storedLines).toBe(String(lineItemCount));
      expect(Date.now() - started).toBeLessThan(budgetMs);
    } finally {
      await deleteFixture(fixture.connectorId, fixture.connectionId);
    }
  }, 20 * 60_000);

  it("TEID-65-T7 attributes network failures distinctly across three connector types", async () => {
    const ids = await withTenant(TENANT_ID, async (client) => (await client.query<{ id: string; connector_type: string }>(
      `INSERT INTO connectors (tenant_id, connector_type, display_name, backfill_completed_at)
       VALUES
         ($1, 'stripe', 'TEID-65 T7 Stripe', now()),
         ($1, 'csv_import', 'TEID-65 T7 CSV', now()),
         ($1, 'csv_mock', 'TEID-65 T7 Generic', now())
       RETURNING id, connector_type`,
      [TENANT_ID],
    )).rows);
    try {
      for (const item of ids) {
        const row = await connectorRow(item.id);
        await expect(runConnectorSync(
          pool,
          TENANT_ID,
          row,
          new NetworkFailingConnector(item.connector_type),
          { entityTypes: ["customer"], timeBudgetMs: null },
        )).rejects.toThrow();
      }
      const healthResponse = await call<{ data: Awaited<ReturnType<typeof getSyncHealth>> }>(
        `${TS_CONSOLE_URL}/connectors/sync-health`,
        { token: await billingSession() },
      );
      expect(healthResponse.status).toBe(200);
      const health = healthResponse.body.data.filter((row) => ids.some((item) => item.id === row.connector_id));
      expect(new Set(health.map((row) => row.last_error)).size).toBe(3);
      expect(health.find((row) => row.connector_type === "stripe")?.last_error).toContain("TEID-65 T7 Stripe");
      expect(health.find((row) => row.connector_type === "csv_import")?.last_error).toContain("TEID-65 T7 CSV");
      expect(health.find((row) => row.connector_type === "csv_mock")?.last_error).toContain("TEID-65 T7 Generic");
    } finally {
      await withTenant(TENANT_ID, async (client) => {
        await client.query("DELETE FROM connectors WHERE id = ANY($1::uuid[])", [ids.map((row) => row.id)]);
      });
    }
  });
});
