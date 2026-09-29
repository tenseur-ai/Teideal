import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { GO_USAGE_URL, loadFixtures, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;

beforeAll(() => {
  fx = loadFixtures();
});

function utc(value: string): string {
  return new Date(value).toISOString();
}

async function putConfig(timezone: string, anchorDay: number) {
  return call(`${GO_USAGE_URL}/customers/${fx.tenant2.customerId}/billing-config`, {
    method: "PUT",
    apiKey: fx.tenant2.apiKey,
    body: { billing_timezone: timezone, billing_anchor_day: anchorDay },
  });
}

async function resolve(instant: string) {
  return call(`${GO_USAGE_URL}/period/resolve`, {
    method: "POST",
    apiKey: fx.tenant2.apiKey,
    body: { customer_id: fx.tenant2.customerId, instant },
  });
}

describe("TEID-96 billing periods, time zones, and boundary rules", () => {
  it("TEID-96-T1: stores an explicit local event timestamp as the exact UTC instant", async () => {
    const idempotencyKey = `teid-96-t1-${randomUUID()}`;
    const created = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body: {
        customer_id: fx.tenant2.customerId,
        event_type: "billing_timestamp",
        quantity: 1.25,
        idempotency_key: idempotencyKey,
        // A date safely in the future (TEID-34 now queues an event whose
        // billing period has already closed relative to real time instead
        // of inserting it directly -- this test is exercising offset
        // arithmetic, not period-closing behavior, so it needs a date
        // that stays in an open period for as long as this suite exists).
        occurred_at: "2030-03-10T02:30:00-05:00",
      },
    });

    expect(created.status).toBe(201);
    expect(utc(created.body.occurred_at)).toBe("2030-03-10T07:30:00.000Z");
    expect(String(created.body.quantity)).toBe("1.25");

    const listed = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant2.customerId}`, {
      apiKey: fx.tenant2.apiKey,
    });
    expect(listed.status).toBe(200);
    const stored = listed.body.data.find((event: { idempotency_key: string }) => event.idempotency_key === idempotencyKey);
    expect(stored).toBeDefined();
    expect(utc(stored.occurred_at)).toBe("2030-03-10T07:30:00.000Z");

    const offsetless = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body: {
        customer_id: fx.tenant2.customerId,
        event_type: "offsetless_rejected",
        quantity: 1,
        idempotency_key: `teid-96-offsetless-${randomUUID()}`,
        occurred_at: "2026-03-10T02:30:00",
      },
    });
    expect(offsetless.status).toBe(400);
    expect(offsetless.body.error).toContain("explicit UTC offset or Z");

    const batchOffsetless = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body: [{
        customer_id: fx.tenant2.customerId,
        event_type: "batch_offsetless_rejected",
        quantity: 1,
        idempotency_key: `teid-96-batch-offsetless-${randomUUID()}`,
        occurred_at: "2026-03-10T02:30:00",
      }],
    });
    expect(batchOffsetless.status).toBe(207);
    expect(batchOffsetless.body.results[0]).toEqual({
      status: "error",
      reason: "occurred_at must be an RFC3339 timestamp with an explicit UTC offset or Z",
    });
  });

  it("TEID-96-T2: uses each New York boundary's DST-aware UTC offset", async () => {
    const defaults = await call(`${GO_USAGE_URL}/customers/${fx.tenant2.customerId}/billing-config`, {
      apiKey: fx.tenant2.apiKey,
    });
    expect(defaults.status).toBe(200);
    expect(defaults.body.customer_id).toBe(fx.tenant2.customerId);
    expect(defaults.body.billing_timezone).toBe("UTC");
    expect(defaults.body.billing_anchor_day).toBe(1);

    const configured = await call(`${GO_USAGE_URL}/customers/${fx.tenant2.customerId}/billing-config`, {
      method: "PUT",
      apiKey: fx.tenant2.apiKey,
      body: { billing_timezone: "America/New_York" },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.billing_timezone).toBe("America/New_York");

    const period = await resolve("2026-11-15T12:00:00Z");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2026-11-01T04:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2026-12-01T05:00:00.000Z");
  });

  it("TEID-96-T3: assigns an instant exactly on a local boundary to the new period", async () => {
    expect((await putConfig("America/New_York", 1)).status).toBe(200);

    const period = await resolve("2026-04-01T00:00:00-04:00");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2026-04-01T04:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2026-05-01T04:00:00.000Z");
    expect(period.body.in_new_period_as_of_boundary).toBe(true);
  });

  it("TEID-96-T4: clamps anchor day 31 to each month's actual last day", async () => {
    expect((await putConfig("UTC", 31)).status).toBe(200);

    const february = await resolve("2026-02-15T12:00:00Z");
    expect(february.status).toBe(200);
    expect(utc(february.body.period_start)).toBe("2026-01-31T00:00:00.000Z");
    expect(utc(february.body.period_end)).toBe("2026-02-28T00:00:00.000Z");

    const april = await resolve("2026-04-15T12:00:00Z");
    expect(april.status).toBe(200);
    expect(utc(april.body.period_start)).toBe("2026-03-31T00:00:00.000Z");
    expect(utc(april.body.period_end)).toBe("2026-04-30T00:00:00.000Z");

    const leapFebruary = await resolve("2024-02-15T12:00:00Z");
    expect(leapFebruary.status).toBe(200);
    expect(utc(leapFebruary.body.period_end)).toBe("2024-02-29T00:00:00.000Z");
  });

  it("TEID-96-T5: DST spring-forward gap assigns the explicit-offset probe without error", async () => {
    expect((await putConfig("America/New_York", 1)).status).toBe(200);

    const period = await resolve("2026-03-08T02:30:00-05:00");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2026-03-01T05:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2026-04-01T04:00:00.000Z");
  });

  it("TEID-96-T5: DST fall-back overlap assigns the first repeated New York hour", async () => {
    expect((await putConfig("America/New_York", 1)).status).toBe(200);

    const period = await resolve("2026-11-01T01:30:00-04:00");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2026-11-01T04:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2026-12-01T05:00:00.000Z");
  });

  it("TEID-96-T5: December 31 to January 1 assigns the exact year boundary to January", async () => {
    expect((await putConfig("UTC", 1)).status).toBe(200);

    const period = await resolve("2027-01-01T00:00:00Z");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2027-01-01T00:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2027-02-01T00:00:00.000Z");
  });

  it("TEID-96-T5: February 29 assigns the clamped leap-year boundary to the new period", async () => {
    expect((await putConfig("UTC", 31)).status).toBe(200);

    const period = await resolve("2024-02-29T00:00:00Z");
    expect(period.status).toBe(200);
    expect(utc(period.body.period_start)).toBe("2024-02-29T00:00:00.000Z");
    expect(utc(period.body.period_end)).toBe("2024-03-31T00:00:00.000Z");
  });

  it("TEID-96-T6: CI runs four individually named boundary-regression cases", () => {
    const testFile = fileURLToPath(import.meta.url);
    const source = readFileSync(testFile, "utf8");
    const expectedNames = [
      "TEID-96-T5: DST spring-forward gap",
      "TEID-96-T5: DST fall-back overlap",
      "TEID-96-T5: December 31 to January 1",
      "TEID-96-T5: February 29",
    ];
    for (const name of expectedNames) {
      expect(source).toContain(`it(\"${name}`);
    }
    expect(source.match(/it\(\"TEID-96-T5:/g)).toHaveLength(4);

    const repoRoot = path.resolve(path.dirname(testFile), "../..");
    const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const largeQuantitiesStep = ci.indexOf("Run TEID-95 acceptance suite");
    const billingInstallStep = ci.indexOf("Install billing-periods suite dependencies");
    const billingRunStep = ci.indexOf("Run TEID-96 acceptance suite");
    expect(largeQuantitiesStep).toBeGreaterThan(-1);
    expect(billingInstallStep).toBeGreaterThan(largeQuantitiesStep);
    expect(billingRunStep).toBeGreaterThan(billingInstallStep);
  });

  it("TEID-96-T7: resolves the selected repeated-hour instant deterministically across calls", async () => {
    expect((await putConfig("America/New_York", 1)).status).toBe(200);
    const repeatedHourInstant = "2026-11-01T01:30:00-04:00";

    const first = await resolve(repeatedHourInstant);
    const second = await resolve(repeatedHourInstant);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(utc(first.body.period_start)).toBe("2026-11-01T04:00:00.000Z");
    expect(utc(first.body.period_end)).toBe("2026-12-01T05:00:00.000Z");
  });

  it("TEID-96-T8: keeps the first timestamp when duplicate submissions straddle a boundary by 1ms", async () => {
    expect((await putConfig("UTC", 1)).status).toBe(200);
    const idempotencyKey = `teid-96-t8-${randomUUID()}`;
    const common = {
      customer_id: fx.tenant2.customerId,
      event_type: "clock_skew_boundary",
      quantity: 7.125,
      idempotency_key: idempotencyKey,
    };

    // Same future-date rationale as TEID-96-T1 above -- see its comment.
    const first = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body: [{ ...common, occurred_at: "2030-03-31T23:59:59.9995Z" }],
    });
    const duplicate = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body: [{ ...common, occurred_at: "2030-04-01T00:00:00.0005Z" }],
    });

    expect(first.status).toBe(207);
    expect(first.body.results[0].status).toBe("created");
    expect(String(first.body.results[0].quantity)).toBe("7.125");
    expect(duplicate.status).toBe(207);
    expect(duplicate.body.results[0]).toEqual({ status: "duplicate", id: first.body.results[0].id });

    const listed = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant2.customerId}`, {
      apiKey: fx.tenant2.apiKey,
    });
    expect(listed.status).toBe(200);
    const matching = listed.body.data.filter((event: { idempotency_key: string }) => event.idempotency_key === idempotencyKey);
    expect(matching).toHaveLength(1);
    expect(utc(matching[0].occurred_at)).toBe("2030-03-31T23:59:59.999Z");

    const assigned = await resolve(matching[0].occurred_at);
    expect(assigned.status).toBe(200);
    expect(utc(assigned.body.period_start)).toBe("2030-03-01T00:00:00.000Z");
    expect(utc(assigned.body.period_end)).toBe("2030-04-01T00:00:00.000Z");
  });
});
