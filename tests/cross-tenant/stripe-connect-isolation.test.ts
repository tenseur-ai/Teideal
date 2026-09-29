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

describe("TEID-38 cross-tenant Stripe customer isolation", () => {
  let victimCandidateId: string;
  let victimStripeCustomerId: string;

  beforeAll(async () => {
    victimStripeCustomerId = `cus_victim_${randomUUID()}`;
    victimCandidateId = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ id: string }>(
        `INSERT INTO stripe_customer_match_candidates (
           tenant_id, stripe_customer_id, stripe_name, stripe_email, status
         ) VALUES ($1, $2, 'Victim Stripe', $3, 'pending')
         RETURNING id`,
        [fx.tenant2.id, victimStripeCustomerId, `victim-${randomUUID()}@acct-1002.test`],
      )).rows[0].id,
    );
  });

  async function connectAttacker(scope: "read_only" | "read_write") {
    const started = await call(`${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=${scope}`, { token: attackerToken });
    expect(started.status).toBe(200);
    const redeemed = await redeem(started.body.url);
    const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
      method: "POST",
      token: attackerToken,
      body: { code: redeemed.code, state: redeemed.state },
    });
    expect(created.status).toBe(201);
    const log = await fakeLog();
    const hit = [...log].reverse().find((row) =>
      row.path === "/oauth/token" && row.requestBody.includes(`code=${redeemed.code}`) && row.responseStatus === 200,
    );
    expect(hit).toBeTruthy();
    return { created, accessToken: JSON.parse(hit!.responseBody).access_token as string };
  }

  it("POST /stripe/customers/sync writes only the caller's tenant", async () => {
    const before = await withTenant(fx.tenant2.id, async (client) => ({
      links: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_customer_links`)).rows[0].n,
      candidates: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_customer_match_candidates`)).rows[0].n,
    }));
    const { accessToken } = await connectAttacker("read_only");
    const seedId = `cus_attacker_sync_${randomUUID()}`;
    const seeded = await fetch(`${FAKE_STRIPE_URL}/_seed/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: accessToken,
        customers: [{ id: seedId, name: "Attacker Sync", email: `attacker-sync-${randomUUID()}@acct-1001.test` }],
      }),
    });
    expect(seeded.status).toBe(200);

    const response = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, {
      method: "POST",
      token: attackerToken,
      body: { tenant_id: fx.tenant2.id },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(victimCandidateId);
    expect(JSON.stringify(response.body)).not.toContain(victimStripeCustomerId);

    const after = await withTenant(fx.tenant2.id, async (client) => ({
      links: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_customer_links`)).rows[0].n,
      candidates: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_customer_match_candidates`)).rows[0].n,
      victim: (await client.query<{ status: string }>(
        `SELECT status FROM stripe_customer_match_candidates WHERE id = $1`,
        [victimCandidateId],
      )).rows[0],
    }));
    expect(after.links).toBe(before.links);
    expect(after.candidates).toBe(before.candidates);
    expect(after.victim.status).toBe("pending");
  });

  it("GET /stripe/customers/match-candidates does not list another tenant's pending matches", async () => {
    const response = await call(
      `${TS_CONSOLE_URL}/stripe/customers/match-candidates?tenant_id=${fx.tenant2.id}`,
      { token: attackerToken },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(victimCandidateId);
    expect(JSON.stringify(response.body)).not.toContain(victimStripeCustomerId);
    const ids = (response.body.data as Array<{ id: string; stripe_customer_id: string }>).map((row) => row.id);
    expect(ids).not.toContain(victimCandidateId);
  });

  it("POST /stripe/customers/:customerId/link-stripe does not link another tenant's customer", async () => {
    const { accessToken } = await connectAttacker("read_write");
    const stripeId = `cus_attacker_link_${randomUUID()}`;
    const seeded = await fetch(`${FAKE_STRIPE_URL}/_seed/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: accessToken,
        customers: [{ id: stripeId, name: "Attacker Link", email: `attacker-link-${randomUUID()}@acct-1001.test` }],
      }),
    });
    expect(seeded.status).toBe(200);

    const response = await call(`${TS_CONSOLE_URL}/stripe/customers/${fx.tenant2.customerId}/link-stripe`, {
      method: "POST",
      token: attackerToken,
      body: { stripe_customer_id: stripeId },
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "customer not found" });
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant2.customerId);
    expect(JSON.stringify(response.body)).not.toContain(victimStripeCustomerId);

    const victimLinks = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stripe_customer_links WHERE customer_id = $1`,
        [fx.tenant2.customerId],
      )).rows[0].n,
    );
    expect(victimLinks).toBe(0);
  });

  it("POST /stripe/candidates/:id/create-in-teideal does not resolve another tenant's candidate", async () => {
    const response = await call(`${TS_CONSOLE_URL}/stripe/candidates/${victimCandidateId}/create-in-teideal`, {
      method: "POST",
      token: attackerToken,
      body: {},
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "match candidate not found" });
    expect(JSON.stringify(response.body)).not.toContain(victimCandidateId);
    expect(JSON.stringify(response.body)).not.toContain(victimStripeCustomerId);

    const victim = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ status: string; stripe_customer_id: string }>(
        `SELECT status, stripe_customer_id FROM stripe_customer_match_candidates WHERE id = $1`,
        [victimCandidateId],
      )).rows[0],
    );
    expect(victim.status).toBe("pending");
    expect(victim.stripe_customer_id).toBe(victimStripeCustomerId);
    const victimCustomers = await withTenant(fx.tenant2.id, async (client) =>
      (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_customer_links`)).rows[0].n,
    );
    expect(victimCustomers).toBe(0);
  });
});
