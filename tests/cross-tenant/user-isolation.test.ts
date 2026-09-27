// TEID-43 shared-resource regression: the four console user-management
// endpoints must preserve tenant isolation. acct_1001 is the attacker and
// a real acct_1002 user is the victim.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let ownerToken: string;
let victimId: string;
let victimEmail: string;

async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = loadFixtures();
  const plaintext = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant1.id, OWNER_ID, createHash("sha256").update(plaintext).digest("hex")],
  );
  ownerToken = plaintext;
  victimEmail = `victim-${randomUUID()}@acct-1002.test`;
  const victim = await withTenant(fx.tenant2.id, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, 'Support') RETURNING id`,
      [fx.tenant2.id, victimEmail],
    )).rows[0],
  );
  victimId = victim.id;
});

afterAll(async () => { await pool.end(); });

describe("TEID-43 cross-tenant user-management isolation", () => {
  it("GET /users never lists another tenant's users", async () => {
    const response = await call(`${TS_CONSOLE_URL}/users`, { token: ownerToken });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(victimId);
    expect(JSON.stringify(response.body)).not.toContain(victimEmail);
  });

  it("POST /users always creates in the authenticated tenant", async () => {
    const email = `attacker-create-${randomUUID()}@example.test`;
    const response = await call(`${TS_CONSOLE_URL}/users`, {
      method: "POST", token: ownerToken, body: { email, password: "CrossTenantPass123!", role: "Developer" },
    });
    expect(response.status).toBe(201);
    const inAttacker = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant1.id])).rowCount,
    );
    const inVictim = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query(`SELECT id FROM users WHERE email = $1 AND tenant_id = $2`, [email, fx.tenant2.id])).rowCount,
    );
    expect(inAttacker).toBe(1);
    expect(inVictim).toBe(0);
  });

  it("PATCH /users/:id/role rejects another tenant's user id", async () => {
    const response = await call(`${TS_CONSOLE_URL}/users/${victimId}/role`, {
      method: "PATCH", token: ownerToken, body: { role: "Finance" },
    });
    expect(response.status).toBe(403);
    const role = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [victimId])).rows[0].role,
    );
    expect(role).toBe("Support");
  });

  it("DELETE /users/:id rejects another tenant's user id", async () => {
    const response = await call(`${TS_CONSOLE_URL}/users/${victimId}`, { method: "DELETE", token: ownerToken, body: {} });
    expect(response.status).toBe(403);
    const count = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query(`SELECT id FROM users WHERE id = $1`, [victimId])).rowCount,
    );
    expect(count).toBe(1);
  });
});
