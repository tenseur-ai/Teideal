// TEID-91-T3 (Functional): idle sessions expire after the tenant's idle
// timeout (default 8 hours); an Owner can shorten it, and that takes
// effect immediately for new sessions.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY, OWNER } from "./fixtures.js";
import { call } from "./http.js";
import { fullLogin } from "./fullLogin.js";
import { createDisposableUser } from "./testUsers.js";
import { pool } from "./db.js";

let ownerSession: string;

beforeAll(async () => {
  ownerSession = await fullLogin(OWNER.email, OWNER.password, OWNER.mfaSecret);
  // Every settings-dependent test sets its own starting state rather than
  // trusting another file's cleanup to have already run.
  const reset = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
    method: "PATCH",
    apiKey: ownerSession,
    body: { require_mfa_all_roles: false, idle_timeout_minutes: 480 },
  });
  expect(reset.status).toBe(200);
});

afterAll(async () => {
  await call(`${TS_CONSOLE_URL}/tenant-settings`, {
    method: "PATCH",
    apiKey: ownerSession,
    body: { idle_timeout_minutes: 480 },
  });
});

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("TEID-91-T3: idle session expiry and Owner-configurable timeout", () => {
  it("an idle session past the timeout requires re-authentication for the next action", async () => {
    const user = await createDisposableUser("Finance");
    const login = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(login.body.status).toBe("authenticated");
    const sessionToken: string = login.body.session_token;

    // Backdate last_seen_at past the default 8-hour idle window instead of
    // waiting 8 real hours.
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '8 hours 1 minute' WHERE token_hash = $1`, [
      tokenHash(sessionToken),
    ]);

    const nextAction = await call(`${TS_CONSOLE_URL}/auth/logout`, { method: "POST", apiKey: sessionToken });
    expect(nextAction.status).toBe(401);
  });

  it("an Owner shortening the idle timeout applies immediately to new sessions", async () => {
    const patch = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
      method: "PATCH",
      apiKey: ownerSession,
      body: { idle_timeout_minutes: 30 },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.idle_timeout_minutes).toBe(30);

    const user = await createDisposableUser("Finance");
    const login = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(login.body.status).toBe("authenticated");

    const { rows } = await pool.query<{ idle_timeout_minutes: number }>(
      `SELECT idle_timeout_minutes FROM sessions WHERE token_hash = $1`,
      [tokenHash(login.body.session_token)],
    );
    expect(rows[0].idle_timeout_minutes).toBe(30);
  });
});
