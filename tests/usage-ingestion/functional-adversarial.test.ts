import { beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, GO_USAGE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;

beforeAll(() => {
  fx = loadFixtures();
});

describe("TEID-30 Functional & Adversarial Ingestion Tests", () => {
  // TEID-30-T1: Submit a single event via the ingestion API and confirm a 201 with an event ID,
  // then submit one batch containing exactly 1,000 events and confirm all 1,000 are accepted with individual per-event statuses.
  it("TEID-30-T1: single event 201 and batch of 1,000 events 207 accepted in order", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Single event
    const singleRes = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: fx.tenant1.customerId,
        event_type: "api_call",
        quantity: 1,
        idempotency_key: `t1-single-${runId}`,
      },
    });
    expect(singleRes.status).toBe(201);
    expect(singleRes.body.id).toBeDefined();
    expect(typeof singleRes.body.id).toBe("string");

    // Batch of 1,000 events
    const batch = Array.from({ length: 1000 }, (_, i) => ({
      customer_id: fx.tenant1.customerId,
      event_type: `t1-batch-${i}`,
      quantity: 1,
      idempotency_key: `t1-batch-${runId}-${i}`,
    }));

    const batchRes = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: batch,
    });

    expect(batchRes.status).toBe(207);
    expect(Array.isArray(batchRes.body.results)).toBe(true);
    expect(batchRes.body.results).toHaveLength(1000);

    for (let i = 0; i < 1000; i++) {
      const resItem = batchRes.body.results[i];
      expect(resItem.status).toBe("created");
      expect(resItem.id).toBeDefined();
      expect(resItem.customer_id).toBe(fx.tenant1.customerId);
      expect(resItem.event_type).toBe(`t1-batch-${i}`);
      expect(resItem.quantity).toBe(1);
      expect(resItem.idempotency_key).toBe(`t1-batch-${runId}-${i}`);
    }
  });

  // TEID-30-T2: Submit an event, capture the timestamp the acknowledgment is returned, and confirm the event is already durably committed and queryable in the store at that exact moment.
  it("TEID-30-T2: event is durably committed and queryable immediately upon ack", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const idempotencyKey = `t2-durable-${runId}`;

    const ackRes = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: fx.tenant1.customerId,
        event_type: "durability_check",
        quantity: 5,
        idempotency_key: idempotencyKey,
      },
    });
    const ackTime = Date.now();
    expect(ackRes.status).toBe(201);
    const createdId = ackRes.body.id;

    // Immediately query GET /usage
    const getRes = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant1.customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.data)).toBe(true);
    const found = getRes.body.data.find((e: { id: string }) => e.id === createdId);
    expect(found).toBeDefined();
    expect(found.idempotency_key).toBe(idempotencyKey);
  });

  // TEID-30-T4: Submit a batch of 10 events where events 3 and 7 have an invalid metric name and a negative quantity respectively, and confirm the response lists a specific rejection reason for each of the two while the other 8 are accepted and stored.
  it("TEID-30-T4: batch of 10 rejects items 3 and 7 with specific reasons while accepting the other 8", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const batch = Array.from({ length: 10 }, (_, i) => ({
      customer_id: fx.tenant1.customerId,
      event_type: "valid_event",
      quantity: 10,
      idempotency_key: `t4-item-${runId}-${i}`,
    }));

    // Event 3 (index 2): invalid metric name with invalid characters
    batch[2].event_type = "invalid metric name!";
    // Event 7 (index 6): negative quantity
    batch[6].quantity = -1;

    const res = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: batch,
    });

    expect(res.status).toBe(207);
    expect(res.body.results).toHaveLength(10);

    // Event 3 (index 2) rejection
    expect(res.body.results[2].status).toBe("error");
    expect(res.body.results[2].reason).toBe("event_type must match ^[A-Za-z0-9_.:-]{1,128}$");

    // Event 7 (index 6) rejection
    expect(res.body.results[6].status).toBe("error");
    expect(res.body.results[6].reason).toBe("quantity must be a non-negative number");

    // The other 8 accepted
    const createdIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      if (i === 2 || i === 6) continue;
      expect(res.body.results[i].status).toBe("created");
      expect(res.body.results[i].id).toBeDefined();
      createdIds.push(res.body.results[i].id);
    }
    expect(createdIds).toHaveLength(8);

    // Confirm via GET /usage that exactly these 8 were stored
    const getRes = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant1.customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(getRes.status).toBe(200);
    const existingIds = new Set(getRes.body.data.map((e: { id: string }) => e.id));
    for (const id of createdIds) {
      expect(existingIds.has(id)).toBe(true);
    }
  });

  // TEID-30-T8: Submit a batch of 1,001 events in a single request and confirm the API rejects the entire batch with a clear batch-size-exceeded error instead of silently processing only the first 1,000.
  it("TEID-30-T8: reject entire batch of 1,001 events with 400 batch-size-exceeded", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const batch = Array.from({ length: 1001 }, (_, i) => ({
      customer_id: fx.tenant1.customerId,
      event_type: "oversized_test",
      quantity: 1,
      idempotency_key: `t8-item-${runId}-${i}`,
    }));

    const res = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: batch,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("batch exceeds 1000 events");

    // Confirm zero of the 1,001 events were stored
    const getRes = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant1.customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(getRes.status).toBe(200);
    const storedKeys = new Set(getRes.body.data.map((e: { idempotency_key: string }) => e.idempotency_key));
    for (let i = 0; i < 1001; i++) {
      expect(storedKeys.has(`t8-item-${runId}-${i}`)).toBe(false);
    }
  });

  // TEID-30-T9: Submit a batch containing one event with a negative quantity and one with SQL-injection-style characters in the metric name field, and confirm both are rejected with specific validation reasons without crashing the service or affecting the other valid events in the batch.
  it("TEID-30-T9: reject negative quantity and SQLi metric name without crashing service", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const batch = [
      {
        customer_id: fx.tenant1.customerId,
        event_type: "valid_first",
        quantity: 5,
        idempotency_key: `t9-valid-1-${runId}`,
      },
      {
        customer_id: fx.tenant1.customerId,
        event_type: "valid_second",
        quantity: -5,
        idempotency_key: `t9-neg-qty-${runId}`,
      },
      {
        customer_id: fx.tenant1.customerId,
        event_type: "click'; DROP TABLE usage_events;--",
        quantity: 10,
        idempotency_key: `t9-sqli-${runId}`,
      },
      {
        customer_id: fx.tenant1.customerId,
        event_type: "valid_third",
        quantity: 15,
        idempotency_key: `t9-valid-2-${runId}`,
      },
    ];

    const res = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: batch,
    });

    expect(res.status).toBe(207);
    expect(res.body.results).toHaveLength(4);

    expect(res.body.results[0].status).toBe("created");

    expect(res.body.results[1].status).toBe("error");
    expect(res.body.results[1].reason).toBe("quantity must be a non-negative number");

    expect(res.body.results[2].status).toBe("error");
    expect(res.body.results[2].reason).toBe("event_type must match ^[A-Za-z0-9_.:-]{1,128}$");

    expect(res.body.results[3].status).toBe("created");

    // Confirm service is still up and usage_events table exists and is queryable
    const getRes = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant1.customerId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.data)).toBe(true);
  });
});
