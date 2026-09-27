// TEID-17 standing cross-tenant regression: acct_1001 must not read, consume,
// void, or list acct_1002's grants, templates, or ledger entries, and a
// create always lands in the caller's tenant.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
let victimGrantId: string;
let victimLedgerId: string;

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
  const seeded = await withTenant(fx.tenant2.id, async (client) => {
    const grant = (await client.query<{ id: string }>(
      `INSERT INTO grants (
         tenant_id, customer_id, amount, remaining_amount, unit, source, start_date, expiry_date, status
       ) VALUES ($1, $2, 77, 77, 'VICTIMONLY', 'promotional', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'active')
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId],
    )).rows[0];
    const ledger = (await client.query<{ id: string }>(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount, reason)
       VALUES ($1, $2, 'issued', 77, 'victim-only-ledger-reason')
       RETURNING id`,
      [fx.tenant2.id, grant.id],
    )).rows[0];
    await client.query(
      `INSERT INTO recurring_grant_templates (tenant_id, customer_id, amount, unit, source, interval, active)
       VALUES ($1, $2, 5, 'VICTIM-TEMPLATE', 'goodwill', 'monthly', true)`,
      [fx.tenant2.id, fx.tenant2.customerId],
    );
    return { grantId: grant.id, ledgerId: ledger.id };
  });
  victimGrantId = seeded.grantId;
  victimLedgerId = seeded.ledgerId;
});

afterAll(() => pool.end());

describe("TEID-17 cross-tenant grant isolation", () => {
  it("POST /grants always creates the grant under the authenticated tenant", async () => {
    const unit = `Attacker-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/grants`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant1.customerId,
        amount: 12,
        unit,
        source: "paid",
        start_date: "2026-09-01T00:00:00Z",
        tenant_id: fx.tenant2.id,
      },
    });
    expect(response.status).toBe(201);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM grants WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM grants WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant2.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
    expect(response.body.unit).toBe(unit);
  });

  it("POST /grants rejects a customer the caller cannot see", async () => {
    const unit = `Stolen-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/grants`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant2.customerId,
        amount: 12,
        unit,
        source: "paid",
        start_date: "2026-09-01T00:00:00Z",
      },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
    const stored = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query(`SELECT id FROM grants WHERE unit = $1`, [unit])).rowCount,
    );
    const storedHere = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query(`SELECT id FROM grants WHERE unit = $1`, [unit])).rowCount,
    );
    expect(stored).toBe(0);
    expect(storedHere).toBe(0);
  });

  it("GET /grants excludes the victim grant id", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants?limit=200`, { token: attackerToken });
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).not.toContain(victimGrantId);
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    expect(JSON.stringify(response.body)).not.toContain("VICTIMONLY");
    expect(JSON.stringify(response.body)).not.toContain(victimLedgerId);
  });

  it("GET /grants/:id returns 404 without disclosing a victim grant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants/${victimGrantId}`, { token: attackerToken });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "grant not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    expect(JSON.stringify(response.body)).not.toContain("VICTIMONLY");
  });

  it("GET /grants/:id/eligibility returns 404 without disclosing a victim grant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants/${victimGrantId}/eligibility`, { token: attackerToken });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "grant not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    expect(JSON.stringify(response.body)).not.toContain("VICTIMONLY");
  });

  it("POST /grants/:id/consume does not decrement another tenant's grant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants/${victimGrantId}/consume`, {
      method: "POST",
      token: attackerToken,
      body: { amount: 10, as_of: "2026-06-01T00:00:00Z" },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "insufficient balance" });
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ remaining_amount: string; status: string }>(
        `SELECT remaining_amount::text AS remaining_amount, status FROM grants WHERE id = $1`,
        [victimGrantId],
      )).rows[0],
    );
    expect(Number(row.remaining_amount)).toBe(77);
    expect(row.status).toBe("active");
  });

  it("POST /grants/:id/void does not void another tenant's grant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants/${victimGrantId}/void`, {
      method: "POST",
      token: attackerToken,
      body: { reason: "steal the credit" },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "grant is not active (already void or expired, or does not exist for this tenant)",
    });
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ status: string; amount: string }>(
        `SELECT status, amount::text AS amount FROM grants WHERE id = $1`,
        [victimGrantId],
      )).rows[0],
    );
    expect(row.status).toBe("active");
    expect(Number(row.amount)).toBe(77);
  });

  it("POST /grant-templates creates in the caller tenant and rejects a victim customer", async () => {
    const owned = await call(`${TS_CONSOLE_URL}/grant-templates`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant1.customerId,
        amount: 9,
        unit: `Attacker-template-${randomUUID()}`,
        source: "commit",
        interval: "monthly",
        tenant_id: fx.tenant2.id,
      },
    });
    expect(owned.status).toBe(201);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM recurring_grant_templates WHERE id = $1 AND tenant_id = $2`,
      [owned.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM recurring_grant_templates WHERE id = $1`,
      [owned.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);

    const stolen = await call(`${TS_CONSOLE_URL}/grant-templates`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant2.customerId,
        amount: 9,
        unit: "VICTIM-TEMPLATE",
        source: "goodwill",
        interval: "monthly",
      },
    });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stolen.body)).not.toContain("VICTIM-TEMPLATE");
  });

  it("GET /grant-ledger-entries hides the victim entry, including by grant id", async () => {
    const page = await call(`${TS_CONSOLE_URL}/grant-ledger-entries?limit=200`, { token: attackerToken });
    expect(page.status).toBe(200);
    expect(page.body.data.map((row: { id: string }) => row.id)).not.toContain(victimLedgerId);
    expect(JSON.stringify(page.body)).not.toContain(victimLedgerId);
    expect(JSON.stringify(page.body)).not.toContain("victim-only-ledger-reason");
    expect(JSON.stringify(page.body)).not.toContain(victimGrantId);

    const filtered = await call(`${TS_CONSOLE_URL}/grant-ledger-entries?grant_id=${victimGrantId}`, { token: attackerToken });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toEqual([]);
    expect(JSON.stringify(filtered.body)).not.toContain(victimLedgerId);
    expect(JSON.stringify(filtered.body)).not.toContain("victim-only-ledger-reason");
  });
});
