import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DiscrepancyReport, DiscrepancyReportRow } from "../../services/ts-console/src/lib/verify/discrepancyReport.js";
import {
  billedRows,
  cleanupFixture,
  createCustomer,
  createFixture,
  linkCustomer,
  seedDiscrepancyScale,
  seedExpectedActivity,
  seedInvoiceRecord,
  seedRecord,
  superPool,
  type Fixture,
} from "./db.js";
import { TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { financeSession, supportSession } from "./session.js";

const scaleBudgetMs = Number(process.env.VERIFY_DISCREPANCY_SCALE_BUDGET_MS ?? 60_000);
let financeToken: string;
let supportToken: string;
let fixture: Fixture;

async function runMapper() {
  return call(`${TS_CONSOLE_URL}/verify/map-billed-lines`, { method: "POST", token: financeToken });
}

async function report(params: Record<string, string> = {}): Promise<{ status: number; body: DiscrepancyReport }> {
  const url = new URL("/verify/discrepancy-report", TS_CONSOLE_URL);
  url.searchParams.set("period", "2026-08");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return call<DiscrepancyReport>(url.toString(), { token: financeToken });
}

function rowFor(result: DiscrepancyReport, customerId: string): DiscrepancyReportRow {
  const row = result.data.find((entry) => entry.customer_id === customerId);
  expect(row).toBeTruthy();
  return row!;
}

async function seedMappedCase(input: {
  suffix: string;
  usageBilled?: string;
  usageQuantity?: string;
  billedAmount?: string;
  billedQuantity?: string;
  overage?: string;
}) {
  const customerId = await createCustomer(fixture, input.suffix);
  const stripeCustomerId = `cus_${input.suffix}_${randomUUID()}`;
  const invoiceId = `in_${input.suffix}_${randomUUID()}`;
  const lineId = `il_${input.suffix}_${randomUUID()}`;
  await linkCustomer(customerId, stripeCustomerId);
  const expectedEvidence = await seedExpectedActivity(
    customerId,
    `${fixture.marker}-${input.suffix}`,
    input.usageBilled ?? "425.00",
    input.usageQuantity ?? "100",
    input.overage ?? "0",
  );
  await seedInvoiceRecord(
    fixture,
    invoiceId,
    stripeCustomerId,
    lineId,
    input.billedQuantity ?? "100",
    input.billedAmount ?? "425.00",
  );
  expect((await runMapper()).status).toBe(200);
  return { customerId, stripeCustomerId, invoiceId, lineId, expectedEvidence };
}

beforeAll(async () => {
  if (!Number.isFinite(scaleBudgetMs) || scaleBudgetMs <= 0) {
    throw new Error("VERIFY_DISCREPANCY_SCALE_BUDGET_MS must be a positive number");
  }
  [financeToken, supportToken] = await Promise.all([financeSession(), supportSession()]);
});

beforeEach(async () => {
  fixture = await createFixture(`teid-68-${randomUUID()}`);
});

afterEach(async () => {
  await cleanupFixture(fixture);
});

afterAll(async () => {
  await superPool.end();
});

describe("TEID-68 discrepancy report", () => {
  it("TEID-68-T1 reports an exact $425 match with a zero delta and no classification", async () => {
    const seeded = await seedMappedCase({ suffix: "t1" });

    const denied = await call(`${TS_CONSOLE_URL}/verify/discrepancy-report?period=2026-08`, { token: supportToken });
    expect(denied.status).toBe(403);
    const response = await report();
    expect(response.status).toBe(200);
    expect(rowFor(response.body, seeded.customerId)).toMatchObject({
      expected_total: "425.00",
      billed_total: "425.00",
      delta: "0.00",
      classification: null,
      granularity: "period_total",
    });
  });

  it("TEID-68-T2 classifies a nonzero expected total with no billed lines as missing_line", async () => {
    const seeded = await seedMappedCase({ suffix: "t2" });
    await superPool.query(
      "DELETE FROM verify_billed_lines WHERE tenant_id = $1 AND stripe_invoice_line_id = $2",
      [TENANT_ID, seeded.lineId],
    );

    const response = await report();
    expect(response.status).toBe(200);
    expect(rowFor(response.body, seeded.customerId)).toMatchObject({
      expected_total: "425.00",
      billed_total: "0.00",
      delta: "425.00",
      classification: "missing_line",
    });
  });

  it("TEID-68-T3 classifies equal quantities and a 20% lower billed total as rate_drift", async () => {
    const seeded = await seedMappedCase({ suffix: "t3", billedAmount: "340.00" });

    const response = await report();
    expect(response.status).toBe(200);
    expect(rowFor(response.body, seeded.customerId)).toMatchObject({
      expected_total: "425.00",
      billed_total: "340.00",
      delta: "85.00",
      classification: "rate_drift",
    });
  });

  it("TEID-68-T4 classifies independent usage above billed-line quantity as quantity", async () => {
    const seeded = await seedMappedCase({
      suffix: "t4",
      usageQuantity: "100",
      billedQuantity: "80",
      billedAmount: "340.00",
    });

    const response = await report();
    expect(response.status).toBe(200);
    const row = rowFor(response.body, seeded.customerId);
    expect(row.classification).toBe("quantity");
    expect(row.evidence.expected.usage_quantity).toBe("100");
    expect(row.evidence.billed.quantity).toBe("80");
  });

  it("TEID-68-T5 traces a discrepancy to exact billed, ledger, consumption, and usage rows", async () => {
    const seeded = await seedMappedCase({
      suffix: "t5",
      usageBilled: "400.00",
      overage: "25.00",
      billedAmount: "400.00",
    });
    const billed = (await billedRows([seeded.lineId]))[0];

    const response = await report();
    expect(response.status).toBe(200);
    const row = rowFor(response.body, seeded.customerId);
    expect(row.delta).toBe("25.00");
    expect(row.evidence.expected.ledger_line_ids).toEqual([seeded.expectedEvidence.ledgerLineId]);
    expect(row.evidence.expected.overage_consumption_line_ids)
      .toEqual([seeded.expectedEvidence.overageConsumptionLineId]);
    expect(row.evidence.expected.usage_event_ids).toEqual([seeded.expectedEvidence.usageEventId]);
    expect(row.evidence.billed.lines.map((line) => line.id)).toEqual([billed.id]);
  });

  it("TEID-68-T6 is byte-identical across unchanged runs", async () => {
    await seedMappedCase({ suffix: "t6", billedAmount: "340.00" });

    const first = await report();
    const second = await report();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });

  it("TEID-68-T7 reports 500 customers within the configured CI budget", { timeout: scaleBudgetMs + 30_000 }, async () => {
    const customerIds = new Set(await seedDiscrepancyScale(fixture));
    const started = performance.now();
    const response = await report();
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    const scaleRows = response.body.data.filter((row) => customerIds.has(row.customer_id));
    expect(scaleRows).toHaveLength(500);
    expect(scaleRows.every((row) => row.delta === "0.00" && row.classification === null)).toBe(true);
    expect(elapsed, `reporting 500 customers took ${elapsed.toFixed(1)}ms`).toBeLessThan(scaleBudgetMs);
  });

  it("TEID-68-T8 ignores a caller-supplied expected total and recomputes the live summary", async () => {
    const seeded = await seedMappedCase({ suffix: "t8", billedAmount: "340.00" });

    const response = await report({ expected_total: "340.00" });
    expect(response.status).toBe(200);
    expect(rowFor(response.body, seeded.customerId)).toMatchObject({
      expected_total: "425.00",
      delta: "85.00",
      classification: "rate_drift",
    });
  });

  it("TEID-68-T9 lists an unmapped customer and totals its excluded dollars", async () => {
    const stripeCustomerId = `cus_unmapped_${randomUUID()}`;
    const invoiceId = `in_unmapped_${randomUUID()}`;
    const lineId = `il_unmapped_${randomUUID()}`;
    await seedRecord(fixture, "customer", stripeCustomerId, {
      id: stripeCustomerId,
      name: "Unmapped Verify Customer",
      email: "unmapped-verify@example.test",
      passthrough: {},
    });
    await seedInvoiceRecord(fixture, invoiceId, stripeCustomerId, lineId, "1", "49.99");
    expect((await runMapper()).status).toBe(200);

    const response = await report();
    expect(response.status).toBe(200);
    expect(response.body.excluded).toContainEqual(expect.objectContaining({
      customer_id: stripeCustomerId,
      reason: "unmapped_customer",
      billed_total: "49.99",
    }));
    expect(response.body.totals.excluded_billed).toBe("49.99");
  });

  it("TEID-68-T10 flags credit/refund-only activity before missing_line", async () => {
    const customerId = await createCustomer(fixture, "t10");
    const stripeCustomerId = `cus_t10_${randomUUID()}`;
    await linkCustomer(customerId, stripeCustomerId);
    await seedExpectedActivity(customerId, `${fixture.marker}-t10`, "425.00", "100");
    await seedRecord(fixture, "credit", `cn_t10_${randomUUID()}`, {
      id: `cn_t10_${randomUUID()}`,
      customer_id: stripeCustomerId,
      amount: "25.00",
      currency: "USD",
      reason: "adjustment",
      issued_at: "2026-08-20T00:00:00.000Z",
      external_updated_at: null,
      passthrough: {},
    });

    const response = await report();
    expect(response.status).toBe(200);
    const row = rowFor(response.body, customerId);
    expect(row.classification).toBe("known_coverage_gap");
    expect(row.classification).not.toBe("missing_line");
    expect(row.evidence.coverage_gaps.reasons).toEqual(["credit_payment_refund_not_mapped"]);
  });
});
