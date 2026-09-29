import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call, type ApiResponse } from "./http.js";
import { opsSession, TENANT_ID } from "./session.js";

const STARTED = "2026-01-01T00:00:00Z";
const EXPIRES = "2030-01-01T00:00:00Z";
const BASE_INSTANT = Date.parse("2026-09-29T00:00:00Z");
const INSERT_CHUNK = 5_000;

interface SeedEvent {
  id: string;
  amount: number;
  occurredAt: string;
  idempotencyKey: string;
}

interface ReplayLine {
  grant_id: string | null;
  source_category: string;
  amount: number;
}

interface ReplayBody {
  consumptions: Array<{ id: string; lines: ReplayLine[] }>;
  grants: Array<{ grant_id: string; remaining_amount: number }>;
  totals: { commit_amount: number; overage_amount: number; overage_amount_due: number };
}

let token: string;
let sharedCustomerId: string;
let sharedEvents: SeedEvent[];
let sharedBaseline: string;
let hundredOrderSignatures: string[] = [];

beforeAll(async () => {
  token = await opsSession();
  sharedCustomerId = await createCustomer("teid-35-shared");
  await createGrant(sharedCustomerId, 20_000, "promotional");
  await createGrant(sharedCustomerId, 20_000, "paid");
  await createGrant(sharedCustomerId, 20_000, "commit", 0.0025);
  await createGrant(sharedCustomerId, 20_000, "goodwill");
  sharedEvents = makeEvents(5_000, BASE_INSTANT, (index) => 1 + (index % 5), "teid-35-shared");
  await seedEvents(sharedCustomerId, sharedEvents);
});

afterAll(() => pool.end());

async function createCustomer(label: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, label, `${label}-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
}

async function createGrant(
  customerId: string,
  amount: number,
  source: "paid" | "promotional" | "commit" | "goodwill",
  overageRate: number | null = null,
): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO grants (
         tenant_id, customer_id, amount, remaining_amount, unit, source,
         start_date, expiry_date, status, overage_rate
       ) VALUES ($1, $2, $3::numeric, $3::numeric, 'credits', $4, $5, $6, 'active', $7::numeric)
       RETURNING id`,
      [TENANT_ID, customerId, amount, source, STARTED, EXPIRES, overageRate],
    )).rows[0].id,
  );
}

function makeEvents(
  count: number,
  firstInstant: number,
  amountFor: (index: number) => number,
  prefix: string,
): SeedEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    amount: amountFor(index),
    occurredAt: new Date(firstInstant + index).toISOString(),
    idempotencyKey: `${prefix}-${index}-${randomUUID()}`,
  }));
}

async function seedEvents(customerId: string, events: readonly SeedEvent[]): Promise<void> {
  await withTenant(TENANT_ID, async (client) => {
    for (let offset = 0; offset < events.length; offset += INSERT_CHUNK) {
      const chunk = events.slice(offset, offset + INSERT_CHUNK);
      const ids = chunk.map((event) => event.id);
      const amounts = chunk.map((event) => event.amount);
      const occurred = chunk.map((event) => event.occurredAt);
      const keys = chunk.map((event) => event.idempotencyKey);
      await client.query(
        `INSERT INTO usage_events (
           id, tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at
         )
         SELECT seeded.id, $1, $2, 'credits', seeded.amount, seeded.idempotency_key, seeded.occurred_at
         FROM unnest($3::uuid[], $4::numeric[], $5::text[], $6::timestamptz[])
           AS seeded(id, amount, idempotency_key, occurred_at)`,
        [TENANT_ID, customerId, ids, amounts, keys, occurred],
      );
      await client.query(
        `INSERT INTO usage_consumptions (
           id, tenant_id, customer_id, requested_amount, unit, occurred_at
         )
         SELECT seeded.id, $1, $2, seeded.amount, 'credits', seeded.occurred_at
         FROM unnest($3::uuid[], $4::numeric[], $5::timestamptz[])
           AS seeded(id, amount, occurred_at)`,
        [TENANT_ID, customerId, ids, amounts, occurred],
      );
    }
  });
}

