import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePeriodCloseSummary, type PeriodCloseSummaryRow } from "../../services/ts-console/src/lib/periodCloseSummary.js";
import {
  appPool,
  bulkSeed50k,
  cleanupMarker,
  createCustomer,
  directRevenueTotal,
  seedCompleteActivity,
  superPool,
  withTenant,
} from "./db.js";
import { API_KEY, GO_USAGE_URL, TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { financeSession, supportSession } from "./session.js";

const suiteMarker = `teid-50-${randomUUID()}`;
let financeToken: string;

function summaryUrl(params: Record<string, string> = {}): string {
  const url = new URL("/period-close-summary", TS_CONSOLE_URL);
  url.searchParams.set("period", "2026-08");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function findSummaryRow(customerId: string, name: string): Promise<PeriodCloseSummaryRow> {
  const response = await call(summaryUrl({ search: name, limit: "500" }), { token: financeToken });
  expect(response.status).toBe(200);
  const row = (response.body.data as PeriodCloseSummaryRow[]).find((entry) => entry.customer_id === customerId);
  expect(row).toBeTruthy();
  return row!;
}

function parseDecimal(value: string): { value: bigint; scale: number } {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const parsed = BigInt(`${whole || "0"}${fraction}`);
  return { value: negative ? -parsed : parsed, scale: fraction.length };
}

function sumDecimals(values: string[]): string {
  const parsed = values.map(parseDecimal);
  const scale = Math.max(0, ...parsed.map((entry) => entry.scale));
  const sum = parsed.reduce((total, entry) => total + entry.value * 10n ** BigInt(scale - entry.scale), 0n);
  const negative = sum < 0n;
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, "0");
  const rendered = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const normalized = rendered.includes(".") ? rendered.replace(/0+$/, "").replace(/\.$/, "") : rendered;
  return `${negative ? "-" : ""}${normalized}`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  return rows;
}

async function queueApproveAndPostLedger(customerId: string, amount: string, marker: string): Promise<void> {
  await withTenant(TENANT_ID, (client) => client.query(
    `INSERT INTO customer_billing_config (tenant_id, customer_id, billing_timezone, billing_anchor_day)
     VALUES ($1, $2, 'UTC', 1)
     ON CONFLICT (customer_id) DO UPDATE SET billing_timezone = 'UTC', billing_anchor_day = 1`,
    [TENANT_ID, customerId],
  ).then(() => undefined));
  const queued = await call(`${GO_USAGE_URL}/usage`, {
    method: "POST",
    apiKey: API_KEY,
    body: {
      customer_id: customerId,
      event_type: "tokens.in",
      quantity: amount,
      idempotency_key: `${marker}-${randomUUID()}`,
      occurred_at: "2026-08-18T12:00:00Z",
    },
  });
  expect(queued.status).toBe(202);
  const approved = await call(`${GO_USAGE_URL}/adjustments/${queued.body.adjustment_id}/approve`, {
    method: "POST",
    apiKey: API_KEY,
  });
  expect(approved.status).toBe(200);

  // TEID-34 owns approval, while pricing/posting is a later pipeline step.
  // Seed that resulting ledger post with its August accounting timestamp so
  // both live aggregates observe the newly approved late adjustment.
  await withTenant(TENANT_ID, async (client) => {
    const transactionId = randomUUID();
    await client.query(
      `INSERT INTO ledger_transactions (id, tenant_id, customer_id, usage_event_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, '2026-08-31T23:00:00Z')`,
      [transactionId, TENANT_ID, customerId, approved.body.resulting_usage_event_id, marker],
    );
    await client.query(
      `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       VALUES ($1, $2, 'receivable', 'debit', $3), ($1, $2, 'revenue', 'credit', $3)`,
      [TENANT_ID, transactionId, amount],
    );
  });
}

beforeAll(async () => {
  financeToken = await financeSession();
});

afterAll(async () => {
  await cleanupMarker(TENANT_ID, suiteMarker);
  await Promise.all([appPool.end(), superPool.end()]);
});

describe("TEID-50 period close", () => {
  it("TEID-50-T1 reports every required ledger and credit-balance figure for acct_7007", async () => {
    const name = `${suiteMarker}-acct_7007`;
    const customerId = await createCustomer(TENANT_ID, name);
    await seedCompleteActivity(TENANT_ID, customerId, `${suiteMarker}-t1`);

    const row = await findSummaryRow(customerId, name);
    expect(row.usage_billed).not.toBe("0");
    expect(row.credits_consumed_by_source).toEqual({
      paid: "30",
      promotional: "5",
      commit: "20",
      goodwill: "3",
      overage: "7",
    });
    expect(row.commit_drawn_down).toBe(row.credits_consumed_by_source.commit);
    expect(row.overage).toBe(row.credits_consumed_by_source.overage);
    expect(row.expired_credits).toBe("10");
    expect(row.adjustments).toBe("5.00");
  });

  it("TEID-50-T2 ties total August usage billed exactly to Teideal's revenue ledger", async () => {
    const name = `${suiteMarker}-t2-ledger-tie`;
    const customerId = await createCustomer(TENANT_ID, name);
    await seedCompleteActivity(TENANT_ID, customerId, `${suiteMarker}-t2`);

    const response = await call(summaryUrl({ limit: "500" }), { token: financeToken });
    expect(response.status).toBe(200);
    const rows: PeriodCloseSummaryRow[] = [...response.body.data];
    let cursor = response.body.next_cursor as string | null;
    while (cursor) {
      const page = await call(summaryUrl({ limit: "500", cursor }), { token: financeToken });
      expect(page.status).toBe(200);
      rows.push(...page.body.data);
      cursor = page.body.next_cursor;
    }
    expect(sumDecimals(rows.map((row) => row.usage_billed))).toBe(sumDecimals([await directRevenueTotal(TENANT_ID)]));

    // No Stripe invoice/charge reconciliation source exists before E11/Verify;
    // this cataloged test intentionally performs only the real ledger tie-out.
  });

  it("TEID-50-T3 exports CSV and Excel files with identical figures", async () => {
    const name = `${suiteMarker}-t3-export`;
    const customerId = await createCustomer(TENANT_ID, name);
    await seedCompleteActivity(TENANT_ID, customerId, `${suiteMarker}-t3`);
    const [csv, xlsx] = await Promise.all([
      call(summaryUrl({ search: suiteMarker, sort: "name", format: "csv" }), { token: financeToken }),
      call(summaryUrl({ search: suiteMarker, sort: "name", format: "xlsx" }), { token: financeToken }),
    ]);
    expect(csv.status).toBe(200);
    expect(xlsx.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect(xlsx.headers.get("content-disposition")).toContain("attachment");

    const csvRows = parseCsv(csv.body as string);
    const requireFromConsole = createRequire(new URL("../../services/ts-console/package.json", import.meta.url));
    const ExcelJS = requireFromConsole("exceljs") as any;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.bytes);
    const worksheet = workbook.worksheets[0];
    const xlsxRows: string[][] = [];
    worksheet.eachRow((row: any) => {
      xlsxRows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? "")));
    });
    expect(xlsxRows).toEqual(csvRows);
    expect(csvRows.some((row) => row[0] === customerId)).toBe(true);
  });

  it("TEID-50-T4 summarizes 50,000 bulk-seeded customers within the 30-minute close window", async () => {
    const marker = `${suiteMarker}-t4-bulk`;
    try {
      await bulkSeed50k(TENANT_ID, marker);
      const started = performance.now();
      const rows = await generatePeriodCloseSummary({
        pool: appPool,
        tenantId: TENANT_ID,
        authorization: `Bearer ${financeToken}`,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        search: marker,
        sort: "name",
      });
      const elapsed = performance.now() - started;
      expect(rows).toHaveLength(50_000);
      expect(elapsed).toBeLessThan(30 * 60 * 1000);

      const samples = rows.filter((_row, index) => index % 2500 === 0).slice(0, 20);
      const direct = await withTenant(TENANT_ID, async (client) => (await client.query<{ customer_id: string; amount: string }>(
        `SELECT t.customer_id, SUM(l.amount)::text AS amount
         FROM ledger_transactions t
         JOIN ledger_lines l ON l.transaction_id = t.id
         WHERE t.customer_id = ANY($1::uuid[]) AND l.account_code = 'revenue' AND l.direction = 'credit'
           AND t.created_at >= '2026-08-01T00:00:00Z' AND t.created_at < '2026-09-01T00:00:00Z'
         GROUP BY t.customer_id`,
        [samples.map((row) => row.customer_id)],
      )).rows);
      const expected = new Map(direct.map((row) => [row.customer_id, row.amount]));
      for (const row of samples) expect(row.usage_billed).toBe(expected.get(row.customer_id));
    } finally {
      await cleanupMarker(TENANT_ID, marker);
    }
  }, 1_900_000);

  it("TEID-50-T5 sorts by customer name, searches case-insensitively, and role-gates the screen", async () => {
    const names = [
      `${suiteMarker}-t5-Zulu Finance`,
      `${suiteMarker}-t5-alpha Finance`,
      `${suiteMarker}-t5-Middle Needle`,
    ];
    await Promise.all(names.map((name) => createCustomer(TENANT_ID, name)));
    const sorted = await call(summaryUrl({ search: `${suiteMarker}-t5-`, sort: "name" }), { token: financeToken });
    expect(sorted.status).toBe(200);
    expect((sorted.body.data as PeriodCloseSummaryRow[]).map((row) => row.customer_name)).toEqual([
      names[1], names[2], names[0],
    ]);
    const searched = await call(summaryUrl({ search: "mIdDlE nEeDlE", sort: "name" }), { token: financeToken });
    expect(searched.status).toBe(200);
    expect((searched.body.data as PeriodCloseSummaryRow[]).map((row) => row.customer_name)).toEqual([names[2]]);

    const denied = await call(summaryUrl(), { token: await supportSession() });
    expect(denied.status).toBe(403);
  });

  it("TEID-50-T6 reflects an approved late adjustment on the next live read", async () => {
    const name = `${suiteMarker}-t6-late`;
    const customerId = await createCustomer(TENANT_ID, name);
    const before = await findSummaryRow(customerId, name);
    await queueApproveAndPostLedger(customerId, "12.34", `${suiteMarker}-t6`);
    const after = await findSummaryRow(customerId, name);

    expect(after.adjustments).toBe("12.34");
    expect(after.usage_billed).toBe("12.34");
    expect(after.adjustments).not.toBe(before.adjustments);
    expect(after.usage_billed).not.toBe(before.usage_billed);
    expect(sumDecimals([await directRevenueTotal(TENANT_ID)])).toBe(
      sumDecimals((await generatePeriodCloseSummary({
        pool: appPool,
        tenantId: TENANT_ID,
        authorization: `Bearer ${financeToken}`,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      })).map((row) => row.usage_billed)),
    );
  });

  it("TEID-50-T7 includes a zero-activity customer with complete zero values", async () => {
    const name = `${suiteMarker}-t7-zero`;
    const customerId = await createCustomer(TENANT_ID, name);
    const row = await findSummaryRow(customerId, name);
    expect(row).toEqual({
      customer_id: customerId,
      customer_name: name,
      usage_billed: "0",
      credits_consumed_by_source: { paid: "0", promotional: "0", commit: "0", goodwill: "0", overage: "0" },
      commit_drawn_down: "0",
      overage: "0",
      expired_credits: "0",
      adjustments: "0",
    });
  });
});
