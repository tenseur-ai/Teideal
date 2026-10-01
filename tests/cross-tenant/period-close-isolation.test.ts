// TEID-50/TEID-39 cross-tenant regression: the period-close summary and its
// Stripe invoice sync stay inside the caller's tenant. A victim customer id
// is not a handle the attacker can read, sync against, or discover.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;

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
});

afterAll(() => pool.end());

describe("TEID-50/TEID-39 cross-tenant period-close isolation", () => {
  it("GET /period-close-summary never returns a row for another tenant's customer", async () => {
    const url = new URL("/period-close-summary", TS_CONSOLE_URL);
    url.searchParams.set("period", "2026-08");
    url.searchParams.set("limit", "500");
    const response = await call(url.toString(), { token: attackerToken });
    expect(response.status).toBe(200);
    const rows = response.body.data as Array<{ customer_id: string }>;
    expect(rows.some((row) => row.customer_id === fx.tenant2.customerId)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
  });

  it("POST /period-close/:customerId/stripe-sync rejects another tenant's customer id without leaking it", async () => {
    const response = await call(`${TS_CONSOLE_URL}/period-close/${fx.tenant2.customerId}/stripe-sync`, {
      method: "POST",
      token: attackerToken,
      body: { period_start: "2026-08-01T00:00:00Z", period_end: "2026-09-01T00:00:00Z" },
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "customer not found" });
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);

    const victimAttempts = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM period_close_invoice_sync_attempts WHERE customer_id = $1`,
      [fx.tenant2.customerId],
    )).rowCount);
    expect(victimAttempts).toBe(0);

    // Belt-and-braces: even a syntactically-random UUID under the
    // attacker's own tenant must never resolve to the victim's data.
    const randomId = randomUUID();
    const randomResponse = await call(`${TS_CONSOLE_URL}/period-close/${randomId}/stripe-sync`, {
      method: "POST",
      token: attackerToken,
      body: { period_start: "2026-08-01T00:00:00Z", period_end: "2026-09-01T00:00:00Z" },
    });
    expect(randomResponse.status).toBe(404);
    expect(randomResponse.body).toEqual({ error: "customer not found" });
  });
});
