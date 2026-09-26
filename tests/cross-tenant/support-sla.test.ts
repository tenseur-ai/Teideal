// TEID-41-T4 (Functional): requesting the isolation design doc through the
// support portal (here, its self-serve endpoint) delivers a real
// architecture description, within the documented SLA.
import { describe, expect, it } from "vitest";
import { loadFixtures, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

describe("TEID-41-T4: isolation design doc request", () => {
  it("acct_1001 receives the isolation design document within the documented SLA", async () => {
    const fx = loadFixtures();
    const requestedAt = Date.now();

    const res = await call(`${TS_CONSOLE_URL}/support/isolation-design-doc`, { apiKey: fx.tenant1.apiKey });

    expect(res.status).toBe(200);
    expect(res.body.requested_by_tenant).toBe("acct_1001");
    expect(typeof res.body.sla).toBe("string");
    expect(res.body.sla.length).toBeGreaterThan(0);
    expect(res.body.document).toContain("row-level security");
    expect(res.body.document).toContain("FORCE ROW LEVEL SECURITY");

    const deliveredAt = new Date(res.body.delivered_at).getTime();
    expect(deliveredAt - requestedAt).toBeLessThan(5_000); // instant, self-serve delivery
  });
});
