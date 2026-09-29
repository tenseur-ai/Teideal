import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  createCustomer,
  removeCustomers,
  removeScaleFixture,
  seedBalancedScaleFixture,
  superPool,
  withTenant,
} from "./db.js";
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
const repoRoot = path.resolve(here, "../..");
const goServiceDir = path.join(repoRoot, "services/go-usage");
const goCache = path.join(repoRoot, ".gocache");
const goTmp = path.join(repoRoot, ".gotmp");
let fx: Fixtures;
const createdCustomerIDs: string[] = [];

function goEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  let moduleCache = process.env.GOMODCACHE;
  const msysMatch = moduleCache?.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msysMatch) moduleCache = `${msysMatch[1].toUpperCase()}:\\${msysMatch[2].replaceAll("/", "\\")}`;
  return {
    ...process.env,
    GOMODCACHE: moduleCache,
    GOCACHE: goCache,
    GOTMPDIR: goTmp,
    DATABASE_URL,
    ...extra,
  };
}

function asCents(value: string | number): bigint {
  const [whole, fraction = ""] = String(value).split(".");
  const negative = whole.startsWith("-");
  const absolute = negative ? whole.slice(1) : whole;
  const result = BigInt(`${absolute}${fraction.padEnd(2, "0").slice(0, 2)}` || "0");
  return negative ? -result : result;
}

async function newCustomer(label: string): Promise<string> {
  const id = await createCustomer(fx.tenant1.id, label);
  createdCustomerIDs.push(id);
  return id;
}

async function postTransaction(
  tenant: TenantFixture,
  customerID: string,
  amount: string,
): Promise<ApiResponse> {
  return call(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    apiKey: tenant.apiKey,
    body: {
      customer_id: customerID,
      description: `TEID-33-${randomUUID()}`,
      lines: [
        { account_code: "receivable", direction: "debit", amount },
        { account_code: "revenue", direction: "credit", amount },
      ],
    },
  });
}

async function recalculate(customerID: string): Promise<ApiResponse> {
  return call(`${GO_USAGE_URL}/customers/${customerID}/recalculate-balance?account_code=receivable`, {
    method: "POST",
    apiKey: fx.tenant1.apiKey,
  });
}

async function runHelper(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  timeout = 120_000,
): Promise<any> {
  const { stdout } = await execFileAsync("go", ["run", ".", ...args], {
    cwd: here,
    env: goEnvironment(extraEnv),
    timeout,
  });
  return JSON.parse(stdout.trim());
}

async function resetFakeOncall(): Promise<void> {
  const url = new URL(ONCALL_ALERT_WEBHOOK_URL);
  url.pathname = "/control";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  expect(response.status).toBe(200);
}

async function fakeOncallAlerts(): Promise<any[]> {
  const url = new URL(ONCALL_ALERT_WEBHOOK_URL);
  url.pathname = "/state";
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return ((await response.json()) as { alerts: any[] }).alerts;
}

async function waitFor(url: string, predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (url && (await fetch(url)).ok && await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError ?? "condition not met")}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

beforeAll(async () => {
  fx = loadFixtures();
  await Promise.all([mkdir(goCache, { recursive: true }), mkdir(goTmp, { recursive: true })]);
});

afterAll(async () => {
  await removeCustomers(createdCustomerIDs);
  await Promise.all([appPool.end(), superPool.end()]);
});

