// TEID-91-T4 (Functional): 10 consecutive failed sign-ins lock the account
// for 15 minutes and send a lockout notification email.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser } from "./testUsers.js";
import { withTenant } from "./db.js";

const TENANT1_ID = "00000000-0000-0000-0000-000000001001";

describe("TEID-91-T4: lockout after 10 failed attempts", () => {
  it("locks the account for 15 minutes and queues a lockout email", async () => {
    const user = await createDisposableUser("Support");

    for (let i = 0; i < 10; i++) {
      const res = await call(`${TS_CONSOLE_URL}/auth/login`, {
        method: "POST",
        body: { tenant_key: TENANT_KEY, email: user.email, password: "wrong-password" },
      });
      expect(res.status).toBe(401);
    }

    // Locked now -- even the *correct* password is rejected while locked.
    const afterLockout = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(afterLockout.status).toBe(423);

    const { rows } = await withTenant(TENANT1_ID, (client) =>
      client.query(`SELECT locked_until FROM users WHERE id = $1`, [user.id]),
    );
    const lockedUntil = new Date(rows[0].locked_until).getTime();
    const minutesLocked = (lockedUntil - Date.now()) / 60_000;
    expect(minutesLocked).toBeGreaterThan(13);
    expect(minutesLocked).toBeLessThanOrEqual(15);

    const emails = await withTenant(TENANT1_ID, (client) =>
      client.query(`SELECT to_email, subject FROM notifications_sent WHERE to_email = $1`, [user.email]),
    );
    expect(emails.rows.length).toBeGreaterThan(0);
    expect(emails.rows[0].subject).toMatch(/locked/i);
  });
});
