import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { superPool } from "./db.js";
import { loadFixtures, GO_USAGE_URL, type Fixtures, type TenantFixture } from "./env.js";
import { seedBackdatedUsageEvent, setUsageEventAge, usageRowsForKey } from "./fixtures.js";
import { call, type ApiResponse } from "./http.js";

let fx: Fixtures;

beforeAll(() => {
  fx = loadFixtures();
});

afterAll(() => superPool.end());

function eventBody(tenant: TenantFixture, idempotencyKey: string, quantity: number | string = 100) {
  return {
    customer_id: tenant.customerId,
    event_type: "idempotency_test",
    quantity,
    idempotency_key: idempotencyKey,
  };
}

async function post(tenant: TenantFixture, body: unknown): Promise<ApiResponse> {
  return call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: tenant.apiKey, body });
}

function assertOneCreatedAndDuplicates(responses: ApiResponse[], workerCount: number): string {
  const created = responses.filter((response) => response.status === 201);
  const duplicates = responses.filter(
    (response) => response.status === 200 && response.body?.status === "duplicate",
  );
  expect(created).toHaveLength(1);
  expect(duplicates).toHaveLength(workerCount - 1);
  const id = created[0].body.id as string;
  expect(new Set(responses.map((response) => response.body?.id))).toEqual(new Set([id]));
  return id;
}

describe("TEID-31 enforced idempotency", () => {
  it("TEID-31-T1: identical retry is acknowledged as a duplicate with one ledger row", async () => {
    const key = `abc-123-${randomUUID()}`;
    const body = eventBody(fx.tenant1, key, 42.5);

    const first = await post(fx.tenant1, body);
    const duplicate = await post(fx.tenant1, body);

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      status: "duplicate",
      id: first.body.id,
      customer_id: fx.tenant1.customerId,
      event_type: "idempotency_test",
      quantity: 42.5,
      idempotency_key: key,
    });

    const listed = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant1.customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.filter((row: { idempotency_key: string }) => row.idempotency_key === key)).toHaveLength(1);
  });

  it("TEID-31-T2: a key is retained at day 371 and reusable at day 372", async () => {
    const key = `teid-31-t2-${randomUUID()}`;
    const body = eventBody(fx.tenant1, key, 19.25);
    const seeded = await seedBackdatedUsageEvent(fx.tenant1, key, body.event_type, "19.25", 371);

    const day371 = await post(fx.tenant1, body);
    expect(day371.status).toBe(200);
    expect(day371.body.status).toBe("duplicate");
    expect(day371.body.id).toBe(seeded.id);

    await setUsageEventAge(seeded.id, seeded.fixedNow, 372);
    const day372 = await post(fx.tenant1, body);
    expect(day372.status).toBe(201);
    expect(day372.body.id).not.toBe(seeded.id);

    const rows = await usageRowsForKey(fx.tenant1.id, key);
    expect(rows).toEqual([{ id: day372.body.id }]);
  });

  it("TEID-31-T3: changed content is rejected and added to the review queue", async () => {
    const key = `xyz-789-${randomUUID()}`;
    const first = await post(fx.tenant1, eventBody(fx.tenant1, key, 100));
    const conflict = await post(fx.tenant1, eventBody(fx.tenant1, key, 200));

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: "idempotency_key already used with different content",
      existing_id: first.body.id,
    });

    const review = await call(
      `${GO_USAGE_URL}/idempotency-conflicts?idempotency_key=${encodeURIComponent(key)}`,
      { apiKey: fx.tenant1.apiKey },
    );
    expect(review.status).toBe(200);
    expect(review.body.data).toHaveLength(1);
    expect(review.body.data[0]).toMatchObject({
      idempotency_key: key,
      existing_usage_event_id: first.body.id,
      attempted_customer_id: fx.tenant1.customerId,
      attempted_event_type: "idempotency_test",
      attempted_quantity: 200,
    });
  });

  it("TEID-31-T4: 50 concurrent identical submissions create exactly one ledger row", async () => {
    const key = `teid-31-t4-${randomUUID()}`;
    const body = eventBody(fx.tenant1, key, 5);
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(fx.tenant1, body)));
    const createdID = assertOneCreatedAndDuplicates(responses, 50);

    const rows = await usageRowsForKey(fx.tenant1.id, key);
    expect(rows).toEqual([{ id: createdID }]);
  });

  it("TEID-31-T5: repeated 50-way concurrency has zero flaky outcomes", async () => {
    // Set IDEMPOTENCY_CONCURRENCY_FUZZ_ITERATIONS=1000 in the dedicated
    // performance/fuzz pipeline. CI defaults to five complete 50-way races.
    const iterations = Number(process.env.IDEMPOTENCY_CONCURRENCY_FUZZ_ITERATIONS ?? 5);
    expect(Number.isInteger(iterations) && iterations > 0).toBe(true);

    for (let iteration = 0; iteration < iterations; iteration++) {
      const key = `teid-31-t5-${iteration}-${randomUUID()}`;
      const body = eventBody(fx.tenant1, key, 11);
      const responses = await Promise.all(Array.from({ length: 50 }, () => post(fx.tenant1, body)));
      const createdID = assertOneCreatedAndDuplicates(responses, 50);
      expect(await usageRowsForKey(fx.tenant1.id, key)).toEqual([{ id: createdID }]);
    }
  });

  it("TEID-31-T6: simultaneous requests both receive handled JSON success responses", async () => {
    const key = `teid-31-t6-${randomUUID()}`;
    const body = eventBody(fx.tenant2, key, 7);
    const responses = await Promise.all([post(fx.tenant2, body), post(fx.tenant2, body)]);

    expect(responses.every((response) => response.status >= 200 && response.status < 300)).toBe(true);
    expect(responses.every((response) => response.body && typeof response.body === "object")).toBe(true);
    assertOneCreatedAndDuplicates(responses, 2);
  });

  it("TEID-31-T7: a tiny exact-decimal difference is rejected and flagged", async () => {
    const key = `teid-31-t7-${randomUUID()}`;
    const first = await post(fx.tenant2, eventBody(fx.tenant2, key, 100.00));
    const conflict = await post(fx.tenant2, eventBody(fx.tenant2, key, 100.0000001));

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body.existing_id).toBe(first.body.id);

    const review = await call(
      `${GO_USAGE_URL}/idempotency-conflicts?idempotency_key=${encodeURIComponent(key)}`,
      { apiKey: fx.tenant2.apiKey },
    );
    expect(review.status).toBe(200);
    expect(review.body.data).toHaveLength(1);
    expect(String(review.body.data[0].attempted_quantity)).toBe("100.0000001");
  });
});
