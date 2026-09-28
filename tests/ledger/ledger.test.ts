import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, removeLedgerFixtures, superPool, withTenant } from "./db.js";
import {
  DATABASE_URL,
  GO_USAGE_URL,
  ONCALL_ALERT_WEBHOOK_URL,
  loadFixtures,
  type Fixtures,
  type TenantFixture,
} from "./env.js";
import { call, type ApiResponse } from "./http.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
let fx: Fixtures;
const createdTransactionIDs: string[] = [];

interface LedgerLine {
  id: string;
  transaction_id: string;
  account_code: string;
  direction: "debit" | "credit";
  amount: number | string;
  created_at: string;
}

interface LedgerTransaction {
  id: string;
  customer_id: string;
  usage_event_id: string | null;
  grant_id: string | null;
  reservation_id: string | null;
  pricing_rule_id: string | null;
  plan_version: number | null;
  reverses_transaction_id: string | null;
  description: string | null;
  created_at: string;
  lines: LedgerLine[];
}

function balancedBody(tenant: TenantFixture, amount = "10.00", description = `ledger-${randomUUID()}`) {
  return {
    customer_id: tenant.customerId,
    description,
    lines: [
      { account_code: "receivable", direction: "debit", amount },
      { account_code: "revenue", direction: "credit", amount },
    ],
  };
}

async function postTransaction(
  tenant: TenantFixture,
  body: Record<string, unknown> = balancedBody(tenant),
): Promise<ApiResponse<any>> {
  const response = await call(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    apiKey: tenant.apiKey,
    body,
  });
  if (response.status === 201) createdTransactionIDs.push(response.body.id);
  return response;
}

function decimalToScaled(value: number | string, scale = 2): bigint {
  const [whole, fraction = ""] = String(value).split(".");
  const negative = whole.startsWith("-");
  const absoluteWhole = negative ? whole.slice(1) : whole;
  const digits = `${absoluteWhole}${fraction.padEnd(scale, "0").slice(0, scale)}`;
  const result = BigInt(digits || "0");
  return negative ? -result : result;
}

async function runIntegrityCheck(fixedNow: string): Promise<{ checked_at: string; elapsed_ms: number }> {
  const env = {
    ...process.env,
    DATABASE_URL,
    ONCALL_ALERT_WEBHOOK_URL,
    LEDGER_CHECK_FIXED_NOW: fixedNow,
  };
  const { stdout } = await execFileAsync("go", ["run", "."], {
    cwd: here,
    env,
    timeout: 120_000,
  });
  return JSON.parse(stdout.trim()) as { checked_at: string; elapsed_ms: number };
}

async function resetFakeOncall(): Promise<void> {
  const base = new URL(ONCALL_ALERT_WEBHOOK_URL);
  base.pathname = "/control";
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  expect(response.status).toBe(200);
}

async function fakeOncallState(): Promise<{ alerts: Array<{
  tenant_id: string;
  unbalanced_transaction_ids: string[];
  checked_at: string;
}> }> {
  const url = new URL(ONCALL_ALERT_WEBHOOK_URL);
  url.pathname = "/state";
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ alerts: Array<{
    tenant_id: string;
    unbalanced_transaction_ids: string[];
    checked_at: string;
  }> }>;
}

beforeAll(() => {
  fx = loadFixtures();
});

afterAll(async () => {
  await removeLedgerFixtures(createdTransactionIDs);
  await Promise.all([appPool.end(), superPool.end()]);
});