async function replay(customerId: string, ids: readonly string[]): Promise<ApiResponse<ReplayBody>> {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/consumption/replay-check`, {
    method: "POST",
    token,
    body: { event_ids: ids },
  });
}

function signature(response: ApiResponse<ReplayBody>): string {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return JSON.stringify(response.body);
}

function eventLines(response: ApiResponse<ReplayBody>, eventId: string): ReplayLine[] {
  const event = response.body.consumptions.find((candidate) => candidate.id === eventId);
  expect(event).toBeTruthy();
  return event!.lines;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [copy[index], copy[replacement]] = [copy[replacement], copy[index]];
  }
  return copy;
}

describe("TEID-35 timestamp-ordered consumption replay", () => {
  // TEID-35-T1 (Functional): the same realistic 5,000-event set produces a
  // byte-identical balance and invoice split through three arrival orders.
  it("TEID-35-T1 replays 5,000 events identically in three arrival orders", async () => {
    const ids = sharedEvents.map((event) => event.id);
    const orders = [ids, [...ids].reverse(), shuffled(ids, 0x35_01)];
    const signatures: string[] = [];
    for (const order of orders) signatures.push(signature(await replay(sharedCustomerId, order)));
    expect(new Set(signatures).size).toBe(1);
    sharedBaseline = signatures[0];
  });

  // TEID-35-T2 (Non-functional): 100 independent server-side shuffles stay
  // identical. A generous jitter allowance detects accumulating per-call
  // work while avoiding a wall-clock assertion on normal scheduler noise.
  it("TEID-35-T2 returns the same result for 100 shuffled 5,000-event replays without accumulating latency", async () => {
    const ids = sharedEvents.map((event) => event.id);
    const latencies: number[] = [];
    hundredOrderSignatures = [];
    for (let trial = 0; trial < 100; trial += 1) {
      const started = performance.now();
      const response = await replay(sharedCustomerId, shuffled(ids, 0x35_20 + trial));
      latencies.push(performance.now() - started);
      hundredOrderSignatures.push(signature(response));
    }
    expect(new Set(hundredOrderSignatures)).toEqual(new Set([sharedBaseline]));
    expect(latencies[99]).toBeLessThanOrEqual(Math.max(latencies[0] * 3, latencies[0] + 500));
  });

  // TEID-35-T3 (Functional): physical insertion is later event first, while
  // occurred_at gives the single commit draw to the earlier event.
  it("TEID-35-T3 gives the exhaustion draw to the earlier timestamp despite reverse insertion", async () => {
    const customerId = await createCustomer("teid-35-t3");
    const commitId = await createGrant(customerId, 100, "commit", 0.0025);
    const chronological = makeEvents(2, BASE_INSTANT + 100_000, () => 100, "teid-35-t3");
    await seedEvents(customerId, [...chronological].reverse());
    const response = await replay(customerId, [chronological[1].id, chronological[0].id]);
    expect(response.status).toBe(200);
    expect(eventLines(response, chronological[0].id)).toEqual([
      { grant_id: commitId, source_category: "commit", amount: 100 },
    ]);
    expect(eventLines(response, chronological[1].id)).toEqual([
      { grant_id: null, source_category: "overage", amount: 100 },
    ]);
  });

  // TEID-35-T4 (Functional): UUID lexical order is the documented tie-break
  // for events sharing exactly one occurred_at value.
  it("TEID-35-T4 breaks an exact timestamp tie by immutable event UUID", async () => {
    const customerId = await createCustomer("teid-35-t4");
    const commitId = await createGrant(customerId, 100, "commit", 0.0025);
    const [firstId, secondId] = [randomUUID(), randomUUID()].sort();
    const occurredAt = new Date(BASE_INSTANT + 200_000).toISOString();
    const events: SeedEvent[] = [
      { id: firstId, amount: 100, occurredAt, idempotencyKey: `teid-35-t4-a-${randomUUID()}` },
      { id: secondId, amount: 100, occurredAt, idempotencyKey: `teid-35-t4-b-${randomUUID()}` },
    ];
    await seedEvents(customerId, events);
    const forward = await replay(customerId, [firstId, secondId]);
    const reverse = await replay(customerId, [secondId, firstId]);
    expect(signature(forward)).toBe(signature(reverse));
    expect(eventLines(forward, firstId)).toEqual([
      { grant_id: commitId, source_category: "commit", amount: 100 },
    ]);
    expect(eventLines(forward, secondId)[0].source_category).toBe("overage");
  });

  // TEID-35-T5 (Adversarial): 50,000 events arrive in exact reverse time
  // order. Concurrent readers see the unchanged live grant snapshot because
  // replay is a pure computation inside a read-only diagnostic transaction.
  it("TEID-35-T5 matches forward replay for 50,000 reverse-chronological events without exposing partial state", async () => {
    const customerId = await createCustomer("teid-35-t5");
    await createGrant(customerId, 30_000, "paid");
    await createGrant(customerId, 10_000, "commit", 0.0025);
    const events = makeEvents(50_000, BASE_INSTANT + 300_000, () => 1, "teid-35-t5");
    await seedEvents(customerId, [...events].reverse());
    const initial = await grantBalances(customerId);
    const reverseRequest = replay(customerId, events.map((event) => event.id).reverse());
    const observed = await Promise.all(Array.from({ length: 10 }, () => grantBalances(customerId)));
    const reverse = await reverseRequest;
    for (const balances of observed) expect(balances).toEqual(initial);
    expect(await grantBalances(customerId)).toEqual(initial);
    const forward = await replay(customerId, events.map((event) => event.id));
    expect(signature(reverse)).toBe(signature(forward));
  });

  // TEID-35-T6 (Adversarial): 27 chronological events consume the commit;
  // shuffled physical position cannot move the boundary.
  it("TEID-35-T6 places a 50-event exhaustion boundary at event 27 by timestamp", async () => {
    const customerId = await createCustomer("teid-35-t6");
    await createGrant(customerId, 270, "commit", 0.0025);
    const events = makeEvents(50, BASE_INSTANT + 400_000, () => 10, "teid-35-t6");
    await seedEvents(customerId, shuffled(events, 0x35_60));
    const response = await replay(customerId, shuffled(events.map((event) => event.id), 0x35_61));
    expect(response.status).toBe(200);
    for (let index = 0; index < events.length; index += 1) {
      expect(eventLines(response, events[index].id)[0].source_category).toBe(index < 27 ? "commit" : "overage");
    }
    expect(response.body.totals.commit_amount).toBe(270);
    expect(response.body.totals.overage_amount).toBe(230);
  });

  // TEID-35-T7 (Adversarial): the existing usage_events uniqueness rule
  // rejects the injected duplicate before it can create a consumption row;
  // ten post-attempt replays still match T2's other ninety orderings.
  it("TEID-35-T7 rejects an injected duplicate and preserves all replay balances", async () => {
    const original = sharedEvents[2_500];
    await expect(withTenant(TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO usage_events (
           id, tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at
         ) VALUES ($1, $2, $3, 'credits', $4::numeric, $5, $6::timestamptz)`,
        [randomUUID(), TENANT_ID, sharedCustomerId, original.amount, original.idempotencyKey, original.occurredAt],
      );
    })).rejects.toMatchObject({ code: "23505" });

    const duplicateRows = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM usage_events
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT_ID, original.idempotencyKey],
      )).rows[0].count,
    );
    expect(Number(duplicateRows)).toBe(1);

    const ids = sharedEvents.map((event) => event.id);
    const afterDuplicate: string[] = [];
    for (let trial = 0; trial < 10; trial += 1) {
      afterDuplicate.push(signature(await replay(sharedCustomerId, shuffled(ids, 0x35_70 + trial))));
    }
    expect(new Set([...hundredOrderSignatures.slice(0, 90), ...afterDuplicate])).toEqual(new Set([sharedBaseline]));
  });
});

async function grantBalances(customerId: string): Promise<Array<{ id: string; remaining: number }>> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string; remaining_amount: string }>(
      `SELECT id, remaining_amount::text AS remaining_amount
       FROM grants WHERE customer_id = $1 ORDER BY id`,
      [customerId],
    )).rows.map((row) => ({ id: row.id, remaining: Number(row.remaining_amount) })),
  );
}
