// TEID-19 cross-tenant regression: commit fields, amend, and the new ledger
// filters stay inside the caller's tenant. A victim commit id is not a
// handle the attacker can read or change.
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
         tenant_id, customer_id, amount, remaining_amount, unit, source, start_date, expiry_date,
         status, drawdown_schedule, overage_rate, carries_over
       ) VALUES (
         $1, $2, 250000, 250000, 'VICTIM-COMMIT', 'commit',
         '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', 'active', 'upfront', 0.0025, false
       )
       RETURNING id`,
      [fx.tenant2.id, fx.tenant2.customerId],
    )).rows[0];
    const ledger = (await client.query<{ id: string }>(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount, reason)
       VALUES ($1, $2, 'issued', 250000, 'victim-commit-ledger')
       RETURNING id`,
      [fx.tenant2.id, grant.id],
    )).rows[0];
    return { grantId: grant.id, ledgerId: ledger.id };
  });
  victimGrantId = seeded.grantId;
  victimLedgerId = seeded.ledgerId;
});

afterAll(() => pool.end());

describe("TEID-19 cross-tenant commit isolation", () => {
  it("POST /grants with commit fields creates the commit in the caller's tenant", async () => {
    const unit = `Attacker-commit-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/grants`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant1.customerId,
        amount: 1200,
        unit,
        source: "commit",
        start_date: "2026-01-01T00:00:00Z",
        expiry_date: "2026-12-31T23:59:59Z",
        drawdown_schedule: "upfront",
        overage_rate: 0.0025,
        carries_over: false,
        tenant_id: fx.tenant2.id,
      },
    });
    expect(response.status).toBe(201);
    expect(response.body.drawdown_schedule).toBe("upfront");
    expect(response.body.overage_rate).toBe(0.0025);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM grants WHERE id = $1 AND tenant_id = $2 AND drawdown_schedule = 'upfront'`,
      [response.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM grants WHERE id = $1`,
      [response.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
  });

  it("POST /grants rejects a victim customer even when the body is a commit", async () => {
    const unit = `Stolen-commit-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/grants`, {
      method: "POST",
      token: attackerToken,
      body: {
        customer_id: fx.tenant2.customerId,
        amount: 1200,
        unit,
        source: "commit",
        start_date: "2026-01-01T00:00:00Z",
        drawdown_schedule: "upfront",
        overage_rate: 0.0025,
      },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
    const stored = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query(`SELECT id FROM grants WHERE unit = $1`, [unit])).rowCount,
    );
    expect(stored).toBe(0);
  });

  it("PATCH /grants/:id/amend does not change another tenant's commit", async () => {
    const response = await call(`${TS_CONSOLE_URL}/grants/${victimGrantId}/amend`, {
      method: "PATCH",
      token: attackerToken,
      body: { reason: "steal the rate", overage_rate: 9 },
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "grant not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimGrantId);
    expect(JSON.stringify(response.body)).not.toContain("VICTIM-COMMIT");
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ overage_rate: string; status: string }>(
        `SELECT overage_rate::text AS overage_rate, status FROM grants WHERE id = $1`,
        [victimGrantId],
      )).rows[0],
    );
    expect(Number(row.overage_rate)).toBe(0.0025);
    expect(row.status).toBe("active");
  });

  it("GET /grant-ledger-entries filters do not reveal the victim commit", async () => {
    const filtered = await call(
      `${TS_CONSOLE_URL}/grant-ledger-entries?entry_type=issued&source=commit&limit=200`,
      { token: attackerToken },
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.map((row: { id: string }) => row.id)).not.toContain(victimLedgerId);
    expect(JSON.stringify(filtered.body)).not.toContain(victimLedgerId);
    expect(JSON.stringify(filtered.body)).not.toContain(victimGrantId);
    expect(JSON.stringify(filtered.body)).not.toContain("victim-commit-ledger");
    expect(JSON.stringify(filtered.body)).not.toContain("VICTIM-COMMIT");

    const byGrant = await call(
      `${TS_CONSOLE_URL}/grant-ledger-entries?grant_id=${victimGrantId}&entry_type=issued&source=commit`,
      { token: attackerToken },
    );
    expect(byGrant.status).toBe(200);
    expect(byGrant.body.data).toEqual([]);
  });
});
