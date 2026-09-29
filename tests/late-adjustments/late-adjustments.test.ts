import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, createCustomer, countUsageEvents, setBillingConfig, withTenant } from "./db.js";
import { GO_USAGE_URL, loadFixtures } from "./env.js";
import { call } from "./http.js";

const fixtures = loadFixtures();
const TENANT_ID = fixtures.tenant1.id;
const API_KEY = fixtures.tenant1.apiKey;

afterAll(() => appPool.end());

// Anchor day 1, UTC: monthly periods run [1st, next 1st). Using whole months
// relative to "now" (the real system clock, since PostUsage's closed-period
// check is a plain now() >= period_end comparison, not an injectable clock)
// keeps every "closed" fixture robust regardless of which day of the month
// tests actually run on -- no boundary-adjacent flakiness.
async function subscribeMonthly(tenantId: string, customerId: string): Promise<void> {
  await setBillingConfig(tenantId, customerId, { billing_timezone: "UTC", billing_anchor_day: 1 });
}

function monthsAgo(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15, 10, 0, 0));
}

function monthBounds(date: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function postUsage(body: Record<string, unknown>) {
  return call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: API_KEY, body });
}

async function setThreshold(customerId: string, threshold: number | null) {
  return call(`${GO_USAGE_URL}/customers/${customerId}/billing-config`, {
    method: "PUT",
    apiKey: API_KEY,
    body: { auto_approve_adjustment_threshold: threshold },
  });
}

