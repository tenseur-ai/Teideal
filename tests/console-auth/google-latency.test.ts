// TEID-91-T7 (Non-functional): with 500ms of added IdP latency, Google
// sign-in still completes within 2 seconds; with latency beyond that
// budget, it fails cleanly with a timeout message rather than hanging.
import { afterEach, describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser } from "./testUsers.js";
import { mintGoogleIdToken, setFakeGoogleLatency } from "./fakeGoogleClient.js";

afterEach(async () => {
  // The fake IdP is a single shared process across the whole suite --
  // never leave injected latency set for other files' tests.
  await setFakeGoogleLatency(0);
});

describe("TEID-91-T7: Google IdP latency and timeout", () => {
  it("completes within 2 seconds with 500ms of added IdP latency", async () => {
    const user = await createDisposableUser("Support");
    await setFakeGoogleLatency(500);

    const start = Date.now();
    const res = await call(`${TS_CONSOLE_URL}/auth/login/google`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, id_token: await mintGoogleIdToken(user.email, `google-sub-${user.id}`) },
    });
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("authenticated");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("fails with a clear timeout message rather than hanging when the IdP is far slower than the budget", async () => {
    const user = await createDisposableUser("Support");
    await setFakeGoogleLatency(4_000);

    const start = Date.now();
    const res = await call(`${TS_CONSOLE_URL}/auth/login/google`, {
      method: "POST",
      body: { tenant_key: TENANT_KEY, id_token: await mintGoogleIdToken(user.email, `google-sub-${user.id}`) },
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2_500); // well under the injected 4s -- it did not wait for the slow IdP
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });
});
