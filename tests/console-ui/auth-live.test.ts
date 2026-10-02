import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";
import { TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { superPool, withTenant } from "./db.js";
import { BILLING, totp } from "./session.js";

describe("TEID-UI-1 live authentication contracts", () => {
  it("TEID-UI-1-T1 completes Billing Admin MFA and reads the signed-in role from /auth/me", async () => {
    const primary = await call<{ status: string; pending_token: string }>(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: "acct_1001", email: BILLING.email, password: BILLING.password },
    });
    expect(primary.status).toBe(200);
    expect(primary.body.status).toBe("mfa_required");
    const verified = await call<{ session_token: string }>(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
      method: "POST",
      body: { pending_token: primary.body.pending_token, totp_code: totp(BILLING.secret, BILLING.email) },
    });
    expect(verified.status).toBe(200);
    const me = await call<{ role: string }>(`${TS_CONSOLE_URL}/auth/me`, { token: verified.body.session_token });
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("Billing Admin");
  });

  it("TEID-UI-1-T2 completes mandatory MFA enrollment from the returned otpauth URI", async () => {
    const id = randomUUID();
    const email = `ui-enroll-${id}@acmeco.com`;
    const password = `Passw0rd!${id.slice(0, 8)}`;
    const hash = await bcrypt.hash(password, 10);
    await withTenant(TENANT_ID, async (client) => {
      await client.query(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4, 'Owner')`, [id, TENANT_ID, email, hash]);
    });
    try {
      const primary = await call<{ status: string; pending_token: string; otpauth_uri: string }>(`${TS_CONSOLE_URL}/auth/login`, {
        method: "POST", body: { tenant_key: "acct_1001", email, password },
      });
      expect(primary.body.status).toBe("mfa_enrollment_required");
      expect(primary.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
      const secret = new URL(primary.body.otpauth_uri).searchParams.get("secret");
      expect(secret).toBeTruthy();
      const confirmed = await call<{ session_token: string }>(`${TS_CONSOLE_URL}/auth/mfa/enroll/confirm`, {
        method: "POST", body: { pending_token: primary.body.pending_token, totp_code: totp(secret!, email) },
      });
      expect(confirmed.status).toBe(200);
      const me = await call<{ role: string }>(`${TS_CONSOLE_URL}/auth/me`, { token: confirmed.body.session_token });
      expect(me.body.role).toBe("Owner");
    } finally {
      await withTenant(TENANT_ID, async (client) => { await client.query("DELETE FROM users WHERE id = $1", [id]); });
    }
  });
});

afterAll(async () => { await superPool.end(); });
