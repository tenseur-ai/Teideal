// TEID-44 standing cross-tenant regression: acct_1001 must not read or
// download acct_1002's export, and its schedule listing must not disclose
// acct_1002's schedule id.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
let victimExportId: string;
let victimScheduleId: string;

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
  const victim = await withTenant(fx.tenant2.id, async (client) => {
    const user = (await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, role)
       VALUES ($1, 'export-owner@acct1002.test', 'Owner')
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = 'Owner'
       RETURNING id`,
      [fx.tenant2.id],
    )).rows[0];
    const exportRow = (await client.query<{ id: string }>(
      `INSERT INTO exports (tenant_id, requested_by_user_id, formats)
       VALUES ($1, $2, ARRAY['csv']) RETURNING id`,
      [fx.tenant2.id, user.id],
    )).rows[0];
    const schedule = (await client.query<{ id: string }>(
      `INSERT INTO export_schedules
         (tenant_id, created_by_user_id, s3_bucket, s3_prefix, s3_region, role_arn)
       VALUES ($1, $2, 'victim-only-bucket', 'private', 'us-east-1',
               'arn:aws:iam::100200100200:role/export')
       RETURNING id`,
      [fx.tenant2.id, user.id],
    )).rows[0];
    return { exportId: exportRow.id, scheduleId: schedule.id };
  });
  victimExportId = victim.exportId;
  victimScheduleId = victim.scheduleId;
});

afterAll(() => pool.end());

describe("TEID-44 cross-tenant export isolation", () => {
  it("POST /exports always creates the export under the authenticated tenant", async () => {
    const response = await call(`${TS_CONSOLE_URL}/exports`, {
      method: "POST",
      token: attackerToken,
      body: { formats: ["csv"] },
    });
    expect(response.status).toBe(202);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM exports WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM exports WHERE id = $1 AND tenant_id = $2`, [response.body.id, fx.tenant2.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
  });

  it("GET /exports/:id returns 403 without disclosing a victim export", async () => {
    const response = await call(`${TS_CONSOLE_URL}/exports/${victimExportId}`, { token: attackerToken });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(victimExportId);
  });

  it("GET /exports/:id/download returns 403 before exposing victim state or bytes", async () => {
    const response = await call(`${TS_CONSOLE_URL}/exports/${victimExportId}/download?format=csv`, { token: attackerToken });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(victimExportId);
  });

  it("GET /export-schedules excludes the victim schedule id", async () => {
    const response = await call(`${TS_CONSOLE_URL}/export-schedules`, { token: attackerToken });
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).not.toContain(victimScheduleId);
    expect(JSON.stringify(response.body)).not.toContain(victimScheduleId);
  });
});
