// TEID-37 cross-tenant regression: every Stripe Connect endpoint stays inside
// the caller's tenant. acct_1001 is the attacker; acct_1002 owns the victim
// connection. A victim connection id is not a handle the attacker can upgrade
// or disconnect, and a victim OAuth state cannot be redeemed by the attacker.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
const VICTIM_ACCOUNT = "acct_victim_isolation";
const FAKE_STRIPE_URL = process.env.FAKE_STRIPE_URL ?? "http://127.0.0.1:8092";

let fx: Fixtures;
let attackerToken: string;
let victimToken: string;
let victimConnectionId: string;

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

function requestWithoutRedirect(target: string): Promise<{ status: number; location: string | null }> {
  const url = new URL(target);
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(url, { method: "GET" }, (res) => {
      res.resume();
      const location = res.headers.location;
      resolve({
        status: res.statusCode ?? 0,
        location: Array.isArray(location) ? location[0] ?? null : location ?? null,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function redeem(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const redirected = await requestWithoutRedirect(authorizeUrl);
  expect(redirected.status).toBe(302);
  const location = new URL(redirected.location!, authorizeUrl);
  return {
    code: location.searchParams.get("code")!,
    state: location.searchParams.get("state")!,
  };
}

function stateTenant(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  const payload = JSON.parse(Buffer.from(state!.split(".")[1], "base64url").toString("utf8")) as { tenantId: string };
  return payload.tenantId;
}

async function fakeLog(): Promise<Array<{ path: string; requestBody: string }>> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_requests`);
  const body = await response.json() as { requests: Array<{ path: string; requestBody: string }> };
  return body.requests;
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
      `INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, 'Owner') RETURNING id`,
      [fx.tenant2.id, `stripe-victim-${randomUUID()}@acct-1002.test`],
    )).rows[0];
    const connection = (await client.query<{ id: string }>(
      `INSERT INTO stripe_connections (
         tenant_id, stripe_account_id, access_token_ciphertext, access_token_iv, access_token_auth_tag,
         scope, status, connected_by_user_id
       ) VALUES ($1, $2, 'ciphertext', 'iv', 'tag', 'read_only', 'connected', $3)
       RETURNING id`,
      [fx.tenant2.id, VICTIM_ACCOUNT, user.id],
    )).rows[0];
    return { userId: user.id, connectionId: connection.id };
  });
  victimConnectionId = victim.connectionId;
  victimToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant2.id, victim.userId, createHash("sha256").update(victimToken).digest("hex")],
  );
});

afterAll(() => pool.end());

describe("TEID-37 cross-tenant Stripe Connect isolation", () => {
  it("GET /stripe/connect/authorize-url binds state to the caller and the callback writes only that tenant", async () => {
    const response = await call(
      `${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=read_only&tenant_id=${fx.tenant2.id}`,
      { token: attackerToken },
    );
    expect(response.status).toBe(200);
    expect(stateTenant(response.body.url)).toBe(fx.tenant1.id);
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.id);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_ACCOUNT);

    const redeemed = await redeem(response.body.url);
    const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
      method: "POST",
      token: attackerToken,
      body: { code: redeemed.code, state: redeemed.state, tenant_id: fx.tenant2.id },
    });
    expect(created.status).toBe(201);
    const inAttacker = await withTenant(fx.tenant1.id, async (client) =>
      (await client.query(
        `SELECT id FROM stripe_connections WHERE id = $1 AND tenant_id = $2`,
        [created.body.id, fx.tenant1.id],
      )).rowCount,
    );
    const inVictim = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query(`SELECT id FROM stripe_connections WHERE id = $1 OR stripe_account_id = $2`, [
        created.body.id,
        created.body.stripe_account_id,
      ])).rowCount,
    );
    expect(inAttacker).toBe(1);
    expect(inVictim).toBe(0);
  });

  it("POST /stripe/connect/callback rejects another tenant's OAuth state and code", async () => {
    const victimCountBefore = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_connections`)).rows[0].n,
    );
    const issued = await call(`${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=read_only`, { token: victimToken });
    expect(issued.status).toBe(200);
    expect(stateTenant(issued.body.url)).toBe(fx.tenant2.id);
    const redeemed = await redeem(issued.body.url);
    const stolen = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
      method: "POST",
      token: attackerToken,
      body: { code: redeemed.code, state: redeemed.state },
    });
    expect(stolen.status).toBe(400);
    expect(JSON.stringify(stolen.body)).not.toContain(victimConnectionId);
    expect(JSON.stringify(stolen.body)).not.toContain(VICTIM_ACCOUNT);
    const victimCountAfter = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_connections`)).rows[0].n,
    );
    expect(victimCountAfter).toBe(victimCountBefore);
  });

  it("POST /stripe/connections/:id/request-write-access does not reveal or upgrade another tenant's connection", async () => {
    const response = await call(`${TS_CONSOLE_URL}/stripe/connections/${victimConnectionId}/request-write-access`, {
      method: "POST",
      token: attackerToken,
      body: {},
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "stripe connection not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimConnectionId);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_ACCOUNT);
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ scope: string; status: string }>(
        `SELECT scope, status FROM stripe_connections WHERE id = $1`,
        [victimConnectionId],
      )).rows[0],
    );
    expect(row).toEqual({ scope: "read_only", status: "connected" });
  });

  it("POST /stripe/connections/:id/disconnect does not revoke another tenant's Stripe connection", async () => {
    const before = await fakeLog();
    const response = await call(`${TS_CONSOLE_URL}/stripe/connections/${victimConnectionId}/disconnect`, {
      method: "POST",
      token: attackerToken,
      body: {},
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "stripe connection not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimConnectionId);
    expect(JSON.stringify(response.body)).not.toContain(VICTIM_ACCOUNT);
    const row = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ status: string; disconnected_at: Date | null }>(
        `SELECT status, disconnected_at FROM stripe_connections WHERE id = $1`,
        [victimConnectionId],
      )).rows[0],
    );
    expect(row.status).toBe("connected");
    expect(row.disconnected_at).toBeNull();
    const fresh = (await fakeLog()).slice(before.length);
    expect(fresh.some((entry) => entry.path === "/oauth/deauthorize" && entry.requestBody.includes(VICTIM_ACCOUNT))).toBe(false);
  });
});
