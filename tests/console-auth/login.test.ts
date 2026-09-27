// TEID-91-T1 (Functional): sign in with email/password, and again with
// Google sign-in for the same account.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser } from "./testUsers.js";
import { mintGoogleIdToken } from "./fakeGoogleClient.js";

describe("TEID-91-T1: password and Google sign-in", () => {
  it("signs in with email and password", async () => {
    const user = await createDisposableUser("Support");
    const res = await call(`${TS_CONSOLE_URL}/auth/login`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, email: user.email, password: user.password },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("authenticated");
    expect(typeof res.body.session_token).toBe("string");
  });

  it("also signs in with Google for the same account", async () => {
    const user = await createDisposableUser("Support");
    const idToken = await mintGoogleIdToken(user.email, `google-sub-${user.id}`);

    const res = await call(`${TS_CONSOLE_URL}/auth/login/google`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, id_token: idToken },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("authenticated");
    expect(typeof res.body.session_token).toBe("string");
  });
});
