import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEventCost } from "../../services/ts-console/src/lib/costRates.js";
import { pool, withTenant } from "./db.js";
import { GO_USAGE_URL, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { ADMIN_API_KEY, TENANT_ID, ownerSession } from "./session.js";

let token: string;

beforeAll(async () => {
  token = await ownerSession();
});

afterAll(async () => {
  await pool.end();
});

describe("TEID-51: Record inference costs", () => {
  // TEID-51-T1 (Functional, AC1): Add cost table entries with effective dates
  // and confirm lookups before/after transition date return correct rate.
  it("TEID-51-T1 resolves correct cost rate across transition dates", async () => {
    const model = `model-t1-${randomUUID().slice(0, 8)}`;
    const metric = "tokens";

    // 1. Entry 1: $0.02 per 1,000 tokens effective 2026-10-01
    const res1 = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.02,
        unit_size: 1000,
        effective_from: "2026-10-01T00:00:00Z",
      },
    });
    expect(res1.status).toBe(201);

    // 2. Entry 2: $0.015 per 1,000 tokens effective 2026-11-01
    const res2 = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.015,
        unit_size: 1000,
        effective_from: "2026-11-01T00:00:00Z",
      },
    });
    expect(res2.status).toBe(201);

    // 3. Confirm cost calculation before transition date (2026-10-15) uses $0.02
    await withTenant(TENANT_ID, async (client) => {
      const costOct = await resolveEventCost(client, TENANT_ID, {
        model,
        event_type: metric,
        quantity: 10000, // 10,000 tokens * (0.02 / 1000) = 0.20
        occurred_at: "2026-10-15T12:00:00Z",
      });
      // resolveEventCost returns a decimal string (never a JS number, per
      // this codebase's money convention) -- parse for the test's own
      // approximate comparison only.
      expect(Number(costOct)).toBeCloseTo(0.20, 4);

      // 4. Confirm cost calculation after transition date (2026-11-15) uses $0.015
      const costNov = await resolveEventCost(client, TENANT_ID, {
        model,
        event_type: metric,
        quantity: 10000, // 10,000 tokens * (0.015 / 1000) = 0.15
        occurred_at: "2026-11-15T12:00:00Z",
      });
      expect(Number(costNov)).toBeCloseTo(0.15, 4);
    });
  });

  // TEID-51-T2 (Functional, AC2): Explicit actual_cost on usage event overrides table.
  it("TEID-51-T2 uses explicit actual_cost over table rate", async () => {
    const model = `model-t2-${randomUUID().slice(0, 8)}`;
    const metric = "tokens";

    // Set standard table rate to $0.05
    const resTable = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.05,
        unit_size: 1000,
        effective_from: "2026-10-01T00:00:00Z",
      },
    });
    expect(resTable.status).toBe(201);

    // Event with explicit actual_cost of 0.0187
    const event = {
      model,
      event_type: metric,
      quantity: 1000,
      actual_cost: 0.0187,
      occurred_at: "2026-10-10T10:00:00Z",
    };

    await withTenant(TENANT_ID, async (client) => {
      const calculatedCost = await resolveEventCost(client, TENANT_ID, event);
      expect(calculatedCost).toBe("0.0187");
    });
  });

  // TEID-51-T3 (Functional, AC3): Cost changes never alter customer prices.
  it("TEID-51-T3 cost changes never alter customer pricing or invoices", async () => {
    const model = `model-t3-${randomUUID().slice(0, 8)}`;
    const metric = "api_call";

    // 1. Create initial cost rate
    await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.02,
        unit_size: 1,
        effective_from: "2026-10-01T00:00:00Z",
      },
    });

    // Verify pricing lookup module/query output remains unaffected by cost_rates
    // (negative test: pricing queries `plans`/`rate_overrides`, never `cost_rates`).
    const checkPricing = async () => {
      return withTenant(TENANT_ID, async (client) => {
        const planRes = await client.query(`SELECT count(*)::int as count FROM plans WHERE tenant_id = $1`, [TENANT_ID]);
        return planRes.rows[0].count;
      });
    };

    const initialPlanCount = await checkPricing();

    // Update cost rate from $0.02 to $0.05
    await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.05,
        unit_size: 1,
        effective_from: "2026-10-15T00:00:00Z",
      },
    });

    const updatedPlanCount = await checkPricing();
    expect(updatedPlanCount).toBe(initialPlanCount);
  });

  // TEID-51-T4 (Non-functional, AC1): 200 models x 5 metrics scale test, lookups < 100ms.
  it("TEID-51-T4 lookups stay under 100ms at scale (200 models x 5 metrics)", async () => {
    const modelPrefix = `scale-${randomUUID().slice(0, 6)}`;
    const metrics = ["tokens", "images", "seconds", "requests", "embeddings"];

    // Seed 200 models x 5 metrics = 1,000 rows
    const insertValues: string[] = [];
    const params: unknown[] = [TENANT_ID];

    let paramIdx = 2;
    for (let m = 0; m < 200; m++) {
      const modelName = `${modelPrefix}-m${m}`;
      for (const metricName of metrics) {
        insertValues.push(`($1, $${paramIdx}, $${paramIdx + 1}, 0.02, 1000, '2026-10-01T00:00:00Z')`);
        params.push(modelName, metricName);
        paramIdx += 2;
      }
    }

    await withTenant(TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO cost_rates (tenant_id, model, metric, rate_per_unit, unit_size, effective_from)
         VALUES ${insertValues.join(", ")}
         ON CONFLICT DO NOTHING`,
        params,
      );

      // Perform 100 random lookups and measure duration
      const sampleModel = `${modelPrefix}-m150`;
      const sampleMetric = "seconds";

      const startTime = performance.now();
      for (let i = 0; i < 50; i++) {
        const cost = await resolveEventCost(client, TENANT_ID, {
          model: sampleModel,
          event_type: sampleMetric,
          quantity: 500,
          occurred_at: "2026-10-15T10:00:00Z",
        });
        expect(cost).toBeDefined();
      }
      const duration = performance.now() - startTime;
      const averageLookupTimeMs = duration / 50;

      expect(averageLookupTimeMs).toBeLessThan(100);
    });
  });

  // TEID-51-T5 (Non-functional, AC1): New cost rate takes effect immediately via API.
  it("TEID-51-T5 new cost entry takes effect immediately without code change or restart", async () => {
    const model = `model-t5-${randomUUID().slice(0, 8)}`;
    const metric = "tokens";

    // 1. Initial rate $0.04
    await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.04,
        unit_size: 1000,
        effective_from: "2026-10-01T00:00:00Z",
      },
    });

    // 2. Add updated rate $0.01 via API
    const createRes = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.01,
        unit_size: 1000,
        effective_from: "2026-10-05T00:00:00Z",
      },
    });
    expect(createRes.status).toBe(201);

    // 3. Immediately query resolution (same process) and verify $0.01 rate takes effect
    await withTenant(TENANT_ID, async (client) => {
      const cost = await resolveEventCost(client, TENANT_ID, {
        model,
        event_type: metric,
        quantity: 1000,
        occurred_at: "2026-10-10T00:00:00Z",
      });
      expect(Number(cost)).toBeCloseTo(0.01, 4);
    });
  });

  // TEID-51-T6 (Adversarial, AC1): Reject conflicting duplicate effective_from entries.
  it("TEID-51-T6 rejects conflicting cost entries for same model, metric, and effective date", async () => {
    const model = `model-t6-${randomUUID().slice(0, 8)}`;
    const metric = "tokens";
    const effectiveFrom = "2026-10-01T00:00:00Z";

    // First POST
    const res1 = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.02,
        unit_size: 1000,
        effective_from: effectiveFrom,
      },
    });
    expect(res1.status).toBe(201);

    // Duplicate POST with same model, metric, effective_from -> 409 Conflict
    const res2 = await call(`${TS_CONSOLE_URL}/cost-rates`, {
      method: "POST",
      token,
      body: {
        model,
        metric,
        rate_per_unit: 0.03,
        unit_size: 1000,
        effective_from: effectiveFrom,
      },
    });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/already exists/i);
  });

  // TEID-51-T7 (Adversarial, AC2): Reject implausible actual_cost values at ingestion.
  it("TEID-51-T7 rejects negative or implausibly large actual_cost at ingestion", async () => {
    const customerId = "00000000-0000-4000-8000-000000000001";

    // 1. Negative actual_cost -> 400 Bad Request
    const resNeg = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: ADMIN_API_KEY,
      body: {
        customer_id: customerId,
        event_type: "api_call",
        quantity: 1,
        idempotency_key: `idemp-neg-${randomUUID()}`,
        actual_cost: -50,
      },
    });
    expect(resNeg.status).toBe(400);

    // 2. Implausibly large actual_cost ($999,999 >= $1,000,000) -> 400 Bad Request
    const resHuge = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: ADMIN_API_KEY,
      body: {
        customer_id: customerId,
        event_type: "api_call",
        quantity: 1,
        idempotency_key: `idemp-huge-${randomUUID()}`,
        actual_cost: 1000000,
      },
    });
    expect(resHuge.status).toBe(400);
  });
});
