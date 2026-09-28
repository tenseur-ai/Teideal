import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthsBetween, trancheCount } from "../../services/ts-console/src/lib/commitSchedule.js";
import { processCommitDrawdowns, processExpiredGrants } from "../../services/ts-console/src/lib/grantWorker.js";
import { pool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { OPS_USER_ID, TENANT_ID, opsSession } from "./session.js";

const AS_OF = "2026-06-15T00:00:00Z";
const TERM_START = "2026-01-01T00:00:00Z";
const TERM_END = "2026-12-31T23:59:59Z";

let opsToken: string;

beforeAll(async () => {
  opsToken = await opsSession();
});
afterAll(() => pool.end());

interface Line {
  grant_id: string | null;
  source_category: string;
  amount: number;
  overage_amount_due?: number;
}

interface CommitBody {
  amount: number;
  drawdown_schedule: "upfront" | "monthly" | "quarterly";
  overage_rate: number;
  start_date?: string;
  expiry_date?: string | null;
  carries_over?: boolean;
  unit?: string;
}

async function createCustomer(label: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, label, `${label}-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
}

function createCommit(customerId: string, body: CommitBody) {
  return call(`${TS_CONSOLE_URL}/grants`, {
    method: "POST",
    token: opsToken,
    body: {
      customer_id: customerId,
      unit: body.unit ?? "USD",
      source: "commit",
      start_date: body.start_date ?? TERM_START,
      expiry_date: body.expiry_date === undefined ? "2027-01-01T00:00:00Z" : body.expiry_date,
      amount: body.amount,
      drawdown_schedule: body.drawdown_schedule,
      overage_rate: body.overage_rate,
      carries_over: body.carries_over ?? false,
    },
  });
}

function consume(customerId: string, amount: number, asOf = AS_OF) {
  return call(`${TS_CONSOLE_URL}/customers/${customerId}/consume`, {
    method: "POST",
    token: opsToken,
    body: { amount, unit: "USD", as_of: asOf },
  });
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

describe("TEID-19 annual commits with monthly drawdown", () => {
  it("counts monthly and quarterly tranches from UTC calendar months", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const yearEnd = new Date("2026-12-31T23:59:59Z");
    expect(monthsBetween(start, yearEnd)).toBe(11);
    expect(trancheCount(start, yearEnd, "monthly")).toBe(12);
    expect(trancheCount(start, yearEnd, "quarterly")).toBe(4);
    // The final partial month does not count when the end day is earlier.
    expect(monthsBetween(new Date("2026-01-31T00:00:00Z"), new Date("2026-02-28T00:00:00Z"))).toBe(0);
    expect(monthsBetween(new Date("2026-01-15T12:00:00Z"), new Date("2026-02-15T11:00:00Z"))).toBe(0);
  });

  // TEID-19-T1 (Functional): 250000 USD, term 2026, monthly schedule, overage
  // 0.0025. The five stored fields match, and only the first tranche is available.
  it("TEID-19-T1 stores the commit fields and releases the first monthly tranche", async () => {
    const customerId = await createCustomer("teid-19-t1");
    const created = await createCommit(customerId, {
      amount: 250000,
      drawdown_schedule: "monthly",
      overage_rate: 0.0025,
      expiry_date: TERM_END,
    });
    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(250000);
    expect(created.body.start_date).toBe("2026-01-01T00:00:00.000Z");
    expect(created.body.expiry_date).toBe("2026-12-31T23:59:59.000Z");
    expect(created.body.drawdown_schedule).toBe("monthly");
    expect(created.body.overage_rate).toBe(0.0025);
    expect(created.body.remaining_amount).toBe(250000 / 12);
    expect(created.body.next_release_at).toBe("2026-02-01T00:00:00.000Z");

    const detail = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(detail.status).toBe(200);
    expect(detail.body.amount).toBe(250000);
    expect(detail.body.start_date).toBe(created.body.start_date);
    expect(detail.body.expiry_date).toBe(created.body.expiry_date);
    expect(detail.body.drawdown_schedule).toBe("monthly");
    expect(detail.body.overage_rate).toBe(0.0025);
    expect(detail.body.remaining_amount).toBe(created.body.remaining_amount);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{
        amount: string;
        remaining: string;
        schedule: string;
        rate: string;
        issued: string;
      }>(
        `SELECT g.amount::text AS amount, g.remaining_amount::text AS remaining,
                g.drawdown_schedule AS schedule, g.overage_rate::text AS rate,
                e.amount::text AS issued
         FROM grants g
         JOIN grant_ledger_entries e ON e.grant_id = g.id AND e.entry_type = 'issued'
         WHERE g.id = $1`,
        [created.body.id],
      )).rows[0],
    );
    expect(Number(stored.amount)).toBe(250000);
    expect(stored.schedule).toBe("monthly");
    expect(Number(stored.rate)).toBe(0.0025);
    expect(Number(stored.remaining)).toBe(250000 / 12);
    expect(Number(stored.issued)).toBe(250000 / 12);
  });

  it("releases later monthly tranches until the ledger sums to the commit", async () => {
    const customerId = await createCustomer("teid-19-schedule");
    const created = await createCommit(customerId, {
      amount: 250000,
      drawdown_schedule: "monthly",
      overage_rate: 0.0025,
      expiry_date: TERM_END,
    });
    expect(created.status).toBe(201);
    for (let month = 1; month < 12; month += 1) {
      const released = await processCommitDrawdowns(pool, new Date(Date.UTC(2026, month, 1)));
      expect(released).toBeGreaterThanOrEqual(1);
    }
    const closed = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ remaining: string; next_release_at: Date | null; ledger: string; releases: number }>(
        `SELECT g.remaining_amount::text AS remaining, g.next_release_at,
                (SELECT COALESCE(SUM(amount), 0)::text FROM grant_ledger_entries
                 WHERE grant_id = g.id AND entry_type IN ('issued', 'released')) AS ledger,
                (SELECT count(*)::int FROM grant_ledger_entries
                 WHERE grant_id = g.id AND entry_type = 'released') AS releases
         FROM grants g WHERE g.id = $1`,
        [created.body.id],
      )).rows[0],
    );
    expect(Number(closed.ledger)).toBe(250000);
    expect(Number(closed.remaining)).toBe(250000);
    expect(closed.next_release_at).toBeNull();
    expect(closed.releases).toBe(11);
    await processCommitDrawdowns(pool, new Date("2026-12-01T00:00:00Z"));
    const after = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ releases: number }>(
        `SELECT count(*)::int AS releases FROM grant_ledger_entries
         WHERE grant_id = $1 AND entry_type = 'released'`,
        [created.body.id],
      )).rows[0],
    );
    expect(after.releases).toBe(11);
  });

  // TEID-19-T2 (Functional): 40000 USD of usage leaves 210000 of an upfront commit.
  it("TEID-19-T2 returns the remaining balance immediately after drawdown", async () => {
    const customerId = await createCustomer("teid-19-t2");
    const created = await createCommit(customerId, {
      amount: 250000,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    expect(created.body.remaining_amount).toBe(250000);
    for (let index = 0; index < 4; index += 1) {
      const consumed = await consume(customerId, 10000);
      expect(consumed.status).toBe(201);
    }
    const detail = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(detail.status).toBe(200);
    expect(detail.body.remaining_amount).toBe(210000);
  });

  // TEID-19-T3 (Functional): 800 against 500 remaining splits into 500 commit and 300 priced overage.
  it("TEID-19-T3 splits the exhausting event into commit drawdown and priced overage", async () => {
    const customerId = await createCustomer("teid-19-t3");
    const created = await createCommit(customerId, {
      amount: 500,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    const consumed = await consume(customerId, 800);
    expect(consumed.status).toBe(201);
    expect(consumed.body.lines).toEqual([
      { grant_id: created.body.id, source_category: "commit", amount: 500 },
      { grant_id: null, source_category: "overage", amount: 300, overage_amount_due: 0.75 },
    ]);
  });

  // TEID-19-T4 (Functional): unused non-carryover balance is an expired line, and the grant is no longer drawable.
  it("TEID-19-T4 reports unused commit at term end and starts the next draw at zero", async () => {
    const customerId = await createCustomer("teid-19-t4");
    const created = await createCommit(customerId, {
      amount: 250000,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
      carries_over: false,
      expiry_date: "2026-06-01T00:00:00Z",
    });
    expect(created.status).toBe(201);
    const consumed = await consume(customerId, 235000, "2026-03-01T00:00:00Z");
    expect(consumed.status).toBe(201);
    const beforeClose = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(beforeClose.body.remaining_amount).toBe(15000);

    const expiredCount = await processExpiredGrants(pool, new Date("2026-06-01T00:00:00Z"));
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    const detail = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("expired");

    const report = await call(
      `${TS_CONSOLE_URL}/grant-ledger-entries?grant_id=${created.body.id}&entry_type=expired&source=commit`,
      { token: opsToken },
    );
    expect(report.status).toBe(200);
    expect(report.body.data).toHaveLength(1);
    expect(report.body.data[0].entry_type).toBe("expired");
    expect(report.body.data[0].amount).toBe(-15000);

    const nextTerm = await consume(customerId, 100, "2026-07-01T00:00:00Z");
    expect(nextTerm.status).toBe(201);
    expect(nextTerm.body.lines).toEqual([
      { grant_id: null, source_category: "overage", amount: 100 },
    ]);
  });

  it("records a carried-over balance as its own ledger line and still closes the grant", async () => {
    const customerId = await createCustomer("teid-19-carry");
    const created = await createCommit(customerId, {
      amount: 80,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
      carries_over: true,
      expiry_date: "2026-04-01T00:00:00Z",
    });
    expect(created.status).toBe(201);
    await processExpiredGrants(pool, new Date("2026-04-01T00:00:00Z"));
    const report = await call(
      `${TS_CONSOLE_URL}/grant-ledger-entries?grant_id=${created.body.id}&entry_type=carried_over&source=commit`,
      { token: opsToken },
    );
    expect(report.status).toBe(200);
    expect(report.body.data).toEqual([
      expect.objectContaining({ entry_type: "carried_over", amount: -80, grant_id: created.body.id }),
    ]);
    const detail = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(detail.body.status).toBe("expired");
    const spawned = await withTenant(TENANT_ID, async (client) =>
      (await client.query(`SELECT id FROM grants WHERE customer_id = $1 AND id <> $2`, [customerId, created.body.id])).rowCount,
    );
    expect(spawned).toBe(0);
  });

  // TEID-19-T5 (Functional): an in-term overage-rate change is audited with old value, new value, reason, and operator.
  it("TEID-19-T5 audits an overage-rate amend with the reason and the operator", async () => {
    const customerId = await createCustomer("teid-19-t5");
    const created = await createCommit(customerId, {
      amount: 250000,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    const amended = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}/amend`, {
      method: "PATCH",
      token: opsToken,
      body: { reason: "renegotiated Q3 pricing", overage_rate: 0.003 },
    });
    expect(amended.status).toBe(200);
    expect(amended.body.overage_rate).toBe(0.003);

    const audit = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{
        before: { overage_rate: number };
        after: { overage_rate: number };
        actor_user_id: string;
        detail: { reason: string } | null;
        event_type: string;
      }>(
        `SELECT before, after, actor_user_id, detail, event_type
         FROM audit_log
         WHERE object_type = 'Grant' AND object_id = $1 AND event_type = 'config_change'
           AND before IS NOT NULL
         ORDER BY occurred_at DESC
         LIMIT 1`,
        [created.body.id],
      )).rows[0],
    );
    expect(audit.event_type).toBe("config_change");
    expect(audit.before.overage_rate).toBe(0.0025);
    expect(audit.after.overage_rate).toBe(0.003);
    expect(audit.actor_user_id).toBe(OPS_USER_ID);
    expect(audit.detail?.reason).toBe("renegotiated Q3 pricing");
  });

  // TEID-19-T6 (Non-functional): catalog target is 1000 requests/sec and P99 under 50ms,
  // with no read stale by more than 2 seconds. CI defaults are COMMIT_BALANCE_RPS=50,
  // COMMIT_BALANCE_LATENCY_BUDGET_MS=100, and COMMIT_BALANCE_STALE_MS=2000.
  // A dedicated run sets the rate to 1000 and the latency budget to 50.
  it("TEID-19-T6 keeps remaining-balance reads fresh under drawdown", async () => {
    const rps = Number(process.env.COMMIT_BALANCE_RPS ?? 50);
    const p99BudgetMs = Number(process.env.COMMIT_BALANCE_LATENCY_BUDGET_MS ?? 100);
    const staleMs = Number(process.env.COMMIT_BALANCE_STALE_MS ?? 2000);
    const total = rps * 2;
    const starting = 1_000_000;
    const customerId = await createCustomer("teid-19-t6");
    const created = await createCommit(customerId, {
      amount: starting,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    const url = `${TS_CONSOLE_URL}/grants/${created.body.id}`;

    let stop = false;
    let consumed = 0;
    const consumer = (async () => {
      while (!stop) {
        const response = await consume(customerId, 1);
        if (response.status !== 201) {
          throw new Error(`background drawdown failed: ${response.status} ${JSON.stringify(response.body)}`);
        }
        consumed += 1;
      }
    })();

    const readBalance = async () => {
      const started = performance.now();
      const response = await call(url, { token: opsToken });
      const finished = performance.now();
      if (response.status !== 200 || typeof response.body.remaining_amount !== "number") {
        throw new Error(`balance read failed: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return { started, finished, elapsed: finished - started, remaining: response.body.remaining_amount as number };
    };
    for (let index = 0; index < 10; index += 1) await readBalance();

    const samples: number[] = [];
    const observations: Array<{ started: number; finished: number; remaining: number }> = [];
    let cursor = 0;
    const startedAt = performance.now();
    const worker = async () => {
      while (cursor < total) {
        cursor += 1;
        const sample = await readBalance();
        samples.push(sample.elapsed);
        observations.push(sample);
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    const elapsed = performance.now() - startedAt;
    stop = true;
    await consumer;

    expect(samples).toHaveLength(total);
    const achievedRps = total / (elapsed / 1000);
    expect(achievedRps, `balance reads achieved ${achievedRps.toFixed(1)} rps`).toBeGreaterThanOrEqual(rps);
    const p99 = percentile(samples, 99);
    expect(p99, `balance P99 was ${p99.toFixed(2)}ms`).toBeLessThan(p99BudgetMs);

    const ordered = [...observations].sort((left, right) => left.finished - right.finished);
    for (let earlier = 0; earlier < ordered.length; earlier += 1) {
      for (let later = earlier + 1; later < ordered.length; later += 1) {
        if (ordered[later].started < ordered[earlier].finished + staleMs) continue;
        expect(ordered[later].remaining).toBeLessThanOrEqual(ordered[earlier].remaining);
      }
    }

    const finalRead = await call(url, { token: opsToken });
    expect(finalRead.body.remaining_amount).toBe(starting - consumed);
  });

  // TEID-19-T7 (Non-functional): catalog burst is 200. CI default is
  // COMMIT_SPLIT_BURST_SIZE=20. The commit is exhausted partway through the
  // burst. Commit lines never exceed the starting balance, and the response
  // that crosses the boundary prices its overage at the commit's rate.
  // A later call that finds the commit already empty has no rate to apply.
  it("TEID-19-T7 prices the exhaustion boundary once under a concurrent burst", async () => {
    const burst = Number(process.env.COMMIT_SPLIT_BURST_SIZE ?? 20);
    const eventAmount = 100;
    const starting = eventAmount * Math.floor(burst / 2) + 50;
    const rate = 0.25;
    const customerId = await createCustomer("teid-19-t7");
    const created = await createCommit(customerId, {
      amount: starting,
      drawdown_schedule: "upfront",
      overage_rate: rate,
    });
    expect(created.status).toBe(201);

    const responses = await Promise.all(
      Array.from({ length: burst }, () => consume(customerId, eventAmount)),
    );
    for (const response of responses) expect(response.status).toBe(201);

    const lines = responses.flatMap((response) => response.body.lines as Line[]);
    const commitDrawn = lines
      .filter((line) => line.grant_id === created.body.id)
      .reduce((sum, line) => sum + line.amount, 0);
    expect(commitDrawn).toBe(starting);

    const boundary = responses.filter((response) => {
      const eventLines = response.body.lines as Line[];
      return eventLines.some((line) => line.source_category === "commit")
        && eventLines.some((line) => line.source_category === "overage");
    });
    expect(boundary).toHaveLength(1);
    const boundaryOverage = (boundary[0].body.lines as Line[]).find((line) => line.source_category === "overage");
    expect(boundaryOverage?.amount).toBe(50);
    expect(boundaryOverage?.overage_amount_due).toBe(50 * rate);

    const pureOverage = responses.filter((response) => {
      const eventLines = response.body.lines as Line[];
      return eventLines.length === 1 && eventLines[0].source_category === "overage";
    });
    expect(pureOverage.length).toBeGreaterThan(0);
    for (const response of pureOverage) {
      const line = (response.body.lines as Line[])[0];
      expect(line.amount).toBe(eventAmount);
      expect(line.overage_amount_due).toBeUndefined();
    }

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ remaining: string; drawn: string }>(
        `SELECT remaining_amount::text AS remaining,
                (SELECT COALESCE(SUM(amount), 0)::text FROM usage_consumption_lines WHERE grant_id = $1) AS drawn
         FROM grants WHERE id = $1`,
        [created.body.id],
      )).rows[0],
    );
    expect(Number(stored.remaining)).toBe(0);
    expect(Number(stored.drawn)).toBe(starting);
  });

  // TEID-19-T8 (Adversarial): two events share one timestamp and either one
  // would exhaust the commit. One receives the whole balance. The other is
  // overage. They do not split a doubled balance. Which request wins is the
  // one that takes the row lock; see NOTES-TEID-19.md.
  it("TEID-19-T8 gives the whole commit to one of two identical timestamps", async () => {
    const customerId = await createCustomer("teid-19-t8");
    const created = await createCommit(customerId, {
      amount: 100,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    const sameInstant = "2026-06-15T00:00:00Z";
    const [first, second] = await Promise.all([
      consume(customerId, 100, sameInstant),
      consume(customerId, 100, sameInstant),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const responses = [first, second];
    const commitLines = responses.flatMap((response) =>
      (response.body.lines as Line[]).filter((line) => line.source_category === "commit"));
    const overageLines = responses.flatMap((response) =>
      (response.body.lines as Line[]).filter((line) => line.source_category === "overage"));
    expect(commitLines).toEqual([{ grant_id: created.body.id, source_category: "commit", amount: 100 }]);
    // The losing request never locks the commit: its balance is already zero,
    // so the overage line stays unpriced. Pricing applies to a call that drew
    // the commit, which is T3 and the boundary event in T7.
    expect(overageLines).toEqual([{ grant_id: null, source_category: "overage", amount: 100 }]);
    for (const response of responses) {
      const drawn = (response.body.lines as Line[])
        .filter((line) => line.source_category === "commit")
        .reduce((sum, line) => sum + line.amount, 0);
      expect(drawn === 0 || drawn === 100).toBe(true);
    }
  });

  // TEID-19-T9 (Adversarial): an amend without a reason is rejected and changes nothing.
  it("TEID-19-T9 rejects an overage-rate change that has no reason", async () => {
    const customerId = await createCustomer("teid-19-t9");
    const created = await createCommit(customerId, {
      amount: 1000,
      drawdown_schedule: "upfront",
      overage_rate: 0.0025,
    });
    expect(created.status).toBe(201);
    const missing = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}/amend`, {
      method: "PATCH",
      token: opsToken,
      body: { overage_rate: 0.003 },
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: "reason is required" });

    const blank = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}/amend`, {
      method: "PATCH",
      token: opsToken,
      body: { reason: "   ", overage_rate: 0.003 },
    });
    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ error: "reason is required" });

    const detail = await call(`${TS_CONSOLE_URL}/grants/${created.body.id}`, { token: opsToken });
    expect(detail.status).toBe(200);
    expect(detail.body.overage_rate).toBe(0.0025);
  });
});
