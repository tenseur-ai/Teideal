// TEID-23 standing cross-tenant regression: version publish, subscription
// assignment, migration scheduling, grandfathering, and the migration preview
// stay inside the caller's tenant.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
const VICTIM_PLAN_NAME = "Victim-Only-Versioned-Plan";
const VICTIM_MOVE_DATE = "2031-05-05T00:00:00Z";
let fx: Fixtures;
let attackerToken: string;
let attackerCustomerId: string;
let attackerFamilyId: string;
let attackerV1Id: string;
let attackerV2Id: string;
let victimCustomerId: string;
let victimFamilyId: string;
let victimV1Id: string;
let victimV2Id: string;

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

async function seedFamily(tenantId: string, name: string): Promise<{ v1Id: string; v2Id: string; familyId: string }> {
  return withTenant(tenantId, async (client) => {
    const v1 = (await client.query<{ id: string; plan_family_id: string }>(
      `INSERT INTO plans (tenant_id, name, currency, billing_interval, included_credits, status, version)
       VALUES ($1, $2, 'USD', 'monthly', 0, 'published', 1)
       RETURNING id, plan_family_id`,
      [tenantId, name],
    )).rows[0];
    const v2 = (await client.query<{ id: string }>(
      `INSERT INTO plans (
         tenant_id, name, currency, billing_interval, included_credits, status, version, plan_family_id
       ) VALUES ($1, $2, 'USD', 'monthly', 0, 'published', 2, $3)
       RETURNING id`,
      [tenantId, name, v1.plan_family_id],
    )).rows[0];
    return { v1Id: v1.id, v2Id: v2.id, familyId: v1.plan_family_id };
  });
}

