// TEID-20 cross-tenant regression: rate overrides, priced usage lines, and
// the precedence docs stay inside the caller's tenant. A victim customer id
// is not a handle the attacker can read or price against.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
const VICTIM_METRIC = "victim-only-rate-metric";
let fx: Fixtures;
let attackerToken: string;
let attackerCustomerId: string;
let attackerPlanId: string;
let victimOverrideId: string;
let victimPricedId: string;
let victimPlanId: string;

async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = loadFixtures();
  attackerToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant1.id, ATTACKER_OWNER_ID, createHash("sha256").update(attackerToken).digest("hex")],
  );
  attackerCustomerId = await withTenant(fx.tenant1.id, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Attacker Rate Override', $2) RETURNING id`,
      [fx.tenant1.id, `attacker-rate-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
  attackerPlanId = await withTenant(fx.tenant1.id, async (client) => {
    const plan = (await client.query<{ id: string }>(
      `INSERT INTO plans (tenant_id, name, currency, billing_interval, included_credits)
       VALUES ($1, $2, 'USD', 'monthly', 0)
       RETURNING id`,
      [fx.tenant1.id, `Attacker-Rate-Plan-${randomUUID()}`],
    )).rows[0];
    await client.query(
      `INSERT INTO plan_rates (tenant_id, plan_id, metric, model, rate)
       VALUES ($1, $2, $3, NULL, 0.002)`,
      [fx.tenant1.id, plan.id, VICTIM_METRIC],
    );
    return plan.id;
  });
  const victim = await withTenant(fx.tenant2.id, async (client) => {
    const plan = (await client.query<{ id: string }>(
      `INSERT INTO plans (tenant_id, name, currency, billing_interval, included_credits)
       VALUES ($1, 'Victim-Only-Rate-Plan', 'USD', 'monthly', 0)
       RETURNING id`,
      [fx.tenant2.id],
    )).rows[0];
    await client.query(
      `INSERT INTO plan_rates (tenant_id, plan_id, metric, model, rate)
       VALUES ($1, $2, $3, NULL, 9.99)`,
      [fx.tenant2.id, plan.id, VICTIM_METRIC],
    );
    const override = (await client.query<{ id: string }>(
      `INSERT INTO customer_rate_overrides (
         tenant_id, customer_id, metric, model, rate, start_date, end_date
       ) VALUES ($1, $2, $3, NULL, 0.0001, '2026-01-01T00:00:00Z', NULL)
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId, VICTIM_METRIC],
    )).rows[0];
    const priced = (await client.query<{ id: string }>(
      `INSERT INTO priced_usage_lines (
         tenant_id, customer_id, plan_id, metric, model, quantity, rate_applied, amount, rate_override_id
       ) VALUES ($1, $2, $3, $4, NULL, 10, 0.0001, 0.001, $5)
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId, plan.id, VICTIM_METRIC, override.id],
    )).rows[0];
    return { planId: plan.id, overrideId: override.id, pricedId: priced.id };
  });
  victimPlanId = victim.planId;
  victimOverrideId = victim.overrideId;
  victimPricedId = victim.pricedId;
});

afterAll(() => pool.end());

describe("TEID-20 cross-tenant rate override isolation", () => {
  it("POST /customers/:id/rate-overrides writes the caller's tenant and rejects the victim", async () => {
    const metric = `Attacker-override-${randomUUID()}`;
    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/rate-overrides`, {
      method: "POST",
      token: attackerToken,
      body: {
        metric,
        rate: 0.0008,
        start_date: "2026-10-01T00:00:00Z",
        tenant_id: fx.tenant2.id,
      },
    });
    expect(owned.status).toBe(201);
    expect(owned.body.metric).toBe(metric);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customer_rate_overrides WHERE id = $1 AND tenant_id = $2`,
      [owned.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customer_rate_overrides WHERE id = $1`,
      [owned.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolen = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/rate-overrides`, {
      method: "POST",
      token: attackerToken,
      body: { metric: `Stolen-${randomUUID()}`, rate: 0.5, start_date: "2026-10-01T00:00:00Z" },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(fx.tenant2.customerId);
  });

  it("GET /customers/:id/rate-overrides does not disclose the victim override", async () => {
    const stolen = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/rate-overrides`, {
      token: attackerToken,
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(victimOverrideId);
    expect(JSON.stringify(stolen.body)).not.toContain(VICTIM_METRIC);
    expect(JSON.stringify(stolen.body)).not.toContain(fx.tenant2.customerId);

    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/rate-overrides`, {
      token: attackerToken,
    });
    expect(owned.status).toBe(200);
    expect(JSON.stringify(owned.body)).not.toContain(victimOverrideId);
    expect(JSON.stringify(owned.body)).not.toContain(VICTIM_METRIC);
  });

  it("POST /customers/:id/price-usage stays in the caller tenant and does not use the victim override", async () => {
    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/price-usage`, {
      method: "POST",
      token: attackerToken,
      body: {
        plan_id: attackerPlanId,
        metric: VICTIM_METRIC,
        quantity: 10,
        as_of: "2026-10-15T00:00:00Z",
        tenant_id: fx.tenant2.id,
      },
    });
    expect(owned.status).toBe(201);
    expect(owned.body.rate_applied).toBe(0.002);
    expect(owned.body.rate_override_id).toBeNull();
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM priced_usage_lines WHERE id = $1 AND tenant_id = $2`,
      [owned.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM priced_usage_lines WHERE id = $1`,
      [owned.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolenCustomer = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/price-usage`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: victimPlanId, metric: VICTIM_METRIC, quantity: 10, as_of: "2026-10-15T00:00:00Z" },
    });
    expect(stolenCustomer.status).toBe(403);
    expect(stolenCustomer.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolenCustomer.body)).not.toContain(victimOverrideId);
    expect(JSON.stringify(stolenCustomer.body)).not.toContain(victimPricedId);

    const stolenPlan = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/price-usage`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: victimPlanId, metric: VICTIM_METRIC, quantity: 10, as_of: "2026-10-15T00:00:00Z" },
    });
    expect(stolenPlan.status).toBe(404);
    expect(stolenPlan.body).toEqual({ error: "no rate configured for this metric/model on this plan" });
    expect(JSON.stringify(stolenPlan.body)).not.toContain(victimPlanId);
    expect(JSON.stringify(stolenPlan.body)).not.toContain(victimOverrideId);
  });

  it("GET /docs/rate-override-precedence is static and does not leak victim records", async () => {
    const response = await call(`${TS_CONSOLE_URL}/docs/rate-override-precedence`, { token: attackerToken });
    expect(response.status).toBe(200);
    expect(String(response.body.rule).toLowerCase()).toContain("override");
    expect(JSON.stringify(response.body)).not.toContain(victimOverrideId);
    expect(JSON.stringify(response.body)).not.toContain(victimPricedId);
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_METRIC);
  });
});
