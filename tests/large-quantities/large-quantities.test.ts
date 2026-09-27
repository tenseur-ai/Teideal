import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { GO_USAGE_URL, SUPERUSER_DATABASE_URL, loadFixtures, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;
const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });
const disposableCustomerIds: string[] = [];

beforeAll(() => {
  fx = loadFixtures();
});

afterAll(async () => {
  if (disposableCustomerIds.length > 0) {
    await superPool.query("DELETE FROM usage_events WHERE customer_id = ANY($1::uuid[])", [disposableCustomerIds]);
    await superPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [disposableCustomerIds]);
  }
  await superPool.end();
});

async function createDisposableCustomer(label: string): Promise<string> {
  const id = randomUUID();
  disposableCustomerIds.push(id);
  await superPool.query(
    "INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)",
    [id, fx.tenant1.id, label, `${label}-${id}@example.test`],
  );
  return id;
}

async function price(quantity: string, unitPrice: string) {
  return call(`${GO_USAGE_URL}/money/price`, {
    method: "POST",
    apiKey: fx.tenant1.apiKey,
    body: { currency: "USD", quantity, unit_price: unitPrice },
  });
}

describe("TEID-95 sub-cent unit prices and very large quantities", () => {
  // TEID-95-T1: the complete 12-place unit price reaches the line amount unchanged.
  it("TEID-95-T1: preserves a unit price with 12 decimal places", async () => {
    const response = await price("1", "0.000000000001");

    expect(response.status).toBe(200);
    expect(response.body.line_amount).toBe("0.000000000001");
  });

  // TEID-95-T2: a bare JSON number at the cap survives POST, NUMERIC storage, and GET.
  it("TEID-95-T2: round-trips a one-trillion-unit usage event exactly", async () => {
    const customerId = await createDisposableCustomer("teid-95-t2");
    const idempotencyKey = `teid-95-t2-${randomUUID()}`;
    const created = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: customerId,
        event_type: "trillion_units",
        quantity: 1_000_000_000_000,
        idempotency_key: idempotencyKey,
      },
    });

    expect(created.status).toBe(201);
    expect(String(created.body.quantity)).toBe("1000000000000");

    const listed = await call(`${GO_USAGE_URL}/usage?customer_id=${customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].idempotency_key).toBe(idempotencyKey);
    expect(String(listed.body.data[0].quantity)).toBe("1000000000000");
    expect(JSON.stringify(listed.body.data[0].quantity).toLowerCase()).not.toContain("e+");
  });

  // TEID-95-T3: exact operands produce exactly USD 4,500.00 after invoice rounding.
  it("TEID-95-T3: prices three billion tokens at 0.0000015 USD", async () => {
    const response = await price("3000000000", "0.0000015");

    expect(response.status).toBe(200);
    expect(response.body.line_amount).toBe("4500");
    expect(response.body.invoice_amount).toBe("4500.00");
  });

  // TEID-95-T4: the API is the scoped console surface; the source audit for
  // CSV/JSON export precision is recorded in NOTES-TEID-95.md.
  it("TEID-95-T4: exposes full precision and rounds only the USD invoice amount", async () => {
    const response = await price("1", "0.0000015");

    expect(response.status).toBe(200);
    expect(response.body.line_amount).toBe("0.0000015");
    expect(response.body.invoice_amount).toBe("0.00");
    expect(response.body.invoice_amount).toMatch(/^\d+\.\d{2}$/);
  });

  // TEID-95-T5: PostgreSQL performs one exact NUMERIC SUM over 500 near-cap rows.
  it("TEID-95-T5: aggregates 500 near-trillion events exactly within five seconds", async () => {
    const customerId = await createDisposableCustomer("teid-95-t5");
    const marker = `teid-95-t5-${randomUUID()}`;
    const quantity = 999_999_999_999n;
    const eventCount = 500;
    const expectedTotal = (quantity * BigInt(eventCount)).toString();

    await superPool.query(
      `INSERT INTO usage_events
         (tenant_id, customer_id, event_type, quantity, idempotency_key)
       SELECT $1, $2, 'near_trillion', $3::numeric, $4 || '-' || g
       FROM generate_series(1, $5::int) AS g`,
      [fx.tenant1.id, customerId, quantity.toString(), marker, eventCount],
    );

    const started = performance.now();
    const response = await call(`${GO_USAGE_URL}/usage/summary?customer_id=${customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    const elapsedMs = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(response.body.event_count).toBe(eventCount);
    expect(response.body.total_quantity).toBe(expectedTotal);
  });

  // TEID-95-T6: app validation names the cap and rejects before inserting.
  it("TEID-95-T6: rejects one unit over one trillion without writing a row", async () => {
    const customerId = await createDisposableCustomer("teid-95-t6");
    const summaryUrl = `${GO_USAGE_URL}/usage/summary?customer_id=${customerId}`;
    const before = await call(summaryUrl, { apiKey: fx.tenant1.apiKey });

    const rejected = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: customerId,
        event_type: "over_cap",
        quantity: 1_000_000_000_001,
        idempotency_key: `teid-95-t6-${randomUUID()}`,
      },
    });
    const after = await call(summaryUrl, { apiKey: fx.tenant1.apiKey });

    expect(before.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("quantity must not exceed 1000000000000 (one trillion)");
    expect(after.status).toBe(200);
    expect(after.body.event_count).toBe(before.body.event_count);
    expect(after.body.total_quantity).toBe(before.body.total_quantity);
  });

  // TEID-95-T7: twenty decimal places are explicitly rejected at the API boundary.
  it("TEID-95-T7: rejects a unit price beyond the 12-place limit", async () => {
    const response = await price("1", "0.00000000000000000001");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("unit_price supports at most 12 decimal places");
  });
});