beforeAll(async () => {
  fx = loadFixtures();
  attackerToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant1.id, ATTACKER_OWNER_ID, createHash("sha256").update(attackerToken).digest("hex")],
  );
  const attackerPlan = await seedFamily(fx.tenant1.id, `Attacker-Versioned-${randomUUID()}`);
  attackerFamilyId = attackerPlan.familyId;
  attackerV1Id = attackerPlan.v1Id;
  attackerV2Id = attackerPlan.v2Id;
  const victimPlan = await seedFamily(fx.tenant2.id, VICTIM_PLAN_NAME);
  victimFamilyId = victimPlan.familyId;
  victimV1Id = victimPlan.v1Id;
  victimV2Id = victimPlan.v2Id;
  attackerCustomerId = await withTenant(fx.tenant1.id, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Attacker Version Customer', $2) RETURNING id`,
      [fx.tenant1.id, `attacker-version-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
  victimCustomerId = await withTenant(fx.tenant2.id, async (client) => {
    const customer = (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Victim Version Customer', $2) RETURNING id`,
      [fx.tenant2.id, `victim-version-${randomUUID()}@example.test`],
    )).rows[0];
    await client.query(
      `INSERT INTO customer_plan_subscriptions (
         tenant_id, customer_id, plan_family_id, current_plan_id, scheduled_plan_id, scheduled_migration_date
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [fx.tenant2.id, customer.id, victimFamilyId, victimV1Id, victimV2Id, VICTIM_MOVE_DATE],
    );
    return customer.id;
  });
  await withTenant(fx.tenant1.id, async (client) => {
    await client.query(
      `INSERT INTO customer_plan_subscriptions (tenant_id, customer_id, plan_family_id, current_plan_id)
       VALUES ($1, $2, $3, $4)`,
      [fx.tenant1.id, attackerCustomerId, attackerFamilyId, attackerV1Id],
    );
  });
});

afterAll(() => pool.end());

describe("TEID-23 cross-tenant plan version isolation", () => {
  it("POST /plans/:planFamilyId/versions writes the caller family and hides the victim family", async () => {
    const stolen = await call(`${TS_CONSOLE_URL}/plans/${victimFamilyId}/versions`, {
      method: "POST",
      token: attackerToken,
      body: { rates: [{ metric: "stolen-metric", rate: 9 }], tenant_id: fx.tenant2.id },
    });
    expect(stolen.status).toBe(404);
    expect(stolen.body).toEqual({ error: "plan not found" });
    expect(JSON.stringify(stolen.body)).not.toContain(victimFamilyId);
    expect(JSON.stringify(stolen.body)).not.toContain(VICTIM_PLAN_NAME);
    const victimVersions = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ version: number }>(
        `SELECT version FROM plans WHERE plan_family_id = $1 ORDER BY version`,
        [victimFamilyId],
      )).rows.map((row) => row.version),
    );
    expect(victimVersions).toEqual([1, 2]);

    const owned = await call(`${TS_CONSOLE_URL}/plans/${attackerFamilyId}/versions`, {
      method: "POST",
      token: attackerToken,
      body: { rates: [{ metric: "attacker-metric", rate: 0.25 }], name: `Attacker-v3-${randomUUID()}` },
    });
    expect(owned.status).toBe(201);
    expect(owned.body.version).toBe(3);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM plans WHERE id = $1 AND tenant_id = $2`,
      [owned.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM plans WHERE id = $1`,
      [owned.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
    expect(JSON.stringify(owned.body)).not.toContain(VICTIM_PLAN_NAME);
    expect(JSON.stringify(owned.body)).not.toContain(victimV2Id);
  });

  it("POST /customers/:id/subscription assigns the caller's customer and rejects the victim", async () => {
    const ownedCustomer = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Attacker Subscribe', $2) RETURNING id`,
        [fx.tenant1.id, `attacker-sub-${randomUUID()}@example.test`],
      )).rows[0].id,
    );
    const owned = await call(`${TS_CONSOLE_URL}/customers/${ownedCustomer}/subscription`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: attackerV1Id, tenant_id: fx.tenant2.id },
    });
    expect(owned.status).toBe(201);
    expect(owned.body.current_plan_id).toBe(attackerV1Id);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customer_plan_subscriptions WHERE customer_id = $1 AND tenant_id = $2`,
      [ownedCustomer, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customer_plan_subscriptions WHERE customer_id = $1`,
      [ownedCustomer],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolenCustomer = await call(`${TS_CONSOLE_URL}/customers/${victimCustomerId}/subscription`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: attackerV1Id },
    });
    expect(stolenCustomer.status).toBe(403);
    expect(stolenCustomer.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolenCustomer.body)).not.toContain(victimCustomerId);
    expect(JSON.stringify(stolenCustomer.body)).not.toContain(VICTIM_PLAN_NAME);

    const stolenPlan = await call(`${TS_CONSOLE_URL}/customers/${ownedCustomer}/subscription`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: victimV1Id },
    });
    expect(stolenPlan.status).toBe(404);
    expect(stolenPlan.body).toEqual({ error: "plan not found" });
    expect(JSON.stringify(stolenPlan.body)).not.toContain(victimV1Id);
    const stillOwnPlan = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query<{ current_plan_id: string }>(
        `SELECT current_plan_id FROM customer_plan_subscriptions WHERE customer_id = $1`,
        [ownedCustomer],
      )).rows[0].current_plan_id,
    );
    expect(stillOwnPlan).toBe(attackerV1Id);
  });

  it("POST /customers/:id/subscription/schedule-migration cannot move another tenant", async () => {
    const stolen = await call(`${TS_CONSOLE_URL}/customers/${victimCustomerId}/subscription/schedule-migration`, {
      method: "POST",
      token: attackerToken,
      body: { target_version: 2, migration_date: "2026-12-01T00:00:00Z" },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(victimCustomerId);
    expect(JSON.stringify(stolen.body)).not.toContain(victimV2Id);
    const victimStill = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ scheduled_plan_id: string; scheduled_migration_date: Date }>(
        `SELECT scheduled_plan_id, scheduled_migration_date
         FROM customer_plan_subscriptions WHERE customer_id = $1`,
        [victimCustomerId],
      )).rows[0],
    );
    expect(victimStill.scheduled_plan_id).toBe(victimV2Id);
    expect(new Date(victimStill.scheduled_migration_date).toISOString()).toBe("2031-05-05T00:00:00.000Z");

    const owned = await call(`${TS_CONSOLE_URL}/customers/${attackerCustomerId}/subscription/schedule-migration`, {
      method: "POST",
      token: attackerToken,
      body: { target_version: 2, migration_date: "2026-12-01T00:00:00Z", tenant_id: fx.tenant2.id },
    });
    expect(owned.status).toBe(200);
    expect(owned.body.scheduled_plan_id).toBe(attackerV2Id);
    expect(JSON.stringify(owned.body)).not.toContain(victimCustomerId);
    expect(JSON.stringify(owned.body)).not.toContain(VICTIM_MOVE_DATE.slice(0, 10));
    const attackerRow = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customer_plan_subscriptions
       WHERE customer_id = $1 AND tenant_id = $2 AND scheduled_plan_id = $3`,
      [attackerCustomerId, fx.tenant1.id, attackerV2Id],
    )).rowCount);
    expect(attackerRow).toBe(1);
  });

  it("POST /customers/:id/subscription/grandfather cannot grandfather another tenant", async () => {
    const stolen = await call(`${TS_CONSOLE_URL}/customers/${victimCustomerId}/subscription/grandfather`, {
      method: "POST",
      token: attackerToken,
      body: { grandfathered: true },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain(victimCustomerId);
    const victimStill = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ grandfathered: boolean; scheduled_plan_id: string }>(
        `SELECT grandfathered, scheduled_plan_id FROM customer_plan_subscriptions WHERE customer_id = $1`,
        [victimCustomerId],
      )).rows[0],
    );
    expect(victimStill.grandfathered).toBe(false);
    expect(victimStill.scheduled_plan_id).toBe(victimV2Id);

    const fresh = await withTenant(fx.tenant1.id, async (client) => {
      const customer = (await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Attacker Grandfather', $2) RETURNING id`,
        [fx.tenant1.id, `attacker-gf-${randomUUID()}@example.test`],
      )).rows[0];
      await client.query(
        `INSERT INTO customer_plan_subscriptions (tenant_id, customer_id, plan_family_id, current_plan_id)
         VALUES ($1, $2, $3, $4)`,
        [fx.tenant1.id, customer.id, attackerFamilyId, attackerV1Id],
      );
      return customer.id;
    });
    const owned = await call(`${TS_CONSOLE_URL}/customers/${fresh}/subscription/grandfather`, {
      method: "POST",
      token: attackerToken,
      body: { grandfathered: true, tenant_id: fx.tenant2.id },
    });
    expect(owned.status).toBe(200);
    expect(owned.body.grandfathered).toBe(true);
    expect(owned.body.scheduled_plan_id).toBeNull();
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customer_plan_subscriptions
       WHERE customer_id = $1 AND tenant_id = $2 AND grandfathered = true`,
      [fresh, fx.tenant1.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(JSON.stringify(owned.body)).not.toContain(victimCustomerId);
  });

  it("GET /plans/:planFamilyId/versions/:version/migration-preview does not disclose the victim count", async () => {
    const stolen = await call(
      `${TS_CONSOLE_URL}/plans/${victimFamilyId}/versions/2/migration-preview`,
      { token: attackerToken },
    );
    expect(stolen.status).toBe(404);
    expect(stolen.body).toEqual({ error: "plan version not found" });
    const stolenBody = JSON.stringify(stolen.body);
    expect(stolenBody).not.toContain(victimFamilyId);
    expect(stolenBody).not.toContain(victimV2Id);
    expect(stolenBody).not.toContain(victimCustomerId);
    expect(stolenBody).not.toContain("2031-05-05");
    expect(stolenBody).not.toContain(VICTIM_PLAN_NAME);

    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: attackerToken,
      body: {
        name: `Preview-${randomUUID()}`,
        currency: "USD",
        billing_interval: "monthly",
        rates: [{ metric: "preview-metric", rate: 0.1 }],
      },
    });
    expect(created.status).toBe(201);
    const published = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}/publish`, {
      method: "POST",
      token: attackerToken,
      body: {},
    });
    expect(published.status).toBe(200);
    const next = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}/versions`, {
      method: "POST",
      token: attackerToken,
      body: { rates: [{ metric: "preview-metric", rate: 0.2 }] },
    });
    expect(next.status).toBe(201);
    const customerId = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, email) VALUES ($1, 'Preview Customer', $2) RETURNING id`,
        [fx.tenant1.id, `preview-${randomUUID()}@example.test`],
      )).rows[0].id,
    );
    const subscribed = await call(`${TS_CONSOLE_URL}/customers/${customerId}/subscription`, {
      method: "POST",
      token: attackerToken,
      body: { plan_id: created.body.id },
    });
    expect(subscribed.status).toBe(201);
    const scheduled = await call(`${TS_CONSOLE_URL}/customers/${customerId}/subscription/schedule-migration`, {
      method: "POST",
      token: attackerToken,
      body: { target_version: 2, migration_date: "2026-08-08T00:00:00Z" },
    });
    expect(scheduled.status).toBe(200);

    const owned = await call(
      `${TS_CONSOLE_URL}/plans/${created.body.id}/versions/2/migration-preview`,
      { token: attackerToken },
    );
    expect(owned.status).toBe(200);
    expect(owned.body).toEqual({
      total: 1,
      by_date: [{ date: "2026-08-08T00:00:00.000Z", count: 1 }],
    });
    const ownedBody = JSON.stringify(owned.body);
    expect(ownedBody).not.toContain(victimCustomerId);
    expect(ownedBody).not.toContain("2031-05-05");
    expect(ownedBody).not.toContain(VICTIM_PLAN_NAME);
  });
});
