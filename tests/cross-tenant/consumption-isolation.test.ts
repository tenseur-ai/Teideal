// TEID-18 standing cross-tenant regression: acct_1001 must not read or change
// acct_1002's consumption order, draws, or timeline, and a write always lands
// in the caller's tenant.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
const VICTIM_UNIT = "VICTIM-CONSUME-UNIT";
let fx: Fixtures;
let attackerToken: string;
let victimConsumptionId: string;
let attackerCustomerId: string;

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
  victimConsumptionId = await withTenant(fx.tenant2.id, async (client) => {
    await client.query(
      `INSERT INTO customer_consumption_overrides (tenant_id, customer_id, consumption_order)
       VALUES ($1, $2, $3::text[])
       ON CONFLICT (customer_id) DO UPDATE SET consumption_order = EXCLUDED.consumption_order`,
      [fx.tenant2.id, fx.tenant2.customerId, ["goodwill", "commit", "paid", "promotional"]],
    );
    const grant = (await client.query<{ id: string }>(
      `INSERT INTO grants (
         tenant_id, customer_id, amount, remaining_amount, unit, source, start_date, expiry_date, status
       ) VALUES ($1, $2, 40, 40, $3, 'paid', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active')
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId, VICTIM_UNIT],
    )).rows[0];
    const consumption = (await client.query<{ id: string }>(
      `INSERT INTO usage_consumptions (tenant_id, customer_id, requested_amount, unit)
       VALUES ($1, $2, 40, $3)
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId, VICTIM_UNIT],
    )).rows[0];
    await client.query(
      `INSERT INTO usage_consumption_lines (tenant_id, consumption_id, grant_id, source_category, amount)
       VALUES ($1, $2, $3, 'paid', 40)`,
      [fx.tenant2.id, consumption.id, grant.id],
    );
    return consumption.id;
  });
  attackerCustomerId = await withTenant(fx.tenant1.id, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Attacker Consume', $2) RETURNING id`,
      [fx.tenant1.id, `attacker-consume-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
});

afterAll(() => pool.end());

describe("TEID-18 cross-tenant consumption isolation", () => {
  it("PUT /customers/:id/consumption-order writes the caller's tenant and rejects the victim", async () => {
    const order = ["commit", "paid", "promotional", "goodwill"];
    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/consumption-order`, {
      method: "PUT",
      token: attackerToken,
      body: { consumption_order: order, tenant_id: fx.tenant2.id },
    });
    expect(owned.status).toBe(200);
    expect(owned.body).toEqual({ consumption_order: order });
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customer_consumption_overrides WHERE customer_id = $1 AND tenant_id = $2`,
      [attackerCustomerId, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customer_consumption_overrides WHERE customer_id = $1`,
      [attackerCustomerId],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolen = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/consumption-order`, {
      method: "PUT",
      token: attackerToken,
      body: { consumption_order: ["paid", "promotional", "commit", "goodwill"] },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(fx.tenant2.customerId);
    const still = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ consumption_order: string[] }>(
        `SELECT consumption_order FROM customer_consumption_overrides WHERE customer_id = $1`,
        [fx.tenant2.customerId],
      )).rows[0],
    );
    expect(still.consumption_order).toEqual(["goodwill", "commit", "paid", "promotional"]);
  });

  it("GET /customers/:id/consumption-order does not disclose the victim override", async () => {
    const response = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/consumption-order`, {
      token: attackerToken,
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
    expect(JSON.stringify(response.body)).not.toContain("goodwill");
  });

  it("POST /customers/:id/consume stays in the caller tenant and does not draw the victim grant", async () => {
    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/consume`, {
      method: "POST",
      token: attackerToken,
      body: { amount: 9, unit: `Attacker-${randomUUID()}`, as_of: "2026-09-27T12:00:00Z", tenant_id: fx.tenant2.id },
    });
    expect(owned.status).toBe(201);
    expect(owned.body.lines).toEqual([
      { grant_id: null, source_category: "overage", amount: 9 },
    ]);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM usage_consumptions WHERE id = $1 AND tenant_id = $2`,
      [owned.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM usage_consumptions WHERE id = $1`,
      [owned.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolen = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/consume`, {
      method: "POST",
      token: attackerToken,
      body: { amount: 10, unit: "credits", as_of: "2026-06-01T00:00:00Z" },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(VICTIM_UNIT);
    expect(JSON.stringify(stolen.body)).not.toContain(victimConsumptionId);
    const remaining = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ remaining_amount: string }>(
        `SELECT MIN(remaining_amount)::text AS remaining_amount FROM grants WHERE unit = $1`,
        [VICTIM_UNIT],
      )).rows[0],
    );
    expect(Number(remaining.remaining_amount)).toBe(40);
  });

  it("GET /customers/:id/consumption-timeline hides the victim event", async () => {
    const stolen = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}/consumption-timeline`, {
      token: attackerToken,
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(victimConsumptionId);
    expect(JSON.stringify(stolen.body)).not.toContain(VICTIM_UNIT);

    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/consumption-timeline`, {
      token: attackerToken,
    });
    expect(owned.status).toBe(200);
    expect(JSON.stringify(owned.body)).not.toContain(victimConsumptionId);
    expect(JSON.stringify(owned.body)).not.toContain(VICTIM_UNIT);
    expect(owned.body.data.length).toBeGreaterThan(0);
  });
});
