import { beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, GO_USAGE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;

beforeAll(() => {
  fx = loadFixtures();
});

describe("TEID-30 Sustained Load & Latency Lag Tests", () => {
  // TEID-30-T3 / TEID-30-T6: Sustained load test and p99 ingestion latency check
  it("TEID-30-T3 / TEID-30-T6: sustained load test exhibits zero ingestion errors and p99 latency < 200ms with no upward trend", async () => {
    const rate = process.env.LOAD_TEST_EVENTS_PER_SEC ? parseInt(process.env.LOAD_TEST_EVENTS_PER_SEC, 10) : 1000;
    const durationSeconds = process.env.LOAD_TEST_DURATION_SECONDS ? parseInt(process.env.LOAD_TEST_DURATION_SECONDS, 10) : 10;
    const concurrency = Math.min(50, Math.max(5, Math.floor(rate / 20)));
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const latencies: number[] = [];
    const firstHalfLatencies: number[] = [];
    const secondHalfLatencies: number[] = [];
    let errorCount = 0;
    let totalRequests = 0;

    const startTime = Date.now();
    const endTime = startTime + durationSeconds * 1000;
    const halfTime = startTime + (durationSeconds * 1000) / 2;

    const workers = Array.from({ length: concurrency }, async (_, workerIdx) => {
      let counter = 0;
      while (Date.now() < endTime) {
        counter++;
        const reqStart = Date.now();
        try {
          const res = await call(`${GO_USAGE_URL}/usage`, {
            method: "POST",
            apiKey: fx.tenant1.apiKey,
            body: {
              customer_id: fx.tenant1.customerId,
              event_type: "load_test_metric",
              quantity: 1,
              idempotency_key: `load-${runId}-w${workerIdx}-${counter}`,
            },
          });
          const reqDuration = Date.now() - reqStart;
          totalRequests++;
          if (res.status !== 201) {
            errorCount++;
          } else {
            latencies.push(reqDuration);
            if (reqStart < halfTime) {
              firstHalfLatencies.push(reqDuration);
            } else {
              secondHalfLatencies.push(reqDuration);
            }
          }
        } catch {
          errorCount++;
        }
      }
    });

    await Promise.all(workers);

    // TEID-30-T3 assertion: confirm zero ingestion errors
    expect(totalRequests).toBeGreaterThan(0);
    expect(errorCount).toBe(0);

    // Sort latencies to compute percentiles
    latencies.sort((a, b) => a - b);
    firstHalfLatencies.sort((a, b) => a - b);
    secondHalfLatencies.sort((a, b) => a - b);

    const getP99 = (arr: number[]) => (arr.length > 0 ? arr[Math.floor(arr.length * 0.99)] : 0);
    const p99Overall = getP99(latencies);
    const p99FirstHalf = getP99(firstHalfLatencies);
    const p99SecondHalf = getP99(secondHalfLatencies);

    // TEID-30-T6 assertions: p99 latency stays under 200ms throughout with no upward trend
    expect(p99Overall).toBeLessThanOrEqual(200);
    expect(p99SecondHalf).toBeLessThanOrEqual(Math.max(p99FirstHalf * 2, p99FirstHalf + 50, 200));
  });

  // TEID-30-T5 / TEID-30-T7: Read-after-write balance / queryability lag under concurrent background load
  it("TEID-30-T5 / TEID-30-T7: event is queryable via GET /usage within 2,000ms of ack under concurrent background load", async () => {
    const rate = process.env.LOAD_TEST_EVENTS_PER_SEC ? parseInt(process.env.LOAD_TEST_EVENTS_PER_SEC, 10) : 500;
    const concurrency = Math.min(20, Math.max(2, Math.floor(rate / 50)));
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const markedCustomer = fx.tenant2.customerId;
    const markedApiKey = fx.tenant2.apiKey;

    let stopBackground = false;
    const bgWorkers = Promise.all(
      Array.from({ length: concurrency }, async (_, workerIdx) => {
        let counter = 0;
        while (!stopBackground) {
          counter++;
          await call(`${GO_USAGE_URL}/usage`, {
            method: "POST",
            apiKey: fx.tenant1.apiKey,
            body: {
              customer_id: fx.tenant1.customerId,
              event_type: "bg_load",
              quantity: 1,
              idempotency_key: `t5-bg-${runId}-w${workerIdx}-${counter}`,
            },
          }).catch(() => {});
        }
      })
    );

    // Allow background load to spin up brief moment
    await new Promise((r) => setTimeout(r, 200));

    // Submit marked event for tenant 2 customer
    const markedKey = `marked-event-${runId}`;
    const ackRes = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: markedApiKey,
      body: {
        customer_id: markedCustomer,
        event_type: "marked_metric",
        quantity: 100,
        idempotency_key: markedKey,
      },
    });

    const ackTime = Date.now();
    expect(ackRes.status).toBe(201);
    const markedId = ackRes.body.id;

    // Poll GET /usage every 100ms starting immediately after ack
    let visibleTime = -1;
    const pollDeadline = ackTime + 2000;

    while (Date.now() <= pollDeadline) {
      const getRes = await call(`${GO_USAGE_URL}/usage?customer_id=${markedCustomer}`, {
        apiKey: markedApiKey,
      });
      if (getRes.status === 200 && Array.isArray(getRes.body.data)) {
        const found = getRes.body.data.find((e: { id: string }) => e.id === markedId);
        if (found) {
          visibleTime = Date.now() - ackTime;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    stopBackground = true;
    await bgWorkers;

    // TEID-30-T5 & T7 assertion: lag from ack to queryability is under 2,000ms
    expect(visibleTime).toBeGreaterThanOrEqual(0);
    expect(visibleTime).toBeLessThan(2000);
  });
});
