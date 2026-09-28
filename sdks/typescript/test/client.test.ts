import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeidealClient, TeidealError, TeidealValidationError, type Logger } from "../src/index.js";

const CUSTOMER_ID = "00000000-0000-4000-8000-000000000001";

class CapturingLogger implements Logger {
  records: Array<{ level: string; args: unknown[] }> = [];
  debug(...args: unknown[]): void { this.records.push({ level: "debug", args }); }
  info(...args: unknown[]): void { this.records.push({ level: "info", args }); }
  warn(...args: unknown[]): void { this.records.push({ level: "warn", args }); }
  error(...args: unknown[]): void { this.records.push({ level: "error", args }); }
}

function pathFor(name = "buffer.ndjson"): string {
  return join(mkdtempSync(join(tmpdir(), "teideal-node-")), name);
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("TeidealClient", () => {
  it("TEID-59-T2 retries three times with the identical idempotency key", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length < 3) return response(500, { error: "down" });
      return response(201, { id: "event-1", idempotency_key: requests[0].idempotency_key });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logger = new CapturingLogger();
    const client = new TeidealClient("http://unused", "key", logger, pathFor(), { retryBackoffs: [0, 0] });

    const result = await client.sendEvent(CUSTOMER_ID, "api.call", 1);

    expect(result.id).toBe("event-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(requests.map((request) => request.idempotency_key)).size).toBe(1);
    expect(logger.records.some((record) => record.level === "warn" && record.args[0] === "Teideal send retry attempt")).toBe(true);
    client.close();
  });

  it("best effort resolves, preserves the billing call, and logs failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(500, { error: "down" })));
    const logger = new CapturingLogger();
    const client = new TeidealClient("http://unused", "key", logger, pathFor(), { retryBackoffs: [0, 0] });
    const billingCalls: string[] = [];

    client.sendEventBestEffort(CUSTOMER_ID, "api.call", 1);
    billingCalls.push("succeeded");

    expect(billingCalls).toEqual(["succeeded"]);
    await eventually(() => logger.records.some((record) => record.level === "error"));
    expect(logger.records.some((record) => record.level === "error" && record.args[0] === "Teideal best-effort send failed")).toBe(true);
    client.close();
  });

  it.each([["not-a-uuid", "api.call"], [CUSTOMER_ID, ""]])(
    "TEID-59-T9 rejects malformed events before network or journal writes",
    async (customerId, eventType) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const bufferPath = pathFor();
      const client = new TeidealClient("http://unused", "key", console, bufferPath);
      await expect(client.sendEvent(customerId, eventType, 1)).rejects.toBeInstanceOf(TeidealValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readFileSync(bufferPath, "utf8")).toBe("");
      client.close();
    },
  );

  it("recovers a durable event after restart with its original key", async () => {
    const bufferPath = pathFor();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const first = new TeidealClient("http://offline", "key", console, bufferPath, { retryBackoffs: [0, 0], flushInterval: 3_600_000 });
    await expect(first.sendEvent(CUSTOMER_ID, "api.call", 1)).rejects.toBeInstanceOf(TeidealError);
    first.close();
    const stored = JSON.parse(readFileSync(bufferPath, "utf8").trim()) as { idempotencyKey: string };

    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(payload);
      return response(200, { status: "duplicate", id: "event-1", idempotency_key: payload.idempotency_key });
    }));
    const second = new TeidealClient("http://reachable", "key", console, bufferPath, {
      retryBackoffs: [0, 0], compactionThreshold: 1,
    });
    await second.flush();

    expect(requests[0].idempotency_key).toBe(stored.idempotencyKey);
    expect(readFileSync(bufferPath, "utf8")).toBe("");
    second.close();
  });

  it("TEID-59-T7 logs retry and buffer-flush activity", async () => {
    const logger = new CapturingLogger();
    const bufferPath = pathFor();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const first = new TeidealClient("http://offline", "key", logger, bufferPath, { retryBackoffs: [0, 0], flushInterval: 3_600_000 });
    first.sendEventBestEffort(CUSTOMER_ID, "api.call", 1);
    await eventually(() => logger.records.some((record) => record.level === "error"));
    first.close();

    vi.stubGlobal("fetch", vi.fn(async () => response(201, { id: "event-1" })));
    const second = new TeidealClient("http://reachable", "key", logger, bufferPath, { retryBackoffs: [0, 0], compactionThreshold: 1 });
    await second.flush();
    expect(logger.records.some((record) => record.level === "warn" && record.args[0] === "Teideal send retry attempt")).toBe(true);
    expect(logger.records.some((record) => record.level === "info" && String(record.args[0]).includes("buffer flush"))).toBe(true);
    second.close();
  });

  it("TEID-59-T4 best effort flushes automatically after recovery", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(payload);
      if (requests.length <= 3) return response(500, { error: "offline" });
      return response(201, { id: "event-1", idempotency_key: payload.idempotency_key });
    }));
    const bufferPath = pathFor();
    const client = new TeidealClient("http://recovering", "key", console, bufferPath, {
      retryBackoffs: [0, 0], flushInterval: 10, compactionThreshold: 1,
    });
    client.sendEventBestEffort(CUSTOMER_ID, "api.call", 1);

    await eventually(() => requests.length >= 4 && readFileSync(bufferPath, "utf8") === "");
    expect(new Set(requests.map((request) => request.idempotency_key)).size).toBe(1);
    client.close();
  });
});

async function eventually(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before timeout");
}
