// TEID-51 cross-tenant regression: cost rates stay inside the caller's
// tenant. There is no customer-id-style handle to substitute here (the API
// is tenant-scoped only) -- the attack surface is purely "does GET ever
// leak another tenant's rate."
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
let victimModel: string;

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
  victimModel = `victim-only-model-${randomUUID()}`;
  await withTenant(fx.tenant2.id, async (client) => {
    await client.query(
      `INSERT INTO cost_rates (tenant_id, model, metric, rate_per_unit, unit_size, effective_from)
       VALUES ($1, $2, 'tokens', 0.05, 1000, '2026-10-01T00:00:00Z')`,
      [fx.tenant2.id, victimModel],
    );
  });
});

afterAll(() => pool.end());

describe("TEID-51 cross-tenant cost-rate isolation", () => {
  it("GET /cost-rates never returns another tenant's rate", async () => {
    const response = await call(`${TS_CONSOLE_URL}/cost-rates`, { token: attackerToken });
    expect(response.status).toBe(200);
    const rows = response.body.data as Array<{ model: string }>;
    expect(rows.some((row) => row.model === victimModel)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(victimModel);
  });

  it("GET /cost-rates?model=<victim model> returns nothing for the attacker", async () => {
    const url = new URL("/cost-rates", TS_CONSOLE_URL);
    url.searchParams.set("model", victimModel);
    const response = await call(url.toString(), { token: attackerToken });
    expect(response.status).toBe(200);
    expect((response.body.data as unknown[]).length).toBe(0);
  });
});
