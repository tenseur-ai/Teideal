// TEID-16 standing cross-tenant regression: acct_1001 must not read, edit,
// or publish acct_1002's plan, and a create always lands in the caller's tenant.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
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
  victimPlanId = await withTenant(fx.tenant2.id, async (client) => {
    const plan = (await client.query<{ id: string }>(
      `INSERT INTO plans (tenant_id, name, currency, billing_interval, included_credits)
       VALUES ($1, 'Victim-Only-Plan', 'USD', 'monthly', 25)
       RETURNING id`,
      [fx.tenant2.id],
    )).rows[0];
    await client.query(
      `INSERT INTO plan_rates (tenant_id, plan_id, metric, model, rate)
       VALUES ($1, $2, 'victim-only-metric', 'victim-model', 9.99)`,
      [fx.tenant2.id, plan.id],
    );
    return plan.id;
  });
});

afterAll(() => pool.end());

describe("TEID-16 cross-tenant plan isolation", () => {
  it("POST /plans always creates the plan under the authenticated tenant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: attackerToken,
      body: { name: `Attacker-${randomUUID()}`, currency: "USD", billing_interval: "monthly", tenant_id: fx.tenant2.id },
    });
    expect(response.status).toBe(201);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM plans WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM plans WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant2.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
  });

  it("GET /plans excludes the victim plan id", async () => {
    const response = await call(`${TS_CONSOLE_URL}/plans?limit=200`, { token: attackerToken });
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).not.toContain(victimPlanId);
    expect(JSON.stringify(response.body)).not.toContain(victimPlanId);
    expect(JSON.stringify(response.body)).not.toContain("Victim-Only-Plan");
    expect(JSON.stringify(response.body)).not.toContain("victim-only-metric");
  });

  it("GET /plans/:id returns 404 without disclosing a victim plan", async () => {
    const response = await call(`${TS_CONSOLE_URL}/plans/${victimPlanId}`, { token: attackerToken });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(victimPlanId);
    expect(JSON.stringify(response.body)).not.toContain("Victim-Only-Plan");
    expect(JSON.stringify(response.body)).not.toContain("victim-only-metric");
  });

  it("PATCH /plans/:id does not modify another tenant's plan", async () => {
    const response = await call(`${TS_CONSOLE_URL}/plans/${victimPlanId}`, {
      method: "PATCH",
      token: attackerToken,
      body: { name: "Stolen", included_credits: 1 },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(victimPlanId);
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ name: string; included_credits: string }>(
        `SELECT name, included_credits::text AS included_credits FROM plans WHERE id = $1`,
        [victimPlanId],
      )).rows[0],
    );
    expect(row.name).toBe("Victim-Only-Plan");
    expect(Number(row.included_credits)).toBe(25);
  });

  it("POST /plans/:id/publish does not publish another tenant's draft", async () => {
    const response = await call(`${TS_CONSOLE_URL}/plans/${victimPlanId}/publish`, {
      method: "POST",
      token: attackerToken,
      body: {},
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain(victimPlanId);
    expect(JSON.stringify(response.body)).not.toContain("Victim-Only-Plan");
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ status: string; version: number | null }>(
        `SELECT status, version FROM plans WHERE id = $1`,
        [victimPlanId],
      )).rows[0],
    );
    expect(row.status).toBe("draft");
    expect(row.version).toBeNull();
  });
});