describe("TEID-34 late-arriving events", () => {
  it("TEID-34-T1 assigns a late-arriving event to the period it happened in, not when it arrived", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t1");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(3);
    const { start, end } = monthBounds(occurredAt);

    const res = await postUsage({
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: 10,
      idempotency_key: randomUUID(),
      occurred_at: occurredAt.toISOString(),
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued_for_review");
    const adjustment = await withTenant(TENANT_ID, async (client) => {
      const { rows } = await client.query(
        `SELECT period_start, period_end, status FROM usage_adjustments WHERE id = $1`,
        [res.body.adjustment_id],
      );
      return rows[0];
    });
    expect(new Date(adjustment.period_start).toISOString()).toBe(start);
    expect(new Date(adjustment.period_end).toISOString()).toBe(end);
    expect(adjustment.status).toBe("pending");
  });

  it("TEID-34-T2 applies a late-arriving event for the current, still-open period immediately", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t2");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = new Date();

    const res = await postUsage({
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: 5,
      idempotency_key: randomUUID(),
      occurred_at: occurredAt.toISOString(),
    });

    expect(res.status).toBe(201);
    expect(res.body.is_prior_period_adjustment).toBe(false);
    const list = await call(`${GO_USAGE_URL}/usage?customer_id=${customerId}`, { apiKey: API_KEY });
    expect(list.body.data.some((e: any) => e.id === res.body.id)).toBe(true);
  });

  it("TEID-34-T3 leaves a closed period's stored total unchanged and queues the event pending", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t3");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(2);
    const { start, end } = monthBounds(occurredAt);
    const before = await countUsageEvents(TENANT_ID, customerId, start, end);

    const res = await postUsage({
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: 7,
      idempotency_key: randomUUID(),
      occurred_at: occurredAt.toISOString(),
    });

    expect(res.status).toBe(202);
    const after = await countUsageEvents(TENANT_ID, customerId, start, end);
    expect(after).toBe(before);
    const adjustment = await withTenant(TENANT_ID, async (client) => {
      const { rows } = await client.query(`SELECT status FROM usage_adjustments WHERE id = $1`, [res.body.adjustment_id]);
      return rows[0];
    });
    expect(adjustment.status).toBe("pending");
  });

  it("TEID-34-T4 lets an operator approve, reject, and auto-approve below a threshold", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t4");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(2);

    const toApprove = await postUsage({
      customer_id: customerId, event_type: "tokens.in", quantity: 1,
      idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
    });
    const toReject = await postUsage({
      customer_id: customerId, event_type: "tokens.in", quantity: 1,
      idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
    });
    expect(toApprove.status).toBe(202);
    expect(toReject.status).toBe(202);

    const approved = await call(`${GO_USAGE_URL}/adjustments/${toApprove.body.adjustment_id}/approve`, {
      method: "POST", apiKey: API_KEY,
    });
    const rejected = await call(`${GO_USAGE_URL}/adjustments/${toReject.body.adjustment_id}/reject`, {
      method: "POST", apiKey: API_KEY,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.resulting_usage_event_id).toBeTruthy();
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(rejected.body.resulting_usage_event_id).toBeFalsy();

    const thresholdRes = await setThreshold(customerId, 10);
    expect(thresholdRes.status).toBe(200);

    const small = await postUsage({
      customer_id: customerId, event_type: "tokens.in", quantity: 5,
      idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
    });
    expect(small.status).toBe(201);
    expect(small.body.is_prior_period_adjustment).toBe(true);

    const large = await postUsage({
      customer_id: customerId, event_type: "tokens.in", quantity: 50,
      idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
    });
    expect(large.status).toBe(202);
  });

  it("TEID-34-T5 shows an approved adjustment as a distinctly labelled prior-period line", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t5");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(4);

    const queued = await postUsage({
      customer_id: customerId, event_type: "tokens.in", quantity: 30,
      idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
    });
    expect(queued.status).toBe(202);
    const approved = await call(`${GO_USAGE_URL}/adjustments/${queued.body.adjustment_id}/approve`, {
      method: "POST", apiKey: API_KEY,
    });
    expect(approved.status).toBe(200);

    const filtered = await call(
      `${GO_USAGE_URL}/usage?customer_id=${customerId}&prior_period_adjustments=true`,
      { apiKey: API_KEY },
    );
    expect(filtered.body.data.map((e: any) => e.id)).toContain(approved.body.resulting_usage_event_id);
    expect(filtered.body.data.every((e: any) => e.is_prior_period_adjustment === true)).toBe(true);
  });

  it("TEID-34-T6 lets an operator triage 50 pending adjustments quickly", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t6");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(2);

    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const res = await postUsage({
        customer_id: customerId, event_type: "tokens.in", quantity: 1,
        idempotency_key: randomUUID(), occurred_at: occurredAt.toISOString(),
      });
      expect(res.status).toBe(202);
      ids.push(res.body.adjustment_id);
    }

    const started = Date.now();
    const list = await call(`${GO_USAGE_URL}/adjustments?status=pending`, { apiKey: API_KEY });
    expect(list.status).toBe(200);
    for (const id of ids) {
      const action = await call(`${GO_USAGE_URL}/adjustments/${id}/approve`, { method: "POST", apiKey: API_KEY });
      expect(action.status).toBe(200);
    }
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(10 * 60 * 1000);
  });

  it("TEID-34-T7 handles 200 concurrent late-arriving events for the same closed period with no loss or duplication", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t7");
    await subscribeMonthly(TENANT_ID, customerId);
    const occurredAt = monthsAgo(3);
    const { start, end } = monthBounds(occurredAt);
    const before = await countUsageEvents(TENANT_ID, customerId, start, end);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        postUsage({
          customer_id: customerId, event_type: "tokens.in", quantity: 1,
          idempotency_key: `teid-34-t7-${i}-${randomUUID()}`, occurred_at: occurredAt.toISOString(),
        })),
    );

    expect(results.every((r) => r.status === 202)).toBe(true);
    const adjustmentIds = new Set(results.map((r) => r.body.adjustment_id));
    expect(adjustmentIds.size).toBe(200);
    const after = await countUsageEvents(TENANT_ID, customerId, start, end);
    expect(after).toBe(before);
  });

  it("TEID-34-T8 rejects an invalid auto-approval threshold", async () => {
    const customerId = await createCustomer(TENANT_ID, "teid-34-t8");
    await subscribeMonthly(TENANT_ID, customerId);

    const negative = await setThreshold(customerId, -1);
    expect(negative.status).toBe(400);
    const huge = await setThreshold(customerId, 999999999);
    expect(huge.status).toBe(400);

    const config = await call(`${GO_USAGE_URL}/customers/${customerId}/billing-config`, { apiKey: API_KEY });
    expect(config.body.auto_approve_adjustment_threshold ?? null).toBeNull();
  });
});
