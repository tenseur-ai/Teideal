import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  createCustomer,
  insertUsageEvents,
  removeCustomers,
  setBillingConfig,
  superPool,
  withTenant,
} from "./db.js";
import { GO_USAGE_URL, TS_CONSOLE_URL, loadFixtures } from "./env.js";
import { call } from "./http.js";
import { ownerSession, supportSession, TENANT_ID } from "./session.js";

const fixtures = loadFixtures();
const API_KEY = fixtures.tenant1.apiKey;
const createdCustomers: string[] = [];

const TIMELINE_TYPES = [
  "grant",
  "usage_bucket",
  "reservation",
  "adjustment",
  "charge",
  "config_change",
] as const;

interface TimelineEntry {
  type: string;
  occurred_at: string;
  id: string;
  event_type?: string;
  count?: number;
  events?: unknown;
  expandable?: boolean;
  transaction_id?: string;
  hour?: string;
  actor_api_key_id?: string | null;
  after?: unknown;
}

interface TimelineResponse {
  entries: TimelineEntry[];
  next_cursor: string | null;
}

let supportToken: string;
let ownerToken: string;

beforeAll(async () => {
  supportToken = await supportSession();
  ownerToken = await ownerSession();
});

afterAll(async () => {
  await removeCustomers(createdCustomers);
  await Promise.all([appPool.end(), superPool.end()]);
});

async function trackedCustomer(name: string, parentId?: string): Promise<string> {
  const id = await createCustomer(TENANT_ID, name, parentId);
  createdCustomers.push(id);
  return id;
}

async function issueGrant(customerId: string): Promise<void> {
  const res = await call(`${TS_CONSOLE_URL}/grants`, {
    method: "POST",
    token: ownerToken,
    body: {
      customer_id: customerId,
      amount: 100,
      unit: "USD",
      source: "promotional",
      start_date: "2026-01-01T00:00:00Z",
    },
  });
  expect(res.status).toBe(201);
}

async function postUsage(body: Record<string, unknown>) {
  return call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: API_KEY, body });
}

async function postReservation(customerId: string, usageEventId?: string) {
  return call(`${GO_USAGE_URL}/reservations`, {
    method: "POST",
    apiKey: API_KEY,
    body: { customer_id: customerId, ...(usageEventId ? { usage_event_id: usageEventId } : {}) },
  });
}

async function postLedger(customerId: string, opts: {
  amount: string;
  description: string;
  usageEventId?: string;
  account?: string;
}) {
  return call(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    apiKey: API_KEY,
    body: {
      customer_id: customerId,
      description: opts.description,
      usage_event_id: opts.usageEventId,
      lines: [
        { account_code: "receivable", direction: "debit", amount: opts.amount },
        { account_code: opts.account ?? "overage", direction: "credit", amount: opts.amount },
      ],
    },
  });
}

function monthsAgo(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15, 10, 0, 0));
}

function hourAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

