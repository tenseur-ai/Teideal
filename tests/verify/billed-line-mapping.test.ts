import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  billedRows,
  cleanupFixture,
  createCustomer,
  createFixture,
  linkCustomer,
  seedRecord,
  seedScale,
  superPool,
  updateInvoice,
  type Fixture,
} from "./db.js";
import { TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { financeSession, supportSession } from "./session.js";

interface MappingResponse {
  mapped_lines: number;
  unmapped_customers: number;
}

interface TestLine {
  id: string;
  invoice_id: string;
  price_id: string | null;
  period_start: string | null;
  period_end: string | null;
  quantity: string;
  amount: string;
  currency: string;
  passthrough: Record<string, unknown>;
}

const scaleBudgetMs = Number(process.env.VERIFY_MAPPING_SCALE_BUDGET_MS ?? 60_000);
let financeToken: string;
let supportToken: string;
let fixture: Fixture;

function line(id: string, invoiceId: string, priceId: string, quantity: string, amount: string): TestLine {
  return {
    id,
    invoice_id: invoiceId,
    price_id: priceId,
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-09-01T00:00:00.000Z",
    quantity,
    amount,
    currency: "USD",
    passthrough: {},
  };
}

function invoice(
  id: string,
  stripeCustomerId: string,
  lines: TestLine[],
  status = "open",
): Record<string, unknown> {
  return {
    id,
    customer_id: stripeCustomerId,
    amount: "0",
    currency: "USD",
    status,
    issued_at: "2026-09-01T00:00:00.000Z",
    lines,
    passthrough: {},
  };
}

async function runMapper(token = financeToken) {
  return call<MappingResponse>(`${TS_CONSOLE_URL}/verify/map-billed-lines`, {
    method: "POST",
    token,
  });
}

beforeAll(async () => {
  if (!Number.isFinite(scaleBudgetMs) || scaleBudgetMs <= 0) {
    throw new Error("VERIFY_MAPPING_SCALE_BUDGET_MS must be a positive number");
  }
  [financeToken, supportToken] = await Promise.all([financeSession(), supportSession()]);
});

beforeEach(async () => {
  fixture = await createFixture(`teid-66-${randomUUID()}`);
});

afterEach(async () => {
  await cleanupFixture(fixture);
});

afterAll(async () => {
  await superPool.end();
});

describe("TEID-66 billed-line mapping", () => {
  it("TEID-66-T1 maps every invoice line to exact typed billed facts", async () => {
    const customerId = await createCustomer(fixture, "t1-customer");
    await linkCustomer(customerId, "cus_t1");
    const lines = [
      line("il_t1_a", "in_t1", "price_t1_a", "9007199254740993.000001", "123456789.123456"),
      line("il_t1_b", "in_t1", "price_t1_b", "2.500000", "0.000001"),
    ];
    await seedRecord(fixture, "invoice", "in_t1", invoice("in_t1", "cus_t1", lines));

    const denied = await runMapper(supportToken);
    expect(denied.status).toBe(403);
    const response = await runMapper();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mapped_lines: 2, unmapped_customers: 0 });

    const rows = await billedRows(lines.map((entry) => entry.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({
      customer_id: row.customer_id,
      price_id: row.price_id,
      period_start: row.period_start.toISOString(),
      period_end: row.period_end.toISOString(),
      quantity: row.quantity,
      amount: row.amount,
    }))).toEqual([
      {
        customer_id: customerId,
        price_id: "price_t1_a",
        period_start: "2026-08-01T00:00:00.000Z",
        period_end: "2026-09-01T00:00:00.000Z",
        quantity: "9007199254740993.000001",
        amount: "123456789.123456",
      },
      {
        customer_id: customerId,
        price_id: "price_t1_b",
        period_start: "2026-08-01T00:00:00.000Z",
        period_end: "2026-09-01T00:00:00.000Z",
        quantity: "2.500000",
        amount: "0.000001",
      },
    ]);
  });

  it("TEID-66-T2 keeps the Stripe price reference consistent with the landed contract", async () => {
    const customerId = await createCustomer(fixture, "t2-customer");
    await linkCustomer(customerId, "cus_t2");
    await seedRecord(fixture, "contract", "sub_t2", {
      id: "sub_t2",
      customer_id: "cus_t2",
      status: "active",
      started_at: "2026-08-01T00:00:00.000Z",
      ended_at: null,
      passthrough: { price_id: "price_t2_contract" },
    });
    const contractLine = {
      ...line("il_t2", "in_t2", "price_t2_contract", "7", "70.00"),
      passthrough: { subscription: "sub_t2" },
    };
    await seedRecord(fixture, "invoice", "in_t2", invoice("in_t2", "cus_t2", [contractLine]));

    expect((await runMapper()).status).toBe(200);
    const billed = (await billedRows(["il_t2"]))[0];
    const contractPrice = (await superPool.query<{ price_id: string }>(
      `SELECT data #>> '{passthrough,price_id}' AS price_id
       FROM connector_records
       WHERE connector_id = $1 AND entity_type = 'contract' AND external_id = 'sub_t2'`,
      [fixture.connectorId],
    )).rows[0].price_id;
    expect(billed.price_id).toBe(contractPrice);
    const invoiceSubscription = (await superPool.query<{ subscription_id: string }>(
      `SELECT data #>> '{lines,0,passthrough,subscription}' AS subscription_id
       FROM connector_records
       WHERE connector_id = $1 AND entity_type = 'invoice' AND external_id = 'in_t2'`,
      [fixture.connectorId],
    )).rows[0].subscription_id;
    expect(invoiceSubscription).toBe("sub_t2");
  });

  it("TEID-66-T3 records an unresolved Stripe customer and maps none of its lines", async () => {
    await seedRecord(fixture, "customer", "cus_t3_unmapped", {
      id: "cus_t3_unmapped",
      name: "Unmapped Incorporated",
      email: "unmapped@example.test",
      passthrough: {},
    });
    await seedRecord(fixture, "invoice", "in_t3", invoice("in_t3", "cus_t3_unmapped", [
      line("il_t3", "in_t3", "price_t3", "1", "49.99"),
    ]));

    const response = await runMapper();
    expect(response.status).toBe(200);
    expect(await billedRows(["il_t3"])).toHaveLength(0);
    const unmapped = (await superPool.query<{
      stripe_customer_id: string;
      stripe_customer_name: string | null;
    }>(
      `SELECT stripe_customer_id, stripe_customer_name
       FROM verify_unmapped_customers
       WHERE tenant_id = $1 AND connector_id = $2`,
      [TENANT_ID, fixture.connectorId],
    )).rows;
    expect(unmapped).toEqual([{
      stripe_customer_id: "cus_t3_unmapped",
      stripe_customer_name: "Unmapped Incorporated",
    }]);
  });

  it("TEID-66-T4 is idempotent across an unchanged connector snapshot", async () => {
    const customerId = await createCustomer(fixture, "t4-customer");
    await linkCustomer(customerId, "cus_t4");
    await seedRecord(fixture, "invoice", "in_t4", invoice("in_t4", "cus_t4", [
      line("il_t4", "in_t4", "price_t4", "3.25", "19.5000"),
    ]));

    expect((await runMapper()).status).toBe(200);
    const first = await billedRows(["il_t4"]);
    const secondRun = await runMapper();
    expect(secondRun.status).toBe(200);
    expect(secondRun.body.mapped_lines).toBe(0);
    expect(await billedRows(["il_t4"])).toEqual(first);
  });

  it("TEID-66-T5 updates an incrementally changed invoice line in place", async () => {
    const customerId = await createCustomer(fixture, "t5-customer");
    await linkCustomer(customerId, "cus_t5");
    await seedRecord(fixture, "invoice", "in_t5", invoice("in_t5", "cus_t5", [
      line("il_t5", "in_t5", "price_t5", "1", "10.00"),
    ]));
    expect((await runMapper()).status).toBe(200);
    const first = (await billedRows(["il_t5"]))[0];

    await updateInvoice(fixture, "in_t5", invoice("in_t5", "cus_t5", [
      line("il_t5", "in_t5", "price_t5", "2", "20.00"),
    ], "paid"));
    const response = await runMapper();
    expect(response.status).toBe(200);
    expect(response.body.mapped_lines).toBe(1);
    const rows = await billedRows(["il_t5"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].quantity).toBe("2");
    expect(rows[0].amount).toBe("20.00");
    const rawStatus = (await superPool.query<{ status: string }>(
      `SELECT data->>'status' AS status FROM connector_records
       WHERE connector_id = $1 AND entity_type = 'invoice' AND external_id = 'in_t5'`,
      [fixture.connectorId],
    )).rows[0].status;
    expect(rawStatus).toBe("paid");
  });

  it("TEID-66-T6 maps 50,000 invoice lines within the configured CI budget", { timeout: scaleBudgetMs + 30_000 }, async () => {
    await seedScale(fixture);
    const started = performance.now();
    const response = await runMapper();
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(response.body.mapped_lines).toBe(50_000);
    const count = (await superPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verify_billed_lines
       WHERE tenant_id = $1 AND connector_id = $2`,
      [TENANT_ID, fixture.connectorId],
    )).rows[0].count;
    expect(count).toBe("50000");
    expect(elapsed, `mapping 50,000 lines took ${elapsed.toFixed(1)}ms`).toBeLessThan(scaleBudgetMs);
  });

  it("TEID-66-T7 preserves a price ID that has no price connector record", async () => {
    const customerId = await createCustomer(fixture, "t7-customer");
    await linkCustomer(customerId, "cus_t7");
    await seedRecord(fixture, "invoice", "in_t7", invoice("in_t7", "cus_t7", [
      line("il_t7", "in_t7", "price_deleted_t7", "1", "5.00"),
    ]));

    expect((await runMapper()).status).toBe(200);
    const rows = await billedRows(["il_t7"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].price_id).toBe("price_deleted_t7");
    const priceRecords = (await superPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM connector_records
       WHERE connector_id = $1 AND entity_type = 'price' AND external_id = 'price_deleted_t7'`,
      [fixture.connectorId],
    )).rows[0].count;
    expect(priceRecords).toBe("0");
  });

  it("TEID-66-T8 keeps old and reconnected Stripe customer invoices under one Teideal customer", async () => {
    const customerId = await createCustomer(fixture, "t8-customer");
    await linkCustomer(customerId, "cus_t8_old");
    await seedRecord(fixture, "invoice", "in_t8_old", invoice("in_t8_old", "cus_t8_old", [
      line("il_t8_old", "in_t8_old", "price_t8", "1", "11.00"),
    ]));
    expect((await runMapper()).status).toBe(200);

    await superPool.query(
      `UPDATE stripe_customer_links SET stripe_customer_id = 'cus_t8_new'
       WHERE tenant_id = $1 AND customer_id = $2`,
      [TENANT_ID, customerId],
    );
    await seedRecord(fixture, "invoice", "in_t8_new", invoice("in_t8_new", "cus_t8_new", [
      line("il_t8_new", "in_t8_new", "price_t8", "2", "22.00"),
    ]));
    expect((await runMapper()).status).toBe(200);

    const rows = await billedRows(["il_t8_old", "il_t8_new"]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.customer_id))).toEqual(new Set([customerId]));
  });

  it("TEID-66-T9 skips a periodless one-off line without failing the rest of the tenant's mapping", async () => {
    const customerId = await createCustomer(fixture, "t9-customer");
    await linkCustomer(customerId, "cus_t9");
    const periodlessLine = {
      ...line("il_t9_oneoff", "in_t9", "price_t9_oneoff", "1", "5.00"),
      period_start: null,
      period_end: null,
    };
    await seedRecord(fixture, "invoice", "in_t9", invoice("in_t9", "cus_t9", [
      periodlessLine,
      line("il_t9_normal", "in_t9", "price_t9_normal", "1", "15.00"),
    ]));

    const response = await runMapper();
    expect(response.status).toBe(200);
    expect(response.body.mapped_lines).toBe(1);
    expect(await billedRows(["il_t9_oneoff"])).toHaveLength(0);
    const normalRow = await billedRows(["il_t9_normal"]);
    expect(normalRow).toHaveLength(1);
    expect(normalRow[0].amount).toBe("15.00");
  });

  it("TEID-66-T10 skips a priceless line without failing the rest of the tenant's mapping", async () => {
    const customerId = await createCustomer(fixture, "t10-customer");
    await linkCustomer(customerId, "cus_t10");
    const pricelessLine = {
      ...line("il_t10_oneoff", "in_t10", "price_t10_oneoff", "1", "5.00"),
      price_id: null,
    };
    await seedRecord(fixture, "invoice", "in_t10", invoice("in_t10", "cus_t10", [
      pricelessLine,
      line("il_t10_normal", "in_t10", "price_t10_normal", "1", "25.00"),
    ]));

    const response = await runMapper();
    expect(response.status).toBe(200);
    expect(response.body.mapped_lines).toBe(1);
    expect(await billedRows(["il_t10_oneoff"])).toHaveLength(0);
    const normalRow = await billedRows(["il_t10_normal"]);
    expect(normalRow).toHaveLength(1);
    expect(normalRow[0].amount).toBe("25.00");
  });
});
