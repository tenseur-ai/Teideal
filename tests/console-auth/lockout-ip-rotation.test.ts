// TEID-91-T8 (Adversarial): the lockout is keyed by account identity, not
// source IP -- rotating the apparent source IP across the 10 attempts must
// not let an attacker dodge it.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser } from "./testUsers.js";

describe("TEID-91-T8: lockout cannot be bypassed by rotating source IP", () => {
  it("still locks after 10 failures spread across 10 distinct X-Forwarded-For values", async () => {
    const user = await createDisposableUser("Support");

    for (let i = 0; i < 10; i++) {
      const res = await call(`${TS_CONSOLE_URL}/auth/login`, {
        method: "POST",
        headers: { "X-Forwarded-For": `203.0.113.${i}` },
        body: { tenant_key: TENANT_KEY, email: user.email, password: "wrong-password" },
      });
      expect(res.status).toBe(401);
    }

    const stillFromANewIp = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      headers: { "X-Forwarded-For": "198.51.100.77" },
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(stillFromANewIp.status).toBe(423);
  });
});