function timelineUrl(customerId: string, query: Record<string, string | undefined> = {}): string {
  const url = new URL(`${TS_CONSOLE_URL}/customers/${customerId}/timeline`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

describe("TEID-45 customer timeline", () => {
  // TEID-45-T1 (Functional): one chronological view with all six source types,
  // usage grouped into usage_bucket entries rather than raw events.
  it("TEID-45-T1 returns grants, hourly usage buckets, reservations, adjustments, charges and config changes", async () => {
    const customerId = await trackedCustomer("teid-45-t1-acct-4004");
    await setBillingConfig(TENANT_ID, customerId);
    await issueGrant(customerId);

    const hours = [hourAgo(2), hourAgo(1), hourAgo(0)];
    const createdEvents = [];
    for (const occurredAt of hours) {
      const res = await postUsage({
        customer_id: customerId,
        event_type: "tokens.in",
        quantity: 3,
        idempotency_key: randomUUID(),
        occurred_at: occurredAt,
      });
      expect(res.status).toBe(201);
      createdEvents.push(res.body);
    }

    const reservation = await postReservation(customerId, createdEvents[0].id);
    expect(reservation.status).toBe(201);

    const late = await postUsage({
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: 1,
      idempotency_key: randomUUID(),
      occurred_at: monthsAgo(2).toISOString(),
    });
    expect(late.status).toBe(202);

    const charge = await postLedger(customerId, {
      amount: "12.50",
      description: "overage",
      usageEventId: createdEvents[1].id,
    });
    expect(charge.status).toBe(201);

    const patched = await call(`${TS_CONSOLE_URL}/customers/${customerId}`, {
      method: "PATCH",
      apiKey: API_KEY,
      body: { name: "teid-45-t1-renamed" },
    });
    expect(patched.status).toBe(200);

    const res = await call(timelineUrl(customerId), { token: supportToken });
    expect(res.status).toBe(200);
    const body = res.body as TimelineResponse;
    const types = new Set(body.entries.map((e) => e.type));
    for (const type of TIMELINE_TYPES) {
      expect(types.has(type), `missing timeline type ${type}`).toBe(true);
    }
    const usage = body.entries.filter((e) => e.type === "usage_bucket");
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage.every((e) => e.type === "usage_bucket")).toBe(true);
    const occurred = body.entries.map((e) => Date.parse(e.occurred_at));
    const sorted = [...occurred].sort((a, b) => b - a);
    expect(occurred).toEqual(sorted);
  });

  // TEID-45-T2 (Functional): date/metric/team filters actually narrow; a
  // seeded non-matching event is absent. model has no backing column on
  // usage_events (NOTES-TEID-45.md); api_key_id applies to config_change rows.
  it("TEID-45-T2 applies date, metric, team and api_key filters and excludes non-matching events", async () => {
    const orgId = await trackedCustomer("teid-45-t2-org");
    const teamId = await trackedCustomer("platform-eng", orgId);
    const otherTeamId = await trackedCustomer("other-team", orgId);
    await setBillingConfig(TENANT_ID, teamId);
    await setBillingConfig(TENANT_ID, otherTeamId);

    const inRange = new Date("2026-08-05T12:00:00.000Z");
    const outOfRange = new Date("2026-09-05T12:00:00.000Z");
    await insertUsageEvents({
      tenantId: TENANT_ID, customerId: teamId, eventType: "tokens.in",
      count: 4, occurredAt: inRange, keyPrefix: `t2-match-${randomUUID()}-`, hourSpread: 2,
    });
    await insertUsageEvents({
      tenantId: TENANT_ID, customerId: teamId, eventType: "images.out",
      count: 3, occurredAt: inRange, keyPrefix: `t2-metric-${randomUUID()}-`, hourSpread: 1,
    });
    await insertUsageEvents({
      tenantId: TENANT_ID, customerId: teamId, eventType: "tokens.in",
      count: 3, occurredAt: outOfRange, keyPrefix: `t2-date-${randomUUID()}-`, hourSpread: 1,
    });
    await insertUsageEvents({
      tenantId: TENANT_ID, customerId: otherTeamId, eventType: "tokens.in",
      count: 3, occurredAt: inRange, keyPrefix: `t2-team-${randomUUID()}-`, hourSpread: 1,
    });

    const key = await call(`${TS_CONSOLE_URL}/api-keys`, {
      method: "POST",
      token: ownerToken,
      body: { scope: "read-only", environment: "sandbox", label: "key_789", customer_id: teamId },
    });
    expect(key.status).toBe(201);
    const otherKey = await call(`${TS_CONSOLE_URL}/api-keys`, {
      method: "POST",
      token: ownerToken,
      body: { scope: "read-only", environment: "sandbox", label: "other-key", customer_id: teamId },
    });
    expect(otherKey.status).toBe(201);
    await withTenant(TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO audit_log (
           tenant_id, occurred_at, actor_api_key_id, event_type, object_type, object_id, customer_id, before, after
         ) VALUES
           ($1, '2026-08-06T00:00:00Z', $2, 'config_change', 'Customer', $3::text, $4::uuid, '{}'::jsonb, '{"ok":true}'::jsonb),
           ($1, '2026-08-06T01:00:00Z', $5, 'config_change', 'Customer', $3::text, $4::uuid, '{}'::jsonb, '{"other":true}'::jsonb)`,
        [TENANT_ID, key.body.id, teamId, teamId, otherKey.body.id],
      );
    });

    const res = await call(
      timelineUrl(orgId, {
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-16T00:00:00Z",
        metric: "tokens",
        model: "gpt-4-class",
        team: "platform-eng",
        api_key_id: key.body.id,
      }),
      { token: supportToken },
    );
    expect(res.status).toBe(200);
    const body = res.body as TimelineResponse;
    expect(body.entries.length).toBeGreaterThan(0);

    const usage = body.entries.filter((e) => e.type === "usage_bucket");
    expect(usage.length).toBeGreaterThan(0);
    for (const entry of usage) {
      expect(entry.event_type === "tokens" || entry.event_type?.startsWith("tokens.")).toBe(true);
      const at = Date.parse(entry.occurred_at);
      expect(at).toBeGreaterThanOrEqual(Date.parse("2026-08-01T00:00:00Z"));
      expect(at).toBeLessThan(Date.parse("2026-08-16T00:00:00Z"));
    }
    expect(usage.some((e) => e.event_type?.startsWith("images"))).toBe(false);

    const configs = body.entries.filter((e) => e.type === "config_change");
    expect(configs.every((e) => e.actor_api_key_id === key.body.id || !e.actor_api_key_id)).toBe(true);
    expect(configs.some((e) => (e.after as { other?: boolean } | undefined)?.other === true)).toBe(false);
  });

  // TEID-45-T3 (Functional): drill-down from a charge (invoice-line stand-in)
  // returns ledger lines summing to the seeded amount and the originating event.
  it("TEID-45-T3 drills down from a charge to the ledger lines and usage event that sum to $342.18", async () => {
    const customerId = await trackedCustomer("teid-45-t3");
    const usage = await postUsage({
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: 42,
      idempotency_key: randomUUID(),
    });
    expect(usage.status).toBe(201);

    const posted = await postLedger(customerId, {
      amount: "342.18",
      description: "overage charges",
      usageEventId: usage.body.id,
    });
    expect(posted.status).toBe(201);

    const res = await call(
      `${TS_CONSOLE_URL}/customers/${customerId}/timeline/charges/${posted.body.id}`,
      { token: supportToken },
    );
    expect(res.status).toBe(200);
    const lines = res.body.lines as Array<{ account_code: string; direction: string; amount: number | string }>;
    expect(Array.isArray(lines)).toBe(true);
    const overage = lines
      .filter((line) => line.account_code === "overage")
      .reduce((sum, line) => sum + Number(line.amount), 0);
    expect(overage).toBeCloseTo(342.18, 2);
    expect(res.body.usage_event.id).toBe(usage.body.id);
    expect(res.body.usage_event.customer_id).toBe(customerId);
    expect(res.body.usage_event.quantity).toBe(42);
  });

  // TEID-45-T4 (Functional): 1,000,000 usage events, timeline under 3s, buckets present.
  it("TEID-45-T4 loads a 1,000,000-event customer timeline in under 3 seconds", async () => {
    const customerId = await trackedCustomer("teid-45-t4");
    await insertUsageEvents({
      tenantId: TENANT_ID,
      customerId,
      eventType: "tokens.in",
      count: 1_000_000,
      occurredAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0)),
      keyPrefix: `t4-${randomUUID()}-`,
      hourSpread: 24,
    });

    const started = performance.now();
    const res = await call(timelineUrl(customerId), { token: supportToken });
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    const body = res.body as TimelineResponse;
    const usage = body.entries.filter((e) => e.type === "usage_bucket");
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some((e) => Number(e.count) > 1)).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  }, 180_000);

  // TEID-45-T5 (Non-functional): 5,000,000 events degrade via pagination or
  // pre-aggregated buckets rather than enumerating every event.
  it("TEID-45-T5 paginates or pre-aggregates a 5,000,000-event customer rather than timing out", async () => {
    const count = Number(process.env.TEID_45_T5_EVENT_COUNT ?? 5_000_000);
    const customerId = await trackedCustomer("teid-45-t5");
    await insertUsageEvents({
      tenantId: TENANT_ID,
      customerId,
      eventType: "tokens.in",
      count,
      occurredAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0)),
      keyPrefix: `t5-${randomUUID()}-`,
      hourSpread: 168,
    });

    const res = await call(timelineUrl(customerId, { limit: "50" }), { token: supportToken });
    expect(res.status).toBe(200);
    const body = res.body as TimelineResponse;
    expect(body.entries.length).toBeLessThanOrEqual(50);
    const usage = body.entries.filter((e) => e.type === "usage_bucket");
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((e) => !Array.isArray(e.events) || (e.events as unknown[]).length < count)).toBe(true);
    expect(body.next_cursor !== null || usage.every((e) => Number(e.count) > 1)).toBe(true);
  }, 600_000);

  // TEID-45-T6 (Non-functional): large usage_bucket entries do not inline every
  // event; the expand endpoint returns only that hour's events. No console UI
  // harness exists in this repo, so the collapsed-by-default click/no-reload
  // assertion is deferred to a future console E2E suite.
  it("TEID-45-T6 omits the full per-event array from large buckets and expands via a second call", async () => {
    const customerId = await trackedCustomer("teid-45-t6");
    const hour = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 10, 15, 0, 0));
    await insertUsageEvents({
      tenantId: TENANT_ID,
      customerId,
      eventType: "tokens.in",
      count: 80,
      occurredAt: hour,
      keyPrefix: `t6-${randomUUID()}-`,
      hourSpread: 1,
    });

    const res = await call(timelineUrl(customerId), { token: supportToken });
    expect(res.status).toBe(200);
    const bucket = (res.body as TimelineResponse).entries.find(
      (e) => e.type === "usage_bucket" && e.event_type === "tokens.in" && Number(e.count) >= 80,
    );
    expect(bucket).toBeTruthy();
    expect(bucket!.events === undefined || (Array.isArray(bucket!.events) && bucket!.events.length < 80)).toBe(true);

    const expand = await call(
      `${TS_CONSOLE_URL}/customers/${customerId}/timeline/usage-bucket?hour=${encodeURIComponent(new Date(hour).toISOString())}&event_type=tokens.in`,
      { token: supportToken },
    );
    expect(expand.status).toBe(200);
    expect(expand.body.event_type).toBe("tokens.in");
    expect(Array.isArray(expand.body.events)).toBe(true);
    expect(expand.body.events.length).toBeGreaterThan(0);
    expect(expand.body.events.every((e: { event_type: string }) => e.event_type === "tokens.in")).toBe(true);
    const start = Date.parse(new Date(hour).toISOString());
    const end = start + 60 * 60 * 1000;
    expect(expand.body.events.every((e: { occurred_at: string }) => {
      const at = Date.parse(e.occurred_at);
      return at >= start && at < end;
    })).toBe(true);
  });

  // TEID-45-T7 (Adversarial): a 5-year unfiltered range paginates (or 400s)
  // rather than hanging or 500ing. Bound at 10s.
  it("TEID-45-T7 paginates a 5-year range instead of hanging or returning 500", async () => {
    const customerId = await trackedCustomer("teid-45-t7");
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - 5);
    await insertUsageEvents({
      tenantId: TENANT_ID,
      customerId,
      eventType: "tokens.in",
      count: 400,
      occurredAt: start,
      keyPrefix: `t7-${randomUUID()}-`,
      hourSpread: 400,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: { status: number; body: any };
    try {
      const started = performance.now();
      const response = await fetch(timelineUrl(customerId, { since: start.toISOString(), limit: "50" }), {
        headers: { Authorization: `Bearer ${supportToken}` },
        signal: controller.signal,
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(10_000);
      const text = await response.text();
      res = { status: response.status, body: text ? JSON.parse(text) : null };
    } catch (err) {
      expect((err as Error).name, "TEID-45-T7 timed out rather than paginating").not.toBe("AbortError");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    expect(res.status).not.toBe(500);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.entries.length).toBeLessThanOrEqual(50);
      expect(res.body.next_cursor === null || typeof res.body.next_cursor === "string").toBe(true);
    } else {
      expect(typeof res.body.error).toBe("string");
    }
  });

  // TEID-45-T8 (Adversarial): a key scoped to customer B cannot drill into
  // customer A's ledger transaction. Explicit handler check, not RLS alone.
  it("TEID-45-T8 denies drill-down into another customer's charge and leaks no ledger lines", async () => {
    const ownerCustomer = await trackedCustomer("teid-45-t8-acct-4004");
    const scopedCustomer = await trackedCustomer("teid-45-t8-acct-5005");
    const usage = await postUsage({
      customer_id: ownerCustomer,
      event_type: "tokens.in",
      quantity: 9,
      idempotency_key: randomUUID(),
    });
    expect(usage.status).toBe(201);
    const posted = await postLedger(ownerCustomer, {
      amount: "10.00",
      description: "foreign charge",
      usageEventId: usage.body.id,
    });
    expect(posted.status).toBe(201);

    const key = await call(`${TS_CONSOLE_URL}/api-keys`, {
      method: "POST",
      token: ownerToken,
      body: {
        scope: "read-only",
        environment: "sandbox",
        label: `t8-scoped-${randomUUID()}`,
        customer_id: scopedCustomer,
      },
    });
    expect(key.status).toBe(201);

    const res = await call(`${GO_USAGE_URL}/ledger/transactions/${posted.body.id}/detail`, {
      apiKey: key.body.key,
    });
    expect([403, 404]).toContain(res.status);
    const serialized = JSON.stringify(res.body ?? {});
    expect(serialized).not.toContain("ledger_lines");
    expect(res.body?.lines).toBeUndefined();
    expect(res.body?.usage_event).toBeUndefined();
    expect(res.body?.usage_event?.id).toBeUndefined();
    expect(serialized).not.toContain(usage.body.id);
  });
});
