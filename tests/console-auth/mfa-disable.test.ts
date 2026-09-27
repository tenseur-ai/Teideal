// TEID-91-T9 (Adversarial): disabling MFA on an Owner account must be
// rejected outright (mandatory role); disabling it on any account without
// a fresh MFA step-up code -- a session established with only a password
// is not enough -- must also be rejected.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { OWNER } from "./fixtures.js";
import { call } from "./http.js";
import { fullLogin } from "./fullLogin.js";
import { createDisposableUser, enrollMfaDirectly } from "./testUsers.js";
import { codeFor } from "./totp.js";

const SUPPORT_MFA_SECRET = "NBSWY3DPO5XA4LTM";

describe("TEID-91-T9: disabling MFA requires step-up and is blocked for mandatory roles", () => {
  it("rejects disabling MFA on an Owner account even with a valid step-up code", async () => {
    const session = await fullLogin(OWNER.email, OWNER.password, OWNER.mfaSecret);
    const res = await call(`${TS_CONSOLE_URL}/auth/mfa/disable`, {
      method: "POST",
      apiKey: session,
      body: { totp_code: codeFor(OWNER.mfaSecret, OWNER.email) },
    });
    expect(res.status).toBe(403);
  });

  it("rejects disabling MFA on a non-mandatory-role account with no step-up code", async () => {
    const user = await createDisposableUser("Support");
    await enrollMfaDirectly(user.id, SUPPORT_MFA_SECRET);
    const session = await fullLogin(user.email, user.password, SUPPORT_MFA_SECRET);

    const noStepUp = await call(`${TS_CONSOLE_URL}/auth/mfa/disable`, {
      method: "POST",
      apiKey: session,
      body: {},
    });
    expect(noStepUp.status).toBe(401);

    // Confirms the endpoint itself works and the prior rejection really was
    // about the missing step-up, not something else being broken.
    const withStepUp = await call(`${TS_CONSOLE_URL}/auth/mfa/disable`, {
      method: "POST",
      apiKey: session,
      body: { totp_code: codeFor(SUPPORT_MFA_SECRET, user.email) },
    });
    expect(withStepUp.status).toBe(200);
  });
});
