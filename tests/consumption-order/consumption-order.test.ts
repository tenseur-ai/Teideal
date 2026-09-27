import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { TENANT_ID, opsSession } from "./session.js";

const AS_OF = "2026-09-27T12:00:00Z";
const STARTED = "2026-01-01T00:00:00Z";
const ORDER_ERROR = "consumption_order must be a permutation of promotional, paid, commit, goodwill";
const SOURCES = ["promotional", "paid", "commit", "goodwill"] as const;

let opsToken: string;

beforeAll(async () => {
  opsToken = await opsSession();
});
afterAll(() => pool.end());

interface Line {
  grant_id: string | null;
  source_category: string;
  amount: number;
}

async function createCustomer(label: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, label, `${label}-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
}

async function issueGrant(customerId: string, body: Record<string, unknown>) {
  const response = await call(`${TS_CONSOLE_URL}/grants`, {
    method: "POST",
    token: opsToken,
    body: { customer_id: customerId, unit: "credits", start_date: STARTED, ...body },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string };
}

function consume(customerId: string, amount: number) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/consume`, {
    method: "POST",
    token: opsToken,
    body: { amount, unit: "credits", as_of: AS_OF },
  });
}

function putOrder(customerId: string, consumptionOrder: string[]) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/consumption-order`, {
    method: "PUT",
    token: opsToken,
    body: { consumption_order: consumptionOrder },
  });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap];
    copy[swap] = current;
  }
  return copy;
}

describe("TEID-18 credit consumption order", () => {
  // TEID-18-T1 (Functional): default order is soonest promotional, then the
  // later promotional grant, then paid, then commit.
  it("TEID-18-T1 draws promotional credits by soonest expiry, then paid, then commit", async () => {
    const customerId = await createCustomer("teid-18-t1");
    const promo5 = await issueGrant(customerId, {
      amount: 100, source: "promotional", expiry_date: "2026-10-02T12:00:00Z",
    });
    const promo20 = await issueGrant(customerId, {
      amount: 100, source: "promotional", expiry_date: "2026-10-17T12:00:00Z",
    });
    const paid = await issueGrant(customerId, {
      amount: 100, source: "paid", expiry_date: "2027-03-01T00:00:00Z",
    });
    const commit = await issueGrant(customerId, {
      amount: 100, source: "commit", expiry_date: "2027-06-01T00:00:00Z",
    });

    const consumed = await consume(customerId, 400);
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toEqual([
      { grant_id: promo5.id, source_category: "promotional", amount: 100 },
      { grant_id: promo20.id, source_category: "promotional", amount: 100 },
      { grant_id: paid.id, source_category: "paid", amount: 100 },
      { grant_id: commit.id, source_category: "commit", amount: 100 },
    ]);

    const remaining = await call(`${TS_CONSOLE_URL}/grants/${commit.id}`, { token: opsToken });
    expect(remaining.body.remaining_amount).toBe(0);
  });

  // TEID-18-T2 (Functional): a customer override of paid-before-promotional
  // draws the paid grant first. A goodwill grant is included so the override
  // names only sources this customer actually holds; see NOTES-TEID-18.md.
  it("TEID-18-T2 consumes paid credits first after a customer override", async () => {
    const customerId = await createCustomer("teid-18-t2");
    const before = await call(`${TS_CONSOLE_URL}/customers/${customerId}/consumption-order`, { token: opsToken });
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ consumption_order: null });

    const rejected = await putOrder(customerId, ["paid", "promotional"]);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: ORDER_ERROR });

    const order = ["paid", "promotional", "commit", "goodwill"];
    const saved = await putOrder(customerId, order);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ consumption_order: order });
    const stored = await call(`${TS_CONSOLE_URL}/customers/${customerId}/consumption-order`, { token: opsToken });
    expect(stored.body).toEqual({ consumption_order: order });

    const promo5 = await issueGrant(customerId, {
      amount: 100, source: "promotional", expiry_date: "2026-10-02T12:00:00Z",
    });
    const promo20 = await issueGrant(customerId, {
      amount: 100, source: "promotional", expiry_date: "2026-10-17T12:00:00Z",
    });
    const paid = await issueGrant(customerId, {
      amount: 100, source: "paid", expiry_date: "2027-03-01T00:00:00Z",
    });
    const commit = await issueGrant(customerId, {
      amount: 100, source: "commit", expiry_date: "2027-06-01T00:00:00Z",
    });
    await issueGrant(customerId, {
      amount: 100, source: "goodwill", expiry_date: "2028-01-01T00:00:00Z",
    });

    const consumed = await consume(customerId, 400);
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toEqual([
      { grant_id: paid.id, source_category: "paid", amount: 100 },
      { grant_id: promo5.id, source_category: "promotional", amount: 100 },
      { grant_id: promo20.id, source_category: "promotional", amount: 100 },
      { grant_id: commit.id, source_category: "commit", amount: 100 },
    ]);

    const audit = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ before: { consumption_order?: string[] } | null; after: { consumption_order: string[] } }>(
        `SELECT before, after FROM audit_log
         WHERE object_type = 'CustomerConsumptionOverride' AND customer_id = $1
         ORDER BY occurred_at DESC LIMIT 1`,
        [customerId],
      )).rows[0],
    );
    expect(audit.before).toBeNull();
    expect(audit.after.consumption_order).toEqual(order);
  });

  // TEID-18-T3 (Functional): five customers start from the same grant set.
  // A 10000-unit draw produces the same per-grant breakdown on every replay.
  // Grant UUIDs differ per customer, so the comparison is slot, source, and amount.
  it("TEID-18-T3 replays a 10000-unit draw identically across five customers", async () => {
    const specs = [
      { slot: 0, amount: 3000, source: "promotional", expiry_date: "2026-10-02T12:00:00Z" },
      { slot: 1, amount: 2500, source: "promotional", expiry_date: "2026-10-17T12:00:00Z" },
      { slot: 2, amount: 4000, source: "paid", expiry_date: "2027-06-01T00:00:00Z" },
      { slot: 3, amount: 2000, source: "commit", expiry_date: "2027-12-01T00:00:00Z" },
    ];
    const breakdowns: string[] = [];
    for (let replica = 0; replica < 5; replica += 1) {
      const customerId = await createCustomer(`teid-18-t3-${replica}`);
      const slots = new Map<string, number>();
      for (const spec of specs) {
        const grant = await issueGrant(customerId, spec);
        slots.set(grant.id, spec.slot);
      }
      const consumed = await consume(customerId, 10000);
      expect(consumed.status).toBe(201);
      const breakdown = (consumed.body.lines as Line[]).map((line) => ({
        slot: slots.get(line.grant_id as string),
        source_category: line.source_category,
        amount: line.amount,
      }));
      breakdowns.push(JSON.stringify(breakdown));
    }
    expect(breakdowns).toEqual([
      JSON.stringify([
        { slot: 0, source_category: "promotional", amount: 3000 },
        { slot: 1, source_category: "promotional", amount: 2500 },
        { slot: 2, source_category: "paid", amount: 4000 },
        { slot: 3, source_category: "commit", amount: 500 },
      ]),
      ...Array(4).fill(breakdowns[0]),
    ]);
    expect(new Set(breakdowns).size).toBe(1);
  });

  // TEID-18-T4 (Functional): 150 credits split into 100 from grant A and 50
  // from grant B, both stored as consumption lines.
  it("TEID-18-T4 splits one usage event into two grant lines", async () => {
    const customerId = await createCustomer("teid-18-t4");
    const grantA = await issueGrant(customerId, {
      amount: 100, source: "paid", expiry_date: "2026-11-01T00:00:00Z",
    });
    const grantB = await issueGrant(customerId, {
      amount: 80, source: "paid", expiry_date: "2026-12-01T00:00:00Z",
    });
    const consumed = await consume(customerId, 150);
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toEqual([
      { grant_id: grantA.id, source_category: "paid", amount: 100 },
      { grant_id: grantB.id, source_category: "paid", amount: 50 },
    ]);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ grant_id: string; source_category: string; amount: string }>(
        `SELECT grant_id, source_category, amount::text AS amount
         FROM usage_consumption_lines
         WHERE consumption_id = $1
         ORDER BY id`,
        [consumed.body.id],
      )).rows,
    );
    expect(stored).toHaveLength(2);
    expect(stored.map((line) => ({ grant_id: line.grant_id, source_category: line.source_category, amount: Number(line.amount) }))).toEqual([
      { grant_id: grantA.id, source_category: "paid", amount: 100 },
      { grant_id: grantB.id, source_category: "paid", amount: 50 },
    ]);
  });

  // TEID-18-T5 (Functional): the customer timeline lists both lines of one
  // mixed-grant usage event with the amounts taken from each grant.
  it("TEID-18-T5 lists both grants and amounts on the customer timeline", async () => {
    const customerId = await createCustomer("teid-18-t5");
    const grantA = await issueGrant(customerId, {
      amount: 100, source: "paid", expiry_date: "2026-11-01T00:00:00Z",
    });
    const grantB = await issueGrant(customerId, {
      amount: 80, source: "paid", expiry_date: "2026-12-01T00:00:00Z",
    });
    const consumed = await consume(customerId, 150);
    expect(consumed.status).toBe(201);

    const timeline = await call(`${TS_CONSOLE_URL}/customers/${customerId}/consumption-timeline`, { token: opsToken });
    expect(timeline.status).toBe(200);
    const event = timeline.body.data.find((row: { id: string }) => row.id === consumed.body.id);
    expect(event).toBeTruthy();
    expect(event.requested_amount).toBe(150);
    expect(event.unit).toBe("credits");
    expect(event.lines).toEqual([
      { grant_id: grantA.id, source_category: "paid", amount: 100 },
      { grant_id: grantB.id, source_category: "paid", amount: 50 },
    ]);
  });

  // TEID-18-T6 (Non-functional): catalog target is 1000 grant sets replayed
  // 50 times each (50,000 consumes). CI defaults are
  // CONSUMPTION_ORDER_FUZZ_SETS=20 and CONSUMPTION_ORDER_FUZZ_REPLICAS=5.
  // A dedicated run sets those back to 1000 and 50.
  it("TEID-18-T6 produces identical draws for every replay of a randomized grant set", async () => {
    const sets = Number(process.env.CONSUMPTION_ORDER_FUZZ_SETS ?? 20);
    const replicas = Number(process.env.CONSUMPTION_ORDER_FUZZ_REPLICAS ?? 5);
    for (let setIndex = 0; setIndex < sets; setIndex += 1) {
      const rand = mulberry32(0x18a0 + setIndex);
      const grantCount = 1 + Math.floor(rand() * 6);
      const grants: Array<{ source: string; amount: number; expiry: string | null; createdAt: string }> = [];
      let total = 0;
      for (let index = 0; index < grantCount; index += 1) {
        const source = SOURCES[Math.floor(rand() * SOURCES.length)];
        const amount = 1 + Math.floor(rand() * 400);
        const expiry = rand() < 0.25
          ? null
          : new Date(Date.UTC(2026, 9, 1 + Math.floor(rand() * 80), 0, 0, index)).toISOString();
        grants.push({
          source,
          amount,
          expiry,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        });
        total += amount;
      }
      const amount = rand() < 0.5 ? Math.max(1, Math.floor(total * rand())) : total + 1 + Math.floor(rand() * 40);
      const override = rand() < 0.5 ? shuffle(SOURCES, rand) : null;

      const seeded: Array<{ customerId: string; slots: Map<string, number> }> = [];
      for (let replica = 0; replica < replicas; replica += 1) {
        const customerId = await createCustomer(`teid-18-t6-${setIndex}-${replica}`);
        const slots = new Map<string, number>();
        await withTenant(TENANT_ID, async (client) => {
          for (let index = 0; index < grants.length; index += 1) {
            const grant = grants[index];
            const inserted = (await client.query<{ id: string }>(
              `INSERT INTO grants (
                 tenant_id, customer_id, amount, remaining_amount, unit, source,
                 start_date, expiry_date, status, created_at
               ) VALUES ($1, $2, $3::numeric, $3::numeric, 'credits', $4, $5, $6, 'active', $7)
               RETURNING id`,
              [TENANT_ID, customerId, grant.amount, grant.source, STARTED, grant.expiry, grant.createdAt],
            )).rows[0];
            slots.set(inserted.id, index);
          }
        });
        if (override) {
          const saved = await putOrder(customerId, override);
          expect(saved.status).toBe(200);
        }
        seeded.push({ customerId, slots });
      }

      const signatures: string[] = [];
      for (const replica of seeded) {
        const consumed = await consume(replica.customerId, amount);
        expect(consumed.status, `set ${setIndex} consume failed: ${JSON.stringify(consumed.body)}`).toBe(201);
        const signature = (consumed.body.lines as Line[]).map((line) => {
          const slot = line.grant_id === null ? null : replica.slots.get(line.grant_id);
          expect(slot === null || slot !== undefined).toBe(true);
          return { slot, source_category: line.source_category, amount: line.amount };
        });
        signatures.push(JSON.stringify(signature));
      }
      expect(new Set(signatures).size, `set ${setIndex} varied: ${signatures.join(" | ")}`).toBe(1);
    }
  }, 180_000);

  // TEID-18-T7 (Non-functional): catalog budget is 100ms for a 5-grant split.
  // CONSUMPTION_SPLIT_LATENCY_BUDGET_MS overrides it. Default is 100.
  it("TEID-18-T7 splits one usage event across five grants within the latency budget", async () => {
    const budgetMs = Number(process.env.CONSUMPTION_SPLIT_LATENCY_BUDGET_MS ?? 100);
    const customerId = await createCustomer("teid-18-t7");
    for (let index = 0; index < 5; index += 1) {
      await issueGrant(customerId, {
        amount: 20,
        source: "paid",
        expiry_date: new Date(Date.UTC(2027, 0, 1 + index)).toISOString(),
      });
    }
    const started = performance.now();
    const consumed = await consume(customerId, 100);
    const elapsed = performance.now() - started;
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toHaveLength(5);
    expect(consumed.body.lines.reduce((sum: number, line: Line) => sum + line.amount, 0)).toBe(100);
    expect(elapsed).toBeLessThan(budgetMs);
  });

  // TEID-18-T8 (Adversarial): two grants cover exactly 10 of 20 equal draws.
  // The other 10 succeed with an overage line. Grant draws never exceed the
  // combined starting balance.
  it("TEID-18-T8 does not double-consume credit across 20 concurrent draws", async () => {
    const customerId = await createCustomer("teid-18-t8");
    const first = await issueGrant(customerId, {
      amount: 500, source: "paid", expiry_date: "2027-01-01T00:00:00Z",
    });
    const second = await issueGrant(customerId, {
      amount: 500, source: "commit", expiry_date: "2027-06-01T00:00:00Z",
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => consume(customerId, 100)));
    for (const response of responses) expect(response.status).toBe(201);

    const full = responses.filter((response) =>
      (response.body.lines as Line[]).every((line) => line.source_category !== "overage"));
    const short = responses.filter((response) => {
      const lines = response.body.lines as Line[];
      return lines.length === 1 && lines[0].source_category === "overage" && lines[0].amount === 100;
    });
    expect(full).toHaveLength(10);
    expect(short).toHaveLength(10);
    for (const response of full) {
      expect((response.body.lines as Line[]).reduce((sum, line) => sum + line.amount, 0)).toBe(100);
    }

    const drawn = responses
      .flatMap((response) => response.body.lines as Line[])
      .filter((line) => line.grant_id !== null)
      .reduce((sum, line) => sum + line.amount, 0);
    expect(drawn).toBe(1000);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ remaining: string; drawn: string }>(
        `SELECT
           (SELECT COALESCE(SUM(remaining_amount), 0)::text FROM grants WHERE customer_id = $1) AS remaining,
           (SELECT COALESCE(SUM(l.amount), 0)::text
            FROM usage_consumption_lines l
            WHERE l.grant_id IN ($2, $3)) AS drawn`,
        [customerId, first.id, second.id],
      )).rows[0],
    );
    expect(Number(stored.remaining)).toBe(0);
    expect(Number(stored.drawn)).toBe(1000);
  });

  // TEID-18-T9 (Adversarial): an override that names goodwill, which this
  // customer does not hold, falls back to promotional, paid, commit.
  it("TEID-18-T9 falls back to the default order when the override names an absent source", async () => {
    const customerId = await createCustomer("teid-18-t9");
    const promo = await issueGrant(customerId, {
      amount: 100, source: "promotional", expiry_date: "2026-10-02T12:00:00Z",
    });
    const paid = await issueGrant(customerId, {
      amount: 100, source: "paid", expiry_date: "2027-03-01T00:00:00Z",
    });
    const commit = await issueGrant(customerId, {
      amount: 100, source: "commit", expiry_date: "2027-06-01T00:00:00Z",
    });
    const saved = await putOrder(customerId, ["goodwill", "paid", "promotional", "commit"]);
    expect(saved.status).toBe(200);

    const consumed = await consume(customerId, 250);
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toEqual([
      { grant_id: promo.id, source_category: "promotional", amount: 100 },
      { grant_id: paid.id, source_category: "paid", amount: 100 },
      { grant_id: commit.id, source_category: "commit", amount: 50 },
    ]);
  });

  it("stores a plan-level consumption_order on a draft plan", async () => {
    const name = `Order-${randomUUID()}`;
    const initial = ["commit", "paid", "promotional", "goodwill"];
    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: opsToken,
      body: { name, currency: "USD", billing_interval: "monthly", consumption_order: initial },
    });
    expect(created.status).toBe(201);
    expect(created.body.consumption_order).toEqual(initial);

    const rejected = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: opsToken,
      body: { consumption_order: ["paid"] },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: ORDER_ERROR });

    const unchanged = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: opsToken });
    expect(unchanged.body.consumption_order).toEqual(initial);

    const next = ["goodwill", "commit", "paid", "promotional"];
    const patched = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: opsToken,
      body: { consumption_order: next },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.consumption_order).toEqual(next);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ consumption_order: string[] }>(
        `SELECT consumption_order FROM plans WHERE id = $1`,
        [created.body.id],
      )).rows[0],
    );
    expect(stored.consumption_order).toEqual(next);
  });
});
