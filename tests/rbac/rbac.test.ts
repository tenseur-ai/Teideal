import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../services/ts-console/src/server.js";
import { CONSOLE_ROUTE_AUDIT } from "../../services/ts-console/src/lib/roleGuard.js";
import { call } from "./http.js";
import {
  createUser, DATABASE_URL, mintGoogleIdToken, OWNER_ID, ownerSession, passwordSession, TENANT_ID, TS_CONSOLE_URL,
} from "./helpers.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
let ownerToken: string;

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

beforeAll(async () => { ownerToken = await ownerSession(); });
afterAll(async () => { await pool.end(); });

describe("TEID-43 role-based access", () => {
  // TEID-43-T1 (Functional): all five canonical labels can be assigned and
  // are returned by the user-management API.
  it("TEID-43-T1 creates and lists every built-in role with its exact label", async () => {
    const roles = ["Owner", "Billing Admin", "Finance", "Support", "Developer"];
    const created: Array<{ id: string; email: string; role: string }> = [];
    for (const role of roles) {
      const result = await createUser(ownerToken, role, `t1-${role.toLowerCase().replaceAll(" ", "-")}`);
      expect(result.response.status).toBe(201);
      expect(result.response.body.role).toBe(role);
      created.push(result.response.body);
    }
    const list = await call(`${TS_CONSOLE_URL}/users`, { token: ownerToken });
    expect(list.status).toBe(200);
    for (const user of created) {
      expect(list.body.data).toContainEqual(expect.objectContaining({ id: user.id, email: user.email, role: user.role }));
    }
  });

  // TEID-43-T2 (Functional): PATCH /users/:id/role is the specified concrete
  // substitute for the not-yet-built plan-editing screen and endpoint.
  it("TEID-43-T2 denies a Support user access to an Owner-only role change", async () => {
    const support = await createUser(ownerToken, "Support", "t2-support");
    expect(support.response.status).toBe(201);
    const token = await passwordSession(support.email, support.password);
    const denied = await call(`${TS_CONSOLE_URL}/users/${support.response.body.id}/role`, {
      method: "PATCH", token, body: { role: "Finance" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("Owner");
    expect(denied.body.error).toContain("Support");
  });

  // TEID-43-T3 (Functional): the atomic config-change row identifies both
  // the changed user and acting Owner, with old/new roles and timestamp.
  it("TEID-43-T3 audits a Developer-to-Finance role change", async () => {
    const created = await createUser(ownerToken, "Developer", "t3-developer");
    expect(created.response.status).toBe(201);
    const changed = await call(`${TS_CONSOLE_URL}/users/${created.response.body.id}/role`, {
      method: "PATCH", token: ownerToken, body: { role: "Finance" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.role).toBe("Finance");
    const audit = await withTenant(TENANT_ID, async (client) =>
      (await client.query(
        `SELECT object_type, object_id, actor_user_id, before, after, occurred_at
         FROM audit_log WHERE tenant_id = $1 AND object_type = 'User' AND object_id = $2
         AND before = '{"role":"Developer"}'::jsonb AND after = '{"role":"Finance"}'::jsonb`,
        [TENANT_ID, created.response.body.id],
      )).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ object_type: "User", object_id: created.response.body.id, actor_user_id: OWNER_ID });
    expect(new Date(audit[0].occurred_at).getTime()).toBeGreaterThan(0);
  });

  // TEID-43-T4 (Functional): Google is today's SSO implementation; SAML is
  // deliberately absent until phase 2.
  it("TEID-43-T4 toggles Google SSO discovery/enforcement and leaves SAML absent", async () => {
    const googleUser = await createUser(ownerToken, "Support", "t4-google");
    expect(googleUser.response.status).toBe(201);
    const idToken = await mintGoogleIdToken(googleUser.email, `teid-43-${randomUUID()}`);

    const disabled = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
      method: "PATCH", token: ownerToken, body: { sso_enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.sso_enabled).toBe(false);
    const offStatus = await call(`${TS_CONSOLE_URL}/auth/sso-status?tenant_key=acct_1001`);
    expect(offStatus.body).toEqual({ tenant_key: "acct_1001", sso_enabled: false });
    expect(Object.keys(offStatus.body).some((key) => key.toLowerCase().includes("saml"))).toBe(false);
    const blocked = await call(`${TS_CONSOLE_URL}/auth/login/google`, {
      method: "POST", body: { tenant_key: "acct_1001", id_token: idToken },
    });
    expect(blocked).toEqual({ status: 403, body: { error: "single sign-on is disabled for this account" } });

    const enabled = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
      method: "PATCH", token: ownerToken, body: { sso_enabled: true },
    });
    expect(enabled.status).toBe(200);
    const onStatus = await call(`${TS_CONSOLE_URL}/auth/sso-status?tenant_key=acct_1001`);
    expect(onStatus.body).toEqual({ tenant_key: "acct_1001", sso_enabled: true });
    const signedIn = await call(`${TS_CONSOLE_URL}/auth/login/google`, {
      method: "POST", body: { tenant_key: "acct_1001", id_token: idToken },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.status).toBe("authenticated");
    expect((await call(`${TS_CONSOLE_URL}/auth/login/saml`, { method: "POST", body: {} })).status).toBe(404);
  });

  // TEID-43-T5 (Non-functional): this runtime half rejects a declared but
  // empty role annotation. The missing-declaration half is compile-time:
  // consoleRoute requires auth, and the Definition-of-Done tsc run proves it.
  it("TEID-43-T5 records no empty role declaration in the route manifest", async () => {
    CONSOLE_ROUTE_AUDIT.length = 0;
    const app = buildServer();
    await app.ready();
    expect(CONSOLE_ROUTE_AUDIT.length).toBeGreaterThan(0);
    for (const route of CONSOLE_ROUTE_AUDIT) {
      expect("selfService" in route.auth || (Array.isArray(route.auth.role) && route.auth.role.length >= 1)).toBe(true);
    }
    await app.close();
  });

  // TEID-43-T6 (Non-functional): the JSON API substitutes for today's
  // nonexistent console UI and must return a clear, role-specific message.
  it("TEID-43-T6 gives Support a human-readable denial for API-key creation", async () => {
    const token = await passwordSession("support@acmeco.com", "SupportPass123!");
    const denied = await call(`${TS_CONSOLE_URL}/api-keys`, {
      method: "POST", token, body: { scope: "read-only", environment: "sandbox", label: "denied" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/requires role/i);
    expect(denied.body.error).toContain("Developer");
    expect(denied.body.error).toContain("Support");
  });

  // TEID-43-T7 (Adversarial): direct API use cannot bypass route RBAC.
  it("TEID-43-T7 rejects Finance deleting a user and preserves the target", async () => {
    const target = await createUser(ownerToken, "Support", "t7-target");
    expect(target.response.status).toBe(201);
    const financeToken = await passwordSession("finance@acmeco.com", "FinancePass123!");
    const denied = await call(`${TS_CONSOLE_URL}/users/${target.response.body.id}`, { method: "DELETE", token: financeToken });
    expect(denied.status).toBe(403);
    const list = await call(`${TS_CONSOLE_URL}/users`, { token: ownerToken });
    expect(list.body.data.some((user: { id: string }) => user.id === target.response.body.id)).toBe(true);
  });

  // TEID-43-T8 (Adversarial): both write paths validate the canonical list
  // before Postgres can turn an invalid role into a raw constraint error.
  it("TEID-43-T8 rejects SuperOwner on create and update without persisting it", async () => {
    const badEmail = `superowner-${randomUUID()}@example.test`;
    const badCreate = await call(`${TS_CONSOLE_URL}/users`, {
      method: "POST", token: ownerToken, body: { email: badEmail, password: "Pass123!", role: "SuperOwner" },
    });
    expect(badCreate.status).toBe(400);
    for (const role of ["Owner", "Billing Admin", "Finance", "Support", "Developer"]) expect(badCreate.body.error).toContain(role);
    const existing = await createUser(ownerToken, "Developer", "t8-existing");
    expect(existing.response.status).toBe(201);
    const badPatch = await call(`${TS_CONSOLE_URL}/users/${existing.response.body.id}/role`, {
      method: "PATCH", token: ownerToken, body: { role: "SuperOwner" },
    });
    expect(badPatch.status).toBe(400);
    expect(badPatch.body.error).toBe(badCreate.body.error);
    const list = await call(`${TS_CONSOLE_URL}/users`, { token: ownerToken });
    expect(list.body.data.some((user: { email: string }) => user.email === badEmail)).toBe(false);
    expect(list.body.data.find((user: { id: string }) => user.id === existing.response.body.id).role).toBe("Developer");
  });
});
