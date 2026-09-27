// TEID-91-T5 (Functional): a successful sign-in, a failed sign-in, an MFA
// method change and an account lockout for the same user all appear in
// the audit log with the right event type and timestamp.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser, enrollMfaDirectly } from "./testUsers.js";
import { codeFor } from "./totp.js";
import { withTenant } from "./db.js";

const TENANT1_ID = "00000000-0000-0000-0000-000000001001";
const SECRET_A = "MFRGGZDFMZTWQ2LK";
const SECRET_B = "ONXW2ZLUEBUXA43P";

describe("TEID-91-T5: audit log covers sign-in, failure, MFA change and lockout", () => {
  it("records all four event types for the same user with sane timestamps", async () => {
    const user = await createDisposableUser("Support");

    // 1. successful sign-in
    const login = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(login.body.status).toBe("authenticated");
    const sessionToken: string = login.body.session_token;

    // 2. MFA method change, using the still-valid session from step 1 (an
    // account lockout later must not need to invalidate it).
    await enrollMfaDirectly(user.id, SECRET_A);
    const reset = await call(`${TS_CONSOLE_URL}/auth/mfa/reset`, {
      method: "POST",
      apiKey: sessionToken,
      body: { totp_code: codeFor(SECRET_A, user.email) },
    });
    expect(reset.status).toBe(200);
    const newSecret = new URL(reset.body.otpauth_uri).searchParams.get("secret")!;
    const confirm = await call(`${TS_CONSOLE_URL}/auth/mfa/reset/confirm`, {
      method: "POST",
      apiKey: sessionToken,
      body: { totp_code: codeFor(newSecret, user.email) },
    });
    expect(confirm.status).toBe(200);

    // 3 & 4. a failed sign-in, then enough more to trigger a lockout.
    for (let i = 0; i < 10; i++) {
      await call(`${TS_CONSOLE_URL}/auth/login`, {
        method: "POST",
        body: { tenant_key: TENANT_KEY, email: user.email, password: "wrong-password" },
      });
    }

    const { rows } = await withTenant(TENANT1_ID, (client) =>
      client.query(`SELECT event_type, occurred_at FROM audit_log WHERE actor_user_id = $1 ORDER BY occurred_at`, [user.id]),
    );
    const types = new Set(rows.map((r: { event_type: string }) => r.event_type));
    expect(types).toContain("sign_in_success");
    expect(types).toContain("sign_in_failed");
    expect(types).toContain("mfa_method_changed");
    expect(types).toContain("account_locked");

    for (const row of rows) {
      expect(new Date(row.occurred_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    }
  });
});
