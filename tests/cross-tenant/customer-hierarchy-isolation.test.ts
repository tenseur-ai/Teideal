// TEID-22 standing cross-tenant regression: acct_1001 must not read or move
// acct_1002's organisation tree, and a create always lands in the caller's tenant.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
const VICTIM_NAME = "VICTIM-HIERARCHY-ORG";
const VICTIM_TEAM = "VICTIM-HIERARCHY-TEAM";
let fx: Fixtures;
let attackerToken: string;
let victimOrgId: string;
let victimTeamId: string;

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
    const org = (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email, balance_mode)
       VALUES ($1, $2, $3, 'isolated') RETURNING id`,
      [fx.tenant2.id, VICTIM_NAME, `victim-org-${randomUUID()}@example.test`],
    )).rows[0];
    const team = (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email, parent_customer_id, balance_mode)
       VALUES ($1, $2, $3, $4, 'isolated') RETURNING id`,
      [fx.tenant2.id, VICTIM_TEAM, `victim-team-${randomUUID()}@example.test`, org.id],
    )).rows[0];
    return { orgId: org.id, teamId: team.id };
  });
  victimOrgId = seeded.orgId;
  victimTeamId = seeded.teamId;
});

afterAll(() => pool.end());

describe("TEID-22 cross-tenant customer hierarchy isolation", () => {
  it("POST /organisations writes the caller's tenant and ignores a foreign tenant_id", async () => {
    const name = `Attacker-Org-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/organisations`, {
      method: "POST",
      token: attackerToken,
      body: { name, email: `${name}@example.test`, tenant_id: fx.tenant2.id },
    });
    expect(response.status).toBe(201);
    expect(response.body.parent_customer_id).toBeNull();
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`,
      [response.body.id, fx.tenant1.id],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customers WHERE id = $1`,
      [response.body.id],
    )).rowCount);
    expect(attackerCount).toBe(1);
    expect(victimCount).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_NAME);
    expect(JSON.stringify(response.body)).not.toContain(victimOrgId);
  });

  it("POST /organisations/:id/teams rejects a parent the caller cannot see", async () => {
    const name = `Stolen-Team-${randomUUID()}`;
    const response = await call(`${TS_CONSOLE_URL}/organisations/${victimOrgId}/teams`, {
      method: "POST",
      token: attackerToken,
      body: { name, email: `${name}@example.test`, balance_mode: "pooled" },
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(response.body)).not.toContain(victimOrgId);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_NAME);
    const attackerCount = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM customers WHERE name = $1`,
      [name],
    )).rowCount);
    const victimCount = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customers WHERE name = $1`,
      [name],
    )).rowCount);
    expect(attackerCount).toBe(0);
    expect(victimCount).toBe(0);
  });

  it("GET /organisations/:id/tree does not disclose another tenant's hierarchy", async () => {
    const response = await call(`${TS_CONSOLE_URL}/organisations/${victimOrgId}/tree`, { token: attackerToken });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "customer not found for this tenant" });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(victimOrgId);
    expect(body).not.toContain(victimTeamId);
    expect(body).not.toContain(VICTIM_NAME);
    expect(body).not.toContain(VICTIM_TEAM);
  });

  it("PATCH /organisations/:id/parent rejects a foreign customer and a foreign new parent", async () => {
    const created = await call(`${TS_CONSOLE_URL}/organisations`, {
      method: "POST",
      token: attackerToken,
      body: { name: `Attacker-Move-${randomUUID()}`, email: `move-${randomUUID()}@example.test` },
    });
    expect(created.status).toBe(201);
    const attackerOrgId = created.body.id as string;

    const ontoVictim = await call(`${TS_CONSOLE_URL}/organisations/${attackerOrgId}/parent`, {
      method: "PATCH",
      token: attackerToken,
      body: { new_parent_customer_id: victimOrgId },
    });
    expect(ontoVictim.status).toBe(403);
    expect(ontoVictim.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(ontoVictim.body)).not.toContain(victimOrgId);
    const attackerParent = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query<{ parent_customer_id: string | null }>(
        `SELECT parent_customer_id FROM customers WHERE id = $1`,
        [attackerOrgId],
      )).rows[0].parent_customer_id,
    );
    expect(attackerParent).toBeNull();

    const stealVictim = await call(`${TS_CONSOLE_URL}/organisations/${victimTeamId}/parent`, {
      method: "PATCH",
      token: attackerToken,
      body: { new_parent_customer_id: attackerOrgId },
    });
    expect(stealVictim.status).toBe(403);
    expect(stealVictim.body).toEqual({ error: "customer not found for this tenant" });
    expect(JSON.stringify(stealVictim.body)).not.toContain(victimTeamId);
    const victimParent = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ parent_customer_id: string }>(
        `SELECT parent_customer_id FROM customers WHERE id = $1`,
        [victimTeamId],
      )).rows[0].parent_customer_id,
    );
    expect(victimParent).toBe(victimOrgId);
    const victimMoves = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM customer_hierarchy_moves WHERE customer_id = $1`,
      [victimTeamId],
    )).rowCount);
    expect(victimMoves).toBe(0);
  });
});
