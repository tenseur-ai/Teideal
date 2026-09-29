import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateBalanceAlerts } from "../../services/ts-console/src/lib/balanceAlertWorker.js";
import { pool, withTenant } from "./db.js";
import { FAKE_SLACK_URL, TS_CONSOLE_URL } from "./env.js";
import { startFakeSlack, stopFakeSlack } from "./fake-slack.js";
import { call } from "./http.js";
import { TENANT_ID, opsSession } from "./session.js";

// Fixed instant so every tick in a test shares one billing period.
const NOW = new Date("2026-09-29T15:00:00.000Z");
const GRANT_START = "2026-09-27T15:00:00.000Z";
const AS_OF = NOW.toISOString();

let opsToken: string;

beforeAll(async () => {
  await startFakeSlack();
  opsToken = await opsSession();
});

afterAll(async () => {
  await stopFakeSlack();
  await pool.end();
});

beforeEach(async () => {
  await fetch(`${FAKE_SLACK_URL}/_reset`, { method: "POST" });
});

interface SentRow {
  threshold_pct: number;
  period_start: string;
  delivery_status: {
    operator_email: string;
    slack: string;
    customer_email: string;
  };
}

interface SlackRequest {
  method: string;
  path: string;
  body: string;
  status: number;
}

async function createCustomer(name: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, name, `${name}-${randomUUID()}@example.test`],
    )).rows[0].id,
  );
}

async function createPlan(name: string): Promise<string> {
  const created = await call(`${TS_CONSOLE_URL}/plans`, {
    method: "POST",
    token: opsToken,
    body: { name, currency: "USD", billing_interval: "monthly" },
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

function putThresholds(scope: "plan" | "customer", scopeId: string, body: Record<string, unknown>) {
  return call(`${TS_CONSOLE_URL}/billing-alert-thresholds?scope=${scope}&scope_id=${scopeId}`, {
    method: "PUT",
    token: opsToken,
    body,
  });
}

async function createCommit(customerId: string, amount: number): Promise<string> {
  const created = await call(`${TS_CONSOLE_URL}/grants`, {
    method: "POST",
    token: opsToken,
    body: {
      customer_id: customerId,
      unit: "USD",
      source: "commit",
      amount,
      start_date: GRANT_START,
      drawdown_schedule: "upfront",
      overage_rate: 0,
    },
  });
  expect(created.status).toBe(201);
  expect(created.body.remaining_amount).toBe(amount);
  return created.body.id as string;
}

async function consume(grantId: string, amount: number): Promise<void> {
  const response = await call(`${TS_CONSOLE_URL}/grants/${grantId}/consume`, {
    method: "POST",
    token: opsToken,
    body: { amount, as_of: AS_OF },
  });
  expect(response.status).toBe(200);
}

async function setRemaining(grantId: string, remaining: number): Promise<void> {
  await withTenant(TENANT_ID, (client) =>
    client.query(`UPDATE grants SET remaining_amount = $2::numeric WHERE id = $1`, [grantId, String(remaining)]),
  );
}

async function sentRows(grantId: string): Promise<SentRow[]> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<SentRow>(
      `SELECT threshold_pct::int AS threshold_pct, period_start::text AS period_start, delivery_status
       FROM billing_alert_sent WHERE grant_id = $1 ORDER BY threshold_pct`,
      [grantId],
    )).rows,
  );
}

async function notificationsFor(grantId: string): Promise<Array<{ to_email: string; subject: string; body: string }>> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ to_email: string; subject: string; body: string }>(
      `SELECT to_email, subject, body FROM notifications_sent WHERE body LIKE $1 ORDER BY sent_at, to_email`,
      [`%${grantId}%`],
    )).rows,
  );
}

async function slackRequests(): Promise<SlackRequest[]> {
  const response = await fetch(`${FAKE_SLACK_URL}/_requests`);
  const body = await response.json() as { requests: SlackRequest[] };
  return body.requests;
}

