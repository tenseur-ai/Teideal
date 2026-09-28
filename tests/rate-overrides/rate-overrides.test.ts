import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { TENANT_ID, opsSession } from "./session.js";

const METRIC = "gpt-4o-mini-tokens";
const OVERRIDE_RATE = 0.0008;
const PLAN_RATE = 0.002;
const START = "2026-10-01T00:00:00Z";
const END = "2026-10-31T23:59:59Z";
const AFTER_END = "2026-11-01T00:00:00Z";
const ACCEPTED_FIELD_NAMES = ["metric", "model", "rate", "start_date", "end_date"] as const;

let opsToken: string;

beforeAll(async () => {
  opsToken = await opsSession();
});
afterAll(() => pool.end());

function instant(value: string): string {
  return new Date(value).toISOString();
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

async function createCustomer(label: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, label, `${label}-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
}

function createPlan(name: string, rates: Array<{ metric: string; model?: string | null; rate: number }>) {
  return call(`${TS_CONSOLE_URL}/plans`, {
    method: "POST",
    token: opsToken,
    body: { name, currency: "USD", billing_interval: "monthly", rates },
  });
}

function createOverride(customerId: string, body: Record<string, unknown>) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/rate-overrides`, {
    method: "POST",
    token: opsToken,
    body,
  });
}

function listOverrides(customerId: string) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/rate-overrides?limit=200`, { token: opsToken });
}

function priceUsage(customerId: string, body: Record<string, unknown>) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/price-usage`, {
    method: "POST",
    token: opsToken,
    body,
  });
}

