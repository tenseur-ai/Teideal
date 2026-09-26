// TEID-41-T6 (Non-functional): a blocked cross-tenant attempt shows up in
// the security monitoring dashboard, with tenant_id/endpoint/timestamp,
// within 60 seconds of the attempt.
import { describe, expect, it } from "vitest";
import { loadFixtures, TS_CONSOLE_URL, ADMIN_SECRET } from "./env.js";
import { call } from "./http.js";

describe("TEID-41-T6: blocked attempt appears on the security dashboard within 60s", () => {
  it("a PATCH id-substitution attempt is visible on /admin/security-events within 60 seconds", async () => {
    const fx = loadFixtures();
    const attemptDetail = `latency-probe-${Date.now()}`;

    const attemptedAt = Date.now();
    const attack = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, {
      method: "PATCH",
      apiKey: fx.tenant1.apiKey,
      body: { name: attemptDetail },
    });
    expect(attack.status).toBe(403);

    const dashboard = await call(`${TS_CONSOLE_URL}/admin/security-events`, { adminKey: ADMIN_SECRET });
    expect(dashboard.status).toBe(200);

    const match = dashboard.body.data.find(
      (e: { acting_tenant_id: string; endpoint: string; http_method: string }) =>
        e.acting_tenant_id === fx.tenant1.id && e.endpoint === "/customers/:id" && e.http_method === "PATCH",
    );
    expect(match, "expected the blocked attempt to appear on the dashboard").toBeTruthy();

    const detectedAt = new Date(match.occurred_at).getTime();
    expect(detectedAt - attemptedAt).toBeLessThan(60_000);
  });
});