async function setSlackFailure(failure: boolean): Promise<void> {
  const response = await fetch(`${FAKE_SLACK_URL}/_mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ failure }),
  });
  expect(response.status).toBe(200);
}

function crossedThresholds(amount: number, remaining: number, thresholds: number[]): number[] {
  return thresholds.filter((pct) => (amount - remaining) * 100 >= pct * amount);
}

describe("TEID-47 balance threshold alerts", () => {
  // TEID-47-T1 (Functional): customer thresholds 60/85/95 override the plan's
  // 50/80/100. At exactly 85% used, 85 is sent and the plan's 80 is not.
  it("TEID-47-T1 fires the customer threshold set instead of the plan default", async () => {
    const planId = await createPlan("teid-47-t1-plan");
    const planThresholds = await putThresholds("plan", planId, { threshold_pcts: [50, 80, 100] });
    expect(planThresholds.status).toBe(200);
    expect(planThresholds.body.threshold_pcts).toEqual([50, 80, 100]);

    const customerId = await createCustomer("acct_6006");
    const subscribed = await call(`${TS_CONSOLE_URL}/customers/${customerId}/subscription`, {
      method: "POST",
      token: opsToken,
      body: { plan_id: planId },
    });
    expect(subscribed.status).toBe(201);

    const customerThresholds = await putThresholds("customer", customerId, { threshold_pcts: [60, 85, 95] });
    expect(customerThresholds.status).toBe(200);
    expect(customerThresholds.body.threshold_pcts).toEqual([60, 85, 95]);

    const grantId = await createCommit(customerId, 10000);
    await consume(grantId, 8500);

    await evaluateBalanceAlerts(pool, NOW);

    const sent = await sentRows(grantId);
    const pcts = sent.map((row) => row.threshold_pct);
    expect(pcts).toContain(85);
    expect(pcts).not.toContain(80);
    expect(pcts).toEqual([60, 85]);

    const planAfter = await call(
      `${TS_CONSOLE_URL}/billing-alert-thresholds?scope=plan&scope_id=${planId}`,
      { token: opsToken },
    );
    expect(planAfter.status).toBe(200);
    expect(planAfter.body.threshold_pcts).toEqual([50, 80, 100]);
  });

  // TEID-47-T2 (Functional): a second evaluation in the same period hits the
  // unique constraint and does not write a second 80% alert.
  it("TEID-47-T2 sends one 80% alert when the same period is evaluated twice", async () => {
    const customerId = await createCustomer("acct_6006");
    const grantId = await createCommit(customerId, 10000);
    await consume(grantId, 8100);

    const first = await evaluateBalanceAlerts(pool, NOW);
    expect(first.recorded).toBeGreaterThan(0);
    const afterFirst = await sentRows(grantId);
    expect(afterFirst.filter((row) => row.threshold_pct === 80)).toHaveLength(1);

    const second = await evaluateBalanceAlerts(pool, NOW);
    expect(second.uniqueConflicts).toBeGreaterThan(0);
    const afterSecond = await sentRows(grantId);
    expect(afterSecond.filter((row) => row.threshold_pct === 80)).toHaveLength(1);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });

  // TEID-47-T3 (Functional): operator email, Slack, and customer email all
  // receive the 50% alert, and delivery_status records sent for each.
  it("TEID-47-T3 delivers a 50% alert to operator email, Slack, and the customer", async () => {
    const customerId = await createCustomer("acct_6006");
    const operatorEmail = `ops-${randomUUID()}@example.test`;
    const customerEmail = `customer-${randomUUID()}@example.test`;
    const configured = await putThresholds("customer", customerId, {
      threshold_pcts: [50, 80, 100],
      operator_emails: [operatorEmail],
      slack_webhook_url: `${FAKE_SLACK_URL}/webhook`,
      notify_customer: true,
      customer_email: customerEmail,
    });
    expect(configured.status).toBe(200);

    const grantId = await createCommit(customerId, 10000);
    await consume(grantId, 5000);
    await evaluateBalanceAlerts(pool, NOW);

    const sent = await sentRows(grantId);
    expect(sent.map((row) => row.threshold_pct)).toEqual([50]);
    expect(sent[0].delivery_status).toEqual({
      operator_email: "sent",
      slack: "sent",
      customer_email: "sent",
    });

    const hooks = await slackRequests();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].method).toBe("POST");
    expect(hooks[0].status).toBe(200);
    const slackBody = JSON.parse(hooks[0].body) as { text: string; threshold_pct: number };
    expect(typeof slackBody.text).toBe("string");
    expect(slackBody.text.length).toBeGreaterThan(0);
    expect(slackBody.threshold_pct).toBe(50);

    const notes = await notificationsFor(grantId);
    const recipients = notes.map((row) => row.to_email).sort();
    expect(recipients).toEqual([customerEmail, operatorEmail].sort());
  });

  // TEID-47-T4 (Functional): 80% of a $10,000 commit leaves $2,000 and a
  // projected run-out date on the alert.
  it("TEID-47-T4 includes the customer, 80%, remaining $2,000, and a run-out date", async () => {
    const customerId = await createCustomer("acct_6006");
    const operatorEmail = `ops-${randomUUID()}@example.test`;
    const configured = await putThresholds("customer", customerId, {
      threshold_pcts: [50, 80, 100],
      operator_emails: [operatorEmail],
      slack_webhook_url: `${FAKE_SLACK_URL}/webhook`,
    });
    expect(configured.status).toBe(200);

    const grantId = await createCommit(customerId, 10000);
    await consume(grantId, 8000);
    await evaluateBalanceAlerts(pool, NOW);

    const hooks = await slackRequests();
    const atEighty = hooks
      .map((hook) => JSON.parse(hook.body) as {
        text: string;
        customer_name: string;
        threshold_pct: number;
        remaining_amount: number;
        projected_run_out_date: string | null;
        projection_method: string;
      })
      .find((payload) => payload.threshold_pct === 80);
    expect(atEighty).toBeDefined();
    expect(atEighty!.customer_name).toBe("acct_6006");
    expect(atEighty!.threshold_pct).toBe(80);
    expect(atEighty!.remaining_amount).toBe(2000);
    expect(atEighty!.projected_run_out_date).toEqual(expect.any(String));
    expect(atEighty!.projected_run_out_date).not.toBe("");
    expect(atEighty!.projection_method).toBe("linear_7d_average");
    expect(atEighty!.text).toContain("acct_6006");
    expect(atEighty!.text).toContain("80");
    expect(atEighty!.text).toContain("2000");
    expect(atEighty!.text).toContain(atEighty!.projected_run_out_date!);

    const notes = await notificationsFor(grantId);
    const emailed = notes
      .map((row) => JSON.parse(row.body) as { threshold_pct: number; remaining_amount: number; projected_run_out_date: string | null; customer_name: string })
      .find((payload) => payload.threshold_pct === 80);
    expect(emailed?.customer_name).toBe("acct_6006");
    expect(emailed?.remaining_amount).toBe(2000);
    expect(emailed?.projected_run_out_date).toEqual(expect.any(String));
  });

  // TEID-47-T6 (Non-functional): a 500 from Slack is stored as failed, logged,
  // and visible on the operator failure feed. Email still goes out, and a
  // later tick does not send it again.
  it("TEID-47-T6 records a failed Slack delivery without dropping the other channels", async () => {
    const customerId = await createCustomer("acct_6006");
    const operatorEmail = `ops-${randomUUID()}@example.test`;
    const customerEmail = `customer-${randomUUID()}@example.test`;
    const configured = await putThresholds("customer", customerId, {
      threshold_pcts: [50, 80, 100],
      operator_emails: [operatorEmail],
      slack_webhook_url: `${FAKE_SLACK_URL}/webhook`,
      notify_customer: true,
      customer_email: customerEmail,
    });
    expect(configured.status).toBe(200);
    await setSlackFailure(true);

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
      original(...args);
    };
    try {
      const grantId = await createCommit(customerId, 10000);
      await consume(grantId, 5000);
      await evaluateBalanceAlerts(pool, NOW);

      const sent = await sentRows(grantId);
      expect(sent).toHaveLength(1);
      expect(sent[0].threshold_pct).toBe(50);
      expect(sent[0].delivery_status.slack).toBe("failed");
      expect(sent[0].delivery_status.operator_email).toBe("sent");
      expect(sent[0].delivery_status.customer_email).toBe("sent");
      expect(errors.some((line) => line.includes("balance_alert_delivery_failed") && line.includes("\"channel\":\"slack\""))).toBe(true);

      const failures = await call(`${TS_CONSOLE_URL}/billing-alert-thresholds/delivery-failures`, { token: opsToken });
      expect(failures.status).toBe(200);
      const match = (failures.body.data as Array<{ grant_id: string; delivery_status: { slack: string } }>)
        .find((row) => row.grant_id === grantId);
      expect(match?.delivery_status.slack).toBe("failed");

      const notes = await notificationsFor(grantId);
      expect(notes.map((row) => row.to_email).sort()).toEqual([customerEmail, operatorEmail].sort());

      await evaluateBalanceAlerts(pool, NOW);
      const again = await sentRows(grantId);
      expect(again).toHaveLength(1);
      expect(await notificationsFor(grantId)).toHaveLength(notes.length);
    } finally {
      console.error = original;
      await setSlackFailure(false);
    }
  });

  // TEID-47-T7 (Adversarial): crossing back under 80% does not re-arm the
  // once-per-period dedup key.
  it("TEID-47-T7 keeps a single 80% alert across twenty crossings of the line", async () => {
    const customerId = await createCustomer("acct_6006");
    const grantId = await createCommit(customerId, 10000);

    for (let i = 0; i < 20; i++) {
      await setRemaining(grantId, 1500);
      await evaluateBalanceAlerts(pool, NOW);
      await setRemaining(grantId, 3000);
      await evaluateBalanceAlerts(pool, NOW);
    }

    const sent = await sentRows(grantId);
    expect(sent.filter((row) => row.threshold_pct === 80)).toHaveLength(1);
  });

  // TEID-47-T8 (Adversarial): 0% and 150% are rejected by the API and by the
  // table check, and neither call writes a threshold row.
  it("TEID-47-T8 rejects threshold values of 0% and 150%", async () => {
    const customerId = await createCustomer("acct_6006");
    const zero = await putThresholds("customer", customerId, { threshold_pcts: [0] });
    const tooHigh = await putThresholds("customer", customerId, { threshold_pcts: [150] });
    expect(zero.status).toBe(400);
    expect(tooHigh.status).toBe(400);
    expect(zero.body.error).toMatch(/threshold_pcts/);
    expect(tooHigh.body.error).toMatch(/threshold_pcts/);

    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM billing_alert_thresholds WHERE scope = 'customer' AND scope_id = $1`,
        [customerId],
      )).rows[0].count,
    );
    expect(Number(stored)).toBe(0);

    const valid = await putThresholds("customer", customerId, { threshold_pcts: [50, 80, 100] });
    expect(valid.status).toBe(200);
    const rejectedAgain = await putThresholds("customer", customerId, { threshold_pcts: [0] });
    const rejectedHigh = await putThresholds("customer", customerId, { threshold_pcts: [150] });
    expect(rejectedAgain.status).toBe(400);
    expect(rejectedHigh.status).toBe(400);
    const unchanged = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ threshold_pcts: number[] }>(
        `SELECT threshold_pcts FROM billing_alert_thresholds WHERE scope = 'customer' AND scope_id = $1`,
        [customerId],
      )).rows[0].threshold_pcts.map(Number),
    );
    expect(unchanged).toEqual([50, 80, 100]);

    const orphan = randomUUID();
    await expect(withTenant(TENANT_ID, (client) =>
      client.query(
        `INSERT INTO billing_alert_thresholds (tenant_id, scope, scope_id, threshold_pcts)
         VALUES ($1, 'customer', $2, $3::smallint[])`,
        [TENANT_ID, orphan, [0]],
      ),
    )).rejects.toMatchObject({ code: "23514" });
    await expect(withTenant(TENANT_ID, (client) =>
      client.query(
        `INSERT INTO billing_alert_thresholds (tenant_id, scope, scope_id, threshold_pcts)
         VALUES ($1, 'customer', $2, $3::smallint[])`,
        [TENANT_ID, orphan, [150]],
      ),
    )).rejects.toMatchObject({ code: "23514" });
    const orphanCount = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM billing_alert_thresholds WHERE scope_id = $1`,
        [orphan],
      )).rows[0].count,
    );
    expect(Number(orphanCount)).toBe(0);
  });

  // TEID-47-T5 (Non-functional): one tick across 10,000 customers records
  // exactly the crossed thresholds and nothing twice.
  it("TEID-47-T5 alerts each of 10,000 customers once per crossed threshold", async () => {
    const runId = randomUUID().replace(/-/g, "");
    await withTenant(TENANT_ID, (client) =>
      client.query(
        `WITH created AS (
           INSERT INTO customers (tenant_id, name, email)
           SELECT $1::uuid,
                  't5-' || gs::text,
                  't5-' || gs::text || '-' || $2 || '@balance-alerts.test'
           FROM generate_series(1, 10000) AS gs
           RETURNING id, email
         )
         INSERT INTO grants (
           tenant_id, customer_id, amount, remaining_amount, unit, source,
           start_date, status, drawdown_schedule, overage_rate
         )
         SELECT $1::uuid, id, 10000,
           CASE (split_part(email, '-', 2)::int % 4)
             WHEN 1 THEN 5000
             WHEN 2 THEN 2000
             WHEN 3 THEN 0
             ELSE 6000
           END,
           'USD', 'commit', $3::timestamptz, 'active', 'upfront', 0
         FROM created`,
        [TENANT_ID, runId, GRANT_START],
      ),
    );

    const seeded = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ grant_id: string; amount: string; remaining_amount: string }>(
        `SELECT g.id AS grant_id, g.amount::text AS amount, g.remaining_amount::text AS remaining_amount
         FROM grants g
         JOIN customers c ON c.id = g.customer_id
         WHERE c.email LIKE $1`,
        [`t5-%-${runId}@balance-alerts.test`],
      )).rows,
    );
    expect(seeded).toHaveLength(10000);
    const expected = seeded.reduce((sum, row) => {
      return sum + crossedThresholds(Number(row.amount), Number(row.remaining_amount), [50, 80, 100]).length;
    }, 0);
    expect(expected).toBe(15000);

    await evaluateBalanceAlerts(pool, NOW);

    const grantIds = seeded.map((row) => row.grant_id);
    const actual = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM billing_alert_sent WHERE grant_id = ANY($1::uuid[])`,
        [grantIds],
      )).rows[0].count,
    );
    expect(Number(actual)).toBe(expected);

    const duplicates = await withTenant(TENANT_ID, async (client) =>
      (await client.query(
        `SELECT grant_id, threshold_pct, period_start
         FROM billing_alert_sent
         WHERE grant_id = ANY($1::uuid[])
         GROUP BY grant_id, threshold_pct, period_start
         HAVING count(*) > 1`,
        [grantIds],
      )).rows,
    );
    expect(duplicates).toEqual([]);
  });
});
