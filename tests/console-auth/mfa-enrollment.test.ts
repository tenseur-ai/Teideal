// TEID-91-T2 (Functional): an Owner turns on "require MFA for all roles",
// then an existing Support-role user with no enrolled MFA is forced into
// authenticator-app enrollment before reaching an authenticated session.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY, OWNER } from "./fixtures.js";
import { call } from "./http.js";
import { fullLogin } from "./fullLogin.js";
import { createDisposableUser } from "./testUsers.js";
import { codeFor } from "./totp.js";

let ownerSession: string;

beforeAll(async () => {
  ownerSession = await fullLogin(OWNER.email, OWNER.password, OWNER.mfaSecret);
  const res = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
    method: "PATCH",
    apiKey: ownerSession,
    body: { require_mfa_all_roles: true },
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  // Restore the default so other test files' assumptions hold regardless
  // of run order.
  await call(`${TS_CONSOLE_URL}/tenant-settings`, {
    method: "PATCH",
    apiKey: ownerSession,
    body: { require_mfa_all_roles: false },
  });
});

describe("TEID-91-T2: mandatory MFA enrollment", () => {
  it("forces a not-yet-enrolled Support user into enrollment before they get a session", async () => {
    const user = await createDisposableUser("Support");

    const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(primary.status).toBe(200);
    expect(primary.body.status).toBe("mfa_enrollment_required");
    expect(typeof primary.body.otpauth_uri).toBe("string");

    const secret = new URL(primary.body.otpauth_uri).searchParams.get("secret");
    expect(secret).toBeTruthy();

    // Enrollment is not optional here -- there is no other way to reach a
    // session for this account while the toggle is on.
    const confirm = await call(`${TS_CONSOLE_URL}/auth/mfa/enroll/confirm`, {
      method: "POST",
      body: { pending_token: primary.body.pending_token, totp_code: codeFor(secret!, user.email) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("authenticated");
    expect(typeof confirm.body.session_token).toBe("string");
  });
});