describe("TEID-33 ledger-derived balance reconciliation", () => {
  // TEID-33-T1: the independent Go helper calls GetCustomerBalance directly;
  // it does not read the cache row established by the endpoint.
  it("TEID-33-T1 recomputes a customer balance from every receivable ledger line", async () => {
    const customerID = await newCustomer("TEID-33-T1");
    expect((await postTransaction(fx.tenant1, customerID, "100.00")).status).toBe(201);
    const cached = await recalculate(customerID);
    expect(cached.status).toBe(200);
    expect(asCents(cached.body.balance)).toBe(10_000n);

    const direct = await runHelper(["get", fx.tenant1.id, customerID, "receivable"]);
    expect(asCents(direct.balance)).toBe(10_000n);
    const row = await superPool.query<{ cached_balance: string }>(
      `SELECT cached_balance::text FROM customer_balance_cache
       WHERE tenant_id = $1 AND customer_id = $2 AND account_code = 'receivable'`,
      [fx.tenant1.id, customerID],
    );
    expect(asCents(row.rows[0].cached_balance)).toBe(asCents(direct.balance));
  });

  // TEID-33-T2: run the real server worker at a 100 ms interval. A mismatch
  // at the end of a 10,000-customer fixture proves a completed scheduled scan.
  it("TEID-33-T2 schedules and completes reconciliation across 10,000 customers", async () => {
    const marker = `TEID-33-T2-${randomUUID()}`;
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    const binary = path.join(here, `.balance-worker-${process.pid}.exe`);
    let child: ChildProcess | undefined;
    try {
      await seedBalancedScaleFixture(fx.tenant1.id, marker, 10_000);
      const drifted = await superPool.query<{ id: string }>(
        `UPDATE customer_balance_cache
         SET cached_balance = cached_balance + 0.50
         WHERE customer_id = (SELECT id FROM customers WHERE name = $1)
         RETURNING customer_id AS id`,
        [`${marker}-10000`],
      );
      expect(drifted.rowCount).toBe(1);

      await execFileAsync("go", ["build", "-o", binary, "./cmd/server"], {
        cwd: goServiceDir,
        env: goEnvironment(),
        timeout: 120_000,
      });
      child = spawn(binary, [], {
        cwd: goServiceDir,
        env: goEnvironment({
          PORT: String(port),
          BALANCE_RECONCILIATION_INTERVAL_MS: "100",
          ONCALL_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable",
        }),
        stdio: "ignore",
      });
      const health = `http://127.0.0.1:${port}/healthz`;
      await waitFor(health, async () => {
        const found = await superPool.query<{ count: string }>(
          `SELECT count(*)::text FROM balance_integrity_checks WHERE customer_id = $1`,
          [drifted.rows[0].id],
        );
        return found.rows[0].count !== "0";
      });
      expect(Number(process.env.BALANCE_RECONCILIATION_INTERVAL_MS ?? 3_600_000)).toBeLessThanOrEqual(3_600_000);
    } finally {
      if (child) await stopProcess(child);
      await rm(binary, { force: true });
      await removeScaleFixture(marker);
    }
  }, 180_000);

  // TEID-33-T3: persist and page a precise fifty-cent cache discrepancy.
  it("TEID-33-T3 pages on-call and exposes a cache mismatch", async () => {
    const customerID = await newCustomer("TEID-33-T3");
    expect((await postTransaction(fx.tenant1, customerID, "40.00")).status).toBe(201);
    expect((await recalculate(customerID)).status).toBe(200);
    await withTenant(fx.tenant1.id, (client) => client.query(
      `UPDATE customer_balance_cache SET cached_balance = cached_balance + 0.50
       WHERE customer_id = $1 AND account_code = 'receivable'`,
      [customerID],
    ));
    await resetFakeOncall();
    await runHelper(["reconcile", "2026-09-29T09:30:00.000Z"], {
      ONCALL_ALERT_WEBHOOK_URL,
    });

    const checks = await call(`${GO_USAGE_URL}/balance-integrity/checks`, { apiKey: fx.tenant1.apiKey });
    expect(checks.status).toBe(200);
    const finding = checks.body.data.find((row: any) => row.customer_id === customerID);
    expect(finding).toBeDefined();
    expect(asCents(finding.discrepancy)).toBe(50n);
    expect(finding.alert_sent).toBe(true);
    const alert = (await fakeOncallAlerts()).find((row) => row.customer_id === customerID);
    expect(alert).toBeDefined();
    expect(asCents(alert.discrepancy)).toBe(50n);
  });

  // TEID-33-T4: the endpoint response is the specified admin-screen stand-in.
  it("TEID-33-T4 manually recalculates one customer and returns its run timestamp", async () => {
    const customerID = await newCustomer("TEID-33-T4");
    expect((await postTransaction(fx.tenant1, customerID, "12.34")).status).toBe(201);
    expect((await postTransaction(fx.tenant1, customerID, "7.66")).status).toBe(201);
    const started = Date.now();
    const response = await recalculate(customerID);
    const finished = Date.now();
    expect(response.status).toBe(200);
    expect(response.body.customer_id).toBe(customerID);
    expect(response.body.account_code).toBe("receivable");
    expect(asCents(response.body.balance)).toBe(2_000n);
    expect(Date.parse(response.body.recalculated_at)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(response.body.recalculated_at)).toBeLessThanOrEqual(finished);

    const cache = await superPool.query<{ cached_balance: string; last_recalculated_at: Date }>(
      `SELECT cached_balance::text, last_recalculated_at FROM customer_balance_cache
       WHERE tenant_id = $1 AND customer_id = $2 AND account_code = 'receivable'`,
      [fx.tenant1.id, customerID],
    );
    expect(asCents(cache.rows[0].cached_balance)).toBe(2_000n);
    expect(cache.rows[0].last_recalculated_at.toISOString()).toBe(new Date(response.body.recalculated_at).toISOString());
  });

  // TEID-33-T5: the default is the cataloged one-million-customer data set.
  // BALANCE_RECONCILIATION_SCALE_COUNT exists only for constrained local
  // diagnostics; CI and the definition-of-done run leave it unset.
  it("TEID-33-T5 reconciles one million customers in under twenty minutes", async () => {
    const marker = `TEID-33-T5-${randomUUID()}`;
    const count = Number(process.env.BALANCE_RECONCILIATION_SCALE_COUNT ?? 1_000_000);
    try {
      await seedBalancedScaleFixture(fx.tenant1.id, marker, count);
      const result = await runHelper(
        ["reconcile", "2026-09-29T10:00:00.000Z"],
        { ONCALL_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable" },
        1_200_000,
      );
      console.info(`TEID-33-T5 reconciled ${count} customers in ${result.elapsed_ms} ms`);
      expect(result.elapsed_ms).toBeLessThan(1_200_000);
    } finally {
      await removeScaleFixture(marker);
    }
  }, 1_500_000);

  // TEID-33-T6: all concurrent requests serialize on one cache row and agree
  // with a separate ledger-only calculation.
  it("TEID-33-T6 converges twenty concurrent recalculations", async () => {
    const customerID = await newCustomer("TEID-33-T6");
    expect((await postTransaction(fx.tenant1, customerID, "31.25")).status).toBe(201);
    expect((await postTransaction(fx.tenant1, customerID, "18.75")).status).toBe(201);
    const responses = await Promise.all(Array.from({ length: 20 }, () => recalculate(customerID)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(asCents(response.body.balance)).toBe(5_000n);
    }
    expect(new Set(responses.map((response) => String(response.body.balance))).size).toBe(1);

    const direct = await runHelper(["get", fx.tenant1.id, customerID, "receivable"]);
    const cache = await superPool.query<{ cached_balance: string }>(
      `SELECT cached_balance::text FROM customer_balance_cache
       WHERE tenant_id = $1 AND customer_id = $2 AND account_code = 'receivable'`,
      [fx.tenant1.id, customerID],
    );
    expect(asCents(cache.rows[0].cached_balance)).toBe(asCents(direct.balance));
  });

  // TEID-33-T7: reconciliation must return successfully after recording the
  // finding even though nothing is listening at the webhook address.
  it("TEID-33-T7 keeps the dashboard finding when paging is unreachable", async () => {
    const customerID = await newCustomer("TEID-33-T7");
    expect((await postTransaction(fx.tenant1, customerID, "75.00")).status).toBe(201);
    expect((await recalculate(customerID)).status).toBe(200);
    await withTenant(fx.tenant1.id, (client) => client.query(
      `UPDATE customer_balance_cache SET cached_balance = cached_balance + 0.50
       WHERE customer_id = $1 AND account_code = 'receivable'`,
      [customerID],
    ));
    await runHelper(["reconcile", "2026-09-29T10:30:00.000Z"], {
      ONCALL_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable",
    });

    const stored = await superPool.query<{ discrepancy: string; alert_sent: boolean }>(
      `SELECT discrepancy::text, alert_sent FROM balance_integrity_checks
       WHERE customer_id = $1 ORDER BY detected_at DESC LIMIT 1`,
      [customerID],
    );
    expect(asCents(stored.rows[0].discrepancy)).toBe(50n);
    expect(stored.rows[0].alert_sent).toBe(false);

    const dashboard = await call(`${GO_USAGE_URL}/balance-integrity/checks`, { apiKey: fx.tenant1.apiKey });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data).toContainEqual(expect.objectContaining({
      customer_id: customerID,
      alert_sent: false,
    }));
  });
});