describe("TEID-20 per-customer rate overrides", () => {
  // TEID-20-T1 (Functional): create an override for ACME-007 on gpt-4o-mini-tokens
  // at 0.0008 with start 2026-10-01 and no end date. It saves, lists, and is
  // the rate resolved on that date.
  it("TEID-20-T1 saves an open-ended override and resolves it as active on the start date", async () => {
    const customerId = await createCustomer("ACME-007");
    const plan = await createPlan(`teid-20-t1-${randomUUID()}`, []);
    expect(plan.status).toBe(201);

    const created = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: START,
    });
    expect(created.status).toBe(201);
    expect(created.body.customer_id).toBe(customerId);
    expect(created.body.metric).toBe(METRIC);
    expect(created.body.model).toBeNull();
    expect(created.body.rate).toBe(OVERRIDE_RATE);
    expect(instant(created.body.start_date)).toBe("2026-10-01T00:00:00.000Z");
    expect(created.body.end_date).toBeNull();

    const listed = await listOverrides(customerId);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(created.body.id);
    const row = (listed.body.data as Array<{ id: string; rate: number; end_date: string | null }>)
      .find((entry) => entry.id === created.body.id);
    expect(row?.rate).toBe(OVERRIDE_RATE);
    expect(row?.end_date).toBeNull();

    const priced = await priceUsage(customerId, {
      plan_id: plan.body.id,
      metric: METRIC,
      quantity: 1000,
      as_of: START,
    });
    expect(priced.status).toBe(201);
    expect(priced.body.rate_applied).toBe(OVERRIDE_RATE);
    expect(priced.body.rate_override_id).toBe(created.body.id);
    expect(priced.body.amount).toBe(0.8);
  });

  // TEID-20-T2 (Functional): an active override of 0.0008 wins over a plan
  // rate of 0.002, and the console docs page states that precedence rule.
  it("TEID-20-T2 prices at the override rate and documents that overrides take precedence", async () => {
    const customerId = await createCustomer("teid-20-t2");
    const plan = await createPlan(`teid-20-t2-${randomUUID()}`, [
      { metric: METRIC, model: null, rate: PLAN_RATE },
    ]);
    expect(plan.status).toBe(201);

    const created = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: "2026-01-01T00:00:00Z",
    });
    expect(created.status).toBe(201);

    const priced = await priceUsage(customerId, {
      plan_id: plan.body.id,
      metric: METRIC,
      quantity: 1000,
      as_of: "2026-10-15T00:00:00Z",
    });
    expect(priced.status).toBe(201);
    expect(priced.body.rate_applied).toBe(OVERRIDE_RATE);
    expect(priced.body.rate_applied).not.toBe(PLAN_RATE);

    const docs = await call(`${TS_CONSOLE_URL}/docs/rate-override-precedence`, { token: opsToken });
    expect(docs.status).toBe(200);
    const rule = String(docs.body.rule);
    expect(rule.toLowerCase()).toContain("override");
    expect(rule.toLowerCase()).toContain("precedence");
    expect(rule).toContain("always takes precedence over the plan rate");
  });

  // TEID-20-T3 (Functional): the priced ledger row records the override id.
  it("TEID-20-T3 records the override id on the priced usage ledger line", async () => {
    const customerId = await createCustomer("teid-20-t3");
    const plan = await createPlan(`teid-20-t3-${randomUUID()}`, [
      { metric: METRIC, model: null, rate: PLAN_RATE },
    ]);
    expect(plan.status).toBe(201);
    const created = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: "2026-01-01T00:00:00Z",
    });
    expect(created.status).toBe(201);

    const priced = await priceUsage(customerId, {
      plan_id: plan.body.id,
      metric: METRIC,
      quantity: 500,
      as_of: "2026-10-15T00:00:00Z",
    });
    expect(priced.status).toBe(201);
    expect(priced.body.rate_override_id).toBe(created.body.id);

    const listed = await listOverrides(customerId);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.id);
    expect(listed.body.data[0].id).toBe(priced.body.rate_override_id);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ rate_override_id: string | null }>(
        `SELECT rate_override_id FROM priced_usage_lines WHERE id = $1`,
        [priced.body.id],
      )).rows[0],
    );
    expect(stored.rate_override_id).toBe(created.body.id);
  });

  // TEID-20-T4 (Functional): after the override's end date, pricing returns
  // to the plan rate with no operator action.
  it("TEID-20-T4 prices at the plan rate after the override end date with no operator action", async () => {
    const customerId = await createCustomer("teid-20-t4");
    const plan = await createPlan(`teid-20-t4-${randomUUID()}`, [
      { metric: METRIC, model: null, rate: PLAN_RATE },
    ]);
    expect(plan.status).toBe(201);
    const created = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: START,
      end_date: END,
    });
    expect(created.status).toBe(201);

    const during = await priceUsage(customerId, {
      plan_id: plan.body.id,
      metric: METRIC,
      quantity: 1000,
      as_of: "2026-10-15T00:00:00Z",
    });
    expect(during.status).toBe(201);
    expect(during.body.rate_applied).toBe(OVERRIDE_RATE);
    expect(during.body.rate_override_id).toBe(created.body.id);

    const after = await priceUsage(customerId, {
      plan_id: plan.body.id,
      metric: METRIC,
      quantity: 1000,
      as_of: AFTER_END,
    });
    expect(after.status).toBe(201);
    expect(after.body.rate_applied).toBe(PLAN_RATE);
    expect(after.body.rate_override_id).toBeNull();
  });

  // TEID-20-T5 (Non-functional): catalog target is +5ms overhead vs no
  // override at 3000 events/sec. CI defaults are RATE_OVERRIDE_LATENCY_SAMPLES=40
  // and RATE_OVERRIDE_LATENCY_BUDGET_MS=50. A dedicated run sets the budget to 5.
  it("TEID-20-T5 keeps override resolution overhead within the latency budget", async () => {
    const samplesN = Number(process.env.RATE_OVERRIDE_LATENCY_SAMPLES ?? 40);
    const budgetMs = Number(process.env.RATE_OVERRIDE_LATENCY_BUDGET_MS ?? 50);
    const metric = `teid-20-t5-${randomUUID()}`;
    const withCustomer = await createCustomer("teid-20-t5-with");
    const withoutCustomer = await createCustomer("teid-20-t5-without");
    const plan = await createPlan(`teid-20-t5-${randomUUID()}`, [
      { metric, model: null, rate: PLAN_RATE },
    ]);
    expect(plan.status).toBe(201);
    const created = await createOverride(withCustomer, {
      metric,
      rate: OVERRIDE_RATE,
      start_date: "2026-01-01T00:00:00Z",
    });
    expect(created.status).toBe(201);

    const timePrice = async (customerId: string) => {
      const started = performance.now();
      const response = await priceUsage(customerId, {
        plan_id: plan.body.id,
        metric,
        quantity: 1,
        as_of: "2026-10-15T00:00:00Z",
      });
      const elapsed = performance.now() - started;
      if (response.status !== 201) {
        throw new Error(`price-usage failed: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return elapsed;
    };

    for (let index = 0; index < 5; index += 1) {
      await timePrice(withCustomer);
      await timePrice(withoutCustomer);
    }

    const withSamples: number[] = [];
    const withoutSamples: number[] = [];
    for (let index = 0; index < samplesN; index += 1) {
      withSamples.push(await timePrice(withCustomer));
      withoutSamples.push(await timePrice(withoutCustomer));
    }

    const mean = (samples: number[]) => samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const meanDelta = mean(withSamples) - mean(withoutSamples);
    const p99Delta = percentile(withSamples, 99) - percentile(withoutSamples, 99);
    expect(meanDelta, `mean overhead was ${meanDelta.toFixed(2)}ms`).toBeLessThanOrEqual(budgetMs);
    expect(p99Delta, `p99 overhead was ${p99Delta.toFixed(2)}ms`).toBeLessThanOrEqual(budgetMs);
  });

  // TEID-20-T6 (Non-functional): 400s name metric, rate, and start_date in
  // plain language. The accepted body field names are the console labels.
  it("TEID-20-T6 names metric, rate, and start_date in plain language on validation errors", async () => {
    const customerId = await createCustomer("teid-20-t6");
    const missingMetric = await createOverride(customerId, {
      rate: OVERRIDE_RATE,
      start_date: START,
    });
    const missingRate = await createOverride(customerId, {
      metric: METRIC,
      start_date: START,
    });
    const missingStart = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
    });
    expect(missingMetric.status).toBe(400);
    expect(missingRate.status).toBe(400);
    expect(missingStart.status).toBe(400);
    expect(String(missingMetric.body.error)).toContain("metric");
    expect(String(missingRate.body.error)).toContain("rate");
    expect(String(missingStart.body.error)).toContain("start_date");
    for (const response of [missingMetric, missingRate, missingStart]) {
      const error = String(response.body.error).toLowerCase();
      expect(error).not.toContain("invalid request");
      expect(error).not.toContain("timestamptz");
      expect(error).not.toContain("numeric");
      expect(error).not.toContain("uuid");
    }
    expect(ACCEPTED_FIELD_NAMES).toEqual(["metric", "model", "rate", "start_date", "end_date"]);
    const listed = await listOverrides(customerId);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  // TEID-20-T7 (Adversarial): overlapping overrides for the same
  // customer/metric/model are rejected; the first row is kept.
  it("TEID-20-T7 rejects a second overlapping override rather than picking one at random", async () => {
    const customerId = await createCustomer("teid-20-t7");
    const first = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: "2026-10-01T00:00:00Z",
      end_date: "2026-11-01T00:00:00Z",
    });
    expect(first.status).toBe(201);

    const second = await createOverride(customerId, {
      metric: METRIC,
      rate: 0.0015,
      start_date: "2026-10-15T00:00:00Z",
      end_date: "2026-12-01T00:00:00Z",
    });
    expect(second.status).toBe(409);
    expect(String(second.body.error).toLowerCase()).toContain("overlap");

    const listed = await listOverrides(customerId);
    expect(listed.status).toBe(200);
    const matching = (listed.body.data as Array<{ metric: string; model: string | null; id: string }>)
      .filter((row) => row.metric === METRIC && row.model === null);
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(first.body.id);
  });

  // TEID-20-T8 (Adversarial): end_date before start_date, and end_date in
  // the past at creation, are both 400 and create no row.
  it("TEID-20-T8 rejects an end_date before start_date and an end_date already in the past", async () => {
    const customerId = await createCustomer("teid-20-t8");
    const before = await listOverrides(customerId);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual([]);

    const inverted = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: "2026-11-01T00:00:00Z",
      end_date: "2026-10-15T00:00:00Z",
    });
    expect(inverted.status).toBe(400);
    expect(String(inverted.body.error)).toContain("end_date");
    expect(String(inverted.body.error)).toContain("start_date");

    const alreadyEnded = await createOverride(customerId, {
      metric: METRIC,
      rate: OVERRIDE_RATE,
      start_date: "2020-01-01T00:00:00Z",
      end_date: "2020-12-31T00:00:00Z",
    });
    expect(alreadyEnded.status).toBe(400);
    expect(String(alreadyEnded.body.error)).toBe("end_date must not be in the past");

    const after = await listOverrides(customerId);
    expect(after.status).toBe(200);
    expect(after.body.data).toEqual([]);
  });
});