describe("TEID-32 append-only double-entry ledger", () => {
  // TEID-32-T1 (Functional): the normal privileged application credential
  // has no UPDATE or DELETE privilege on either append-only ledger table.
  it("TEID-32-T1 blocks UPDATE and DELETE for teideal_app at the database boundary", async () => {
    const posted = await postTransaction(fx.tenant1);
    expect(posted.status).toBe(201);
    const original = posted.body;

    const expectPermissionDenied = async (sql: string, id: string): Promise<void> => {
      await expect(withTenant(fx.tenant1.id, (client) => client.query(sql, [id])))
        .rejects.toMatchObject({ code: "42501" });
    };
    await expectPermissionDenied(
      "UPDATE ledger_transactions SET description = 'tampered' WHERE id = $1",
      original.id,
    );
    await expectPermissionDenied("DELETE FROM ledger_lines WHERE id = $1", original.lines[0].id);

    const read = await call(`${GO_USAGE_URL}/ledger/transactions/${original.id}`, { apiKey: fx.tenant1.apiKey });
    expect(read.status).toBe(200);
    expect({ ...read.body, lines: [...read.body.lines].sort((a: LedgerLine, b: LedgerLine) => a.id.localeCompare(b.id)) })
      .toEqual({ ...original, lines: [...original.lines].sort((a: LedgerLine, b: LedgerLine) => a.id.localeCompare(b.id)) });
  });

  // TEID-32-T2 (Functional): all five causal references are persisted on a
  // usage-driven posting, including a real minimal reservation anchor.
  it("TEID-32-T2 records every causal reference on a usage-driven transaction", async () => {
    const usage = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: fx.tenant1.customerId,
        event_type: "ledger_traceability",
        quantity: 1,
        idempotency_key: `ledger-t2-${randomUUID()}`,
      },
    });
    expect(usage.status).toBe(201);
    const reservation = await call(`${GO_USAGE_URL}/reservations`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: { customer_id: fx.tenant1.customerId, usage_event_id: usage.body.id },
    });
    expect(reservation.status).toBe(201);

    const grantID = randomUUID();
    const pricingRuleID = randomUUID();
    const posted = await postTransaction(fx.tenant1, {
      ...balancedBody(fx.tenant1),
      usage_event_id: usage.body.id,
      grant_id: grantID,
      reservation_id: reservation.body.id,
      pricing_rule_id: pricingRuleID,
      plan_version: 1,
    });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      usage_event_id: usage.body.id,
      grant_id: grantID,
      reservation_id: reservation.body.id,
      pricing_rule_id: pricingRuleID,
      plan_version: 1,
    });
  });

  // TEID-32-T3 (Functional): use fixed-scale integer arithmetic in the test,
  // never JavaScript floating point, to assert the stored NUMERIC values net 0.
  it("TEID-32-T3 posts a $50 debit and credit whose exact sum is zero", async () => {
    const posted = await postTransaction(fx.tenant1, {
      customer_id: fx.tenant1.customerId,
      lines: [
        { account_code: "revenue", direction: "credit", amount: "50.00" },
        { account_code: "receivable", direction: "debit", amount: "50.00" },
      ],
    });
    expect(posted.status).toBe(201);
    const read = await call(`${GO_USAGE_URL}/ledger/transactions/${posted.body.id}`, {
      apiKey: fx.tenant1.apiKey,
    }) as ApiResponse<LedgerTransaction>;
    expect(read.status).toBe(200);
    const net = read.body.lines.reduce((sum, line) => {
      const amount = decimalToScaled(line.amount);
      return sum + (line.direction === "debit" ? amount : -amount);
    }, 0n);
    expect(net).toBe(0n);
  });

  // TEID-32-T4 (Functional): correction appends a linked mirror transaction
  // and leaves every serialized field of the original unchanged.
  it("TEID-32-T4 appends an exact reversing transaction without changing the original", async () => {
    const posted = await postTransaction(fx.tenant1, {
      customer_id: fx.tenant1.customerId,
      description: "overcharge",
      lines: [
        { account_code: "receivable", direction: "debit", amount: "25.00" },
        { account_code: "revenue", direction: "credit", amount: "25.00" },
      ],
    });
    expect(posted.status).toBe(201);
    const before = (await call(`${GO_USAGE_URL}/ledger/transactions/${posted.body.id}`, {
      apiKey: fx.tenant1.apiKey,
    })).body as LedgerTransaction;

    const reversed = await call(`${GO_USAGE_URL}/ledger/transactions/${posted.body.id}/reverse`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: { reason: "overcharge correction" },
    }) as ApiResponse<LedgerTransaction>;
    expect(reversed.status).toBe(201);
    createdTransactionIDs.push(reversed.body.id);
    expect(reversed.body.id).not.toBe(posted.body.id);
    expect(reversed.body.reverses_transaction_id).toBe(posted.body.id);
    expect(reversed.body.lines.map(({ account_code, direction, amount }: LedgerLine) => ({
      account_code, direction, amount: decimalToScaled(amount),
    })).sort((a, b) => a.account_code.localeCompare(b.account_code))).toEqual([
      { account_code: "receivable", direction: "credit", amount: 2500n },
      { account_code: "revenue", direction: "debit", amount: 2500n },
    ]);

    const after = await call(`${GO_USAGE_URL}/ledger/transactions/${posted.body.id}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before);
  });

  // TEID-32-T5 (Functional): only fixture setup disables triggers, and only
  // on this superuser session. The real worker function then discovers it.
  it("TEID-32-T5 flags an intentionally unbalanced transaction and pages on-call", async () => {
    await resetFakeOncall();
    const client = await superPool.connect();
    let transactionID = "";
    try {
      await client.query("SET session_replication_role = replica");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, customer_id, description)
         VALUES ($1, $2, 'TEID-32-T5 deliberately unbalanced fixture') RETURNING id`,
        [fx.tenant1.id, fx.tenant1.customerId],
      );
      transactionID = inserted.rows[0].id;
      await client.query(
        `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
         VALUES ($1, $2, 'receivable', 'debit', 10.00),
                ($1, $2, 'revenue', 'credit', 9.99)`,
        [fx.tenant1.id, transactionID],
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
      client.release();
    }

    const fixedNow = "2026-09-28T11:00:00.000Z";
    try {
      const result = await runIntegrityCheck(fixedNow);
      expect(new Date(result.checked_at).toISOString()).toBe(fixedNow);
      const state = await fakeOncallState();
      expect(state.alerts).toEqual([{
        tenant_id: fx.tenant1.id,
        unbalanced_transaction_ids: [transactionID],
        checked_at: "2026-09-28T11:00:00Z",
      }]);
    } finally {
      await removeLedgerFixtures([transactionID]);
    }
  });

  // TEID-32-T6 (Non-functional): CI scales the 50M/30-minute production
  // target while preserving a bulk data scan and concurrent real API writes.
  it("TEID-32-T6 completes the scaled integrity scan without degrading writes", async () => {
    await resetFakeOncall();
    const fixtureCount = Number(process.env.LEDGER_INTEGRITY_CHECK_FIXTURE_COUNT ?? 10_000);
    const budgetMs = Number(process.env.LEDGER_INTEGRITY_CHECK_BUDGET_MS ?? 30_000);
    const marker = `TEID-32-T6-${randomUUID()}`;
    const inserted = await superPool.query<{ id: string }>(
      `WITH transactions AS (
         INSERT INTO ledger_transactions (tenant_id, customer_id, description)
         SELECT $1, $2, $3 FROM generate_series(1, $4::int)
         RETURNING id, tenant_id
       )
       INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       SELECT t.tenant_id, t.id, side.account_code, side.direction, 1.00
       FROM transactions t
       CROSS JOIN (VALUES ('receivable', 'debit'), ('revenue', 'credit')) AS side(account_code, direction)
       RETURNING transaction_id AS id`,
      [fx.tenant1.id, fx.tenant1.customerId, marker, fixtureCount],
    );
    const bulkIDs = [...new Set(inserted.rows.map((row) => row.id))];

    const measureWrites = async (prefix: string): Promise<number> => {
      const started = performance.now();
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        postTransaction(fx.tenant1, balancedBody(fx.tenant1, "1.00", `${prefix}-${index}-${randomUUID()}`)),
      ));
      for (const response of responses) expect(response.status).toBe(201);
      return performance.now() - started;
    };

    try {
      const baselineMs = await measureWrites("t6-baseline");
      const checkPromise = runIntegrityCheck("2026-09-28T12:00:00.000Z");
      const concurrentMs = await measureWrites("t6-concurrent");
      const check = await checkPromise;
      expect(check.elapsed_ms).toBeLessThan(budgetMs);
      expect(concurrentMs).toBeLessThan(Math.max(baselineMs * 5, baselineMs + 500));
      expect((await fakeOncallState()).alerts).toEqual([]);
    } finally {
      await removeLedgerFixtures(bulkIDs);
    }
  }, 120_000);

  // TEID-32-T7 (Adversarial): a true superuser bypasses grants and RLS, so
  // this proves the BEFORE DELETE trigger is the enforcing layer.
  it("TEID-32-T7 blocks a direct superuser deletion with the immutable trigger", async () => {
    const posted = await postTransaction(fx.tenant1);
    expect(posted.status).toBe(201);
    const lineID = posted.body.lines[0].id;
    await expect(superPool.query("DELETE FROM ledger_lines WHERE id = $1", [lineID]))
      .rejects.toMatchObject({
        code: "P0001",
        message: expect.stringContaining("ledger rows are append-only and cannot be updated or deleted"),
      });
    const remains = await superPool.query<{ count: string }>(
      "SELECT count(*) FROM ledger_lines WHERE id = $1",
      [lineID],
    );
    expect(remains.rows[0].count).toBe("1");
  });

  // TEID-32-T8 (Adversarial): the application rejects a one-cent imbalance
  // before inserts and the atomic end-state contains no transaction or line.
  it("TEID-32-T8 rejects a one-cent imbalance atomically", async () => {
    const marker = `TEID-32-T8-${randomUUID()}`;
    const response = await postTransaction(fx.tenant1, {
      customer_id: fx.tenant1.customerId,
      description: marker,
      lines: [
        { account_code: "revenue", direction: "credit", amount: "50.00" },
        { account_code: "receivable", direction: "debit", amount: "50.01" },
      ],
    });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/does not balance.*0\.01/i);
    const persisted = await superPool.query<{ transactions: string; lines: string }>(
      `SELECT count(DISTINCT lt.id)::text AS transactions,
              count(ll.id)::text AS lines
       FROM ledger_transactions lt
       LEFT JOIN ledger_lines ll ON ll.transaction_id = lt.id
       WHERE lt.description = $1`,
      [marker],
    );
    expect(persisted.rows[0]).toEqual({ transactions: "0", lines: "0" });
  });
});
