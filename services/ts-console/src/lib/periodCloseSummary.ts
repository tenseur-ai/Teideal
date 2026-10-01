import type { Pool, PoolClient } from "pg";
import { withTenant } from "./db.js";
import { getPeriodCloseLedgerSummary } from "./goUsageClient.js";

export const CREDIT_SOURCES = ["paid", "promotional", "commit", "goodwill", "overage"] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];
export type PeriodCloseSort = "name" | "usage_billed";

export interface CreditsConsumedBySource {
  paid: string;
  promotional: string;
  commit: string;
  goodwill: string;
  overage: string;
}

export interface PeriodCloseSummaryRow {
  customer_id: string;
  customer_name: string;
  usage_billed: string;
  credits_consumed_by_source: CreditsConsumedBySource;
  commit_drawn_down: string;
  overage: string;
  expired_credits: string;
  adjustments: string;
  last_stripe_sync_status: "running" | "succeeded" | "failed" | null;
  last_stripe_sync_error: string | null;
}

export type InvoiceSyncCategory = "usage" | "overage";

export interface PeriodCloseCategoryTotal {
  amount: string;
  line_ids: string[];
}

export interface PeriodCloseInvoiceTotals {
  usage: PeriodCloseCategoryTotal;
  overage: PeriodCloseCategoryTotal;
}

export interface PeriodCloseSummaryInput {
  pool: Pool;
  tenantId: string;
  authorization: string;
  periodStart: string;
  periodEnd: string;
  search?: string;
  sort?: PeriodCloseSort;
}

interface CustomerRow {
  id: string;
  name: string;
}

interface ConsumptionAggregateRow {
  customer_id: string;
  source_category: string;
  amount: string;
  line_ids: string[] | null;
}

interface SyncStatusRow {
  customer_id: string;
  status: "running" | "succeeded" | "failed";
  error_message: string | null;
}

interface ExpiryAggregateRow {
  customer_id: string;
  expired_credits: string;
}

const ZERO_CREDITS = (): CreditsConsumedBySource => ({
  paid: "0",
  promotional: "0",
  commit: "0",
  goodwill: "0",
  overage: "0",
});

function decimalParts(value: string): { negative: boolean; whole: string; fraction: string } {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { negative: false, whole: "0", fraction: "" };
  const whole = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const zero = whole === "0" && fraction === "";
  return { negative: Boolean(match[1]) && !zero, whole, fraction };
}

function parseDecimalParts(value: string): { negative: boolean; digits: bigint; scale: number } {
  const parts = decimalParts(value);
  const digits = BigInt(`${parts.whole}${parts.fraction}` || "0");
  return { negative: parts.negative, digits: parts.negative ? -digits : digits, scale: parts.fraction.length };
}

function formatDecimalParts(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const rendered = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const normalized = rendered.includes(".") ? rendered.replace(/0+$/, "").replace(/\.$/, "") : rendered;
  return `${negative ? "-" : ""}${normalized}`;
}

export function addDecimalStrings(left: string, right: string): string {
  const a = parseDecimalParts(left);
  const b = parseDecimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const sum = a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale);
  return formatDecimalParts(sum, scale);
}

export function decimalToMinorUnits(amount: string, minorDigits = 2): string {
  const parsed = parseDecimalParts(amount);
  if (parsed.scale > minorDigits) {
    throw new Error(`amount ${amount} has more than ${minorDigits} decimal places`);
  }
  const scaled = parsed.digits * 10n ** BigInt(minorDigits - parsed.scale);
  return scaled.toString();
}

export function isZeroDecimal(amount: string): boolean {
  return compareDecimalStrings(amount, "0") === 0;
}

export function emptyCategoryTotal(): PeriodCloseCategoryTotal {
  return { amount: "0", line_ids: [] };
}

export function buildPeriodCloseInvoiceTotals(
  aggregates: ConsumptionAggregateRow[],
): PeriodCloseInvoiceTotals {
  const usage = emptyCategoryTotal();
  const overage = emptyCategoryTotal();
  for (const aggregate of aggregates) {
    if (!CREDIT_SOURCES.includes(aggregate.source_category as CreditSource)) continue;
    const lineIds = aggregate.line_ids ?? [];
    if (aggregate.source_category === "overage") {
      overage.amount = addDecimalStrings(overage.amount, aggregate.amount);
      overage.line_ids.push(...lineIds);
    } else {
      usage.amount = addDecimalStrings(usage.amount, aggregate.amount);
      usage.line_ids.push(...lineIds);
    }
  }
  return { usage, overage };
}

export async function loadPeriodCloseConsumption(
  client: PoolClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
  customerId?: string,
): Promise<ConsumptionAggregateRow[]> {
  const { rows } = await client.query<ConsumptionAggregateRow>(
    `SELECT c.customer_id, l.source_category, SUM(l.amount)::text AS amount,
            COALESCE(array_agg(l.id::text ORDER BY l.id), '{}') AS line_ids
     FROM usage_consumptions c
     JOIN usage_consumption_lines l
       ON l.consumption_id = c.id AND l.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1
       AND c.occurred_at >= $2
       AND c.occurred_at < $3
       AND ($4::uuid IS NULL OR c.customer_id = $4)
     GROUP BY c.customer_id, l.source_category`,
    [tenantId, periodStart, periodEnd, customerId ?? null],
  );
  return rows;
}

export async function periodCloseInvoiceTotals(input: {
  pool: Pool;
  tenantId: string;
  customerId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<PeriodCloseInvoiceTotals> {
  return withTenant(input.pool, input.tenantId, async (client) => {
    const aggregates = await loadPeriodCloseConsumption(
      client,
      input.tenantId,
      input.periodStart,
      input.periodEnd,
      input.customerId,
    );
    return buildPeriodCloseInvoiceTotals(aggregates);
  });
}

// Compare Postgres NUMERIC text without converting through a binary float.
export function compareDecimalStrings(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  let magnitude = a.whole.length - b.whole.length;
  if (magnitude === 0) magnitude = a.whole.localeCompare(b.whole);
  if (magnitude === 0) {
    const width = Math.max(a.fraction.length, b.fraction.length);
    magnitude = a.fraction.padEnd(width, "0").localeCompare(b.fraction.padEnd(width, "0"));
  }
  return a.negative ? -magnitude : magnitude;
}

function sortRows(rows: PeriodCloseSummaryRow[], sort: PeriodCloseSort): void {
  rows.sort((left, right) => {
    const primary = sort === "usage_billed"
      ? compareDecimalStrings(left.usage_billed, right.usage_billed)
      : left.customer_name.localeCompare(right.customer_name, undefined, { sensitivity: "base" });
    return primary || left.customer_id.localeCompare(right.customer_id);
  });
}

export async function generatePeriodCloseSummary(input: PeriodCloseSummaryInput): Promise<PeriodCloseSummaryRow[]> {
  const localPromise = withTenant(input.pool, input.tenantId, async (client) => {
    const customers = await client.query<CustomerRow>(
      `SELECT id, name
       FROM customers
       WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const consumption = await loadPeriodCloseConsumption(
      client,
      input.tenantId,
      input.periodStart,
      input.periodEnd,
    );
    const expiries = await client.query<ExpiryAggregateRow>(
      `SELECT g.customer_id, SUM(-e.amount)::text AS expired_credits
       FROM grant_ledger_entries e
       JOIN grants g ON g.id = e.grant_id AND g.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND e.entry_type = 'expired'
         AND e.occurred_at >= $2
         AND e.occurred_at < $3
       GROUP BY g.customer_id`,
      [input.tenantId, input.periodStart, input.periodEnd],
    );
    const syncStatus = await client.query<SyncStatusRow>(
      `SELECT DISTINCT ON (customer_id)
              customer_id, status, error_message
       FROM period_close_invoice_sync_attempts
       WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3
       ORDER BY customer_id, started_at DESC`,
      [input.tenantId, input.periodStart, input.periodEnd],
    );
    return {
      customers: customers.rows,
      consumption,
      expiries: expiries.rows,
      syncStatus: syncStatus.rows,
    };
  });

  const [local, ledgerRows] = await Promise.all([
    localPromise,
    getPeriodCloseLedgerSummary(input.authorization, input.periodStart, input.periodEnd),
  ]);

  const credits = new Map<string, CreditsConsumedBySource>();
  for (const aggregate of local.consumption) {
    if (!CREDIT_SOURCES.includes(aggregate.source_category as CreditSource)) continue;
    const breakdown = credits.get(aggregate.customer_id) ?? ZERO_CREDITS();
    breakdown[aggregate.source_category as CreditSource] = aggregate.amount;
    credits.set(aggregate.customer_id, breakdown);
  }
  const expired = new Map(local.expiries.map((row) => [row.customer_id, row.expired_credits]));
  const ledger = new Map(ledgerRows.map((row) => [row.customer_id, row]));
  const sync = new Map(local.syncStatus.map((row) => [row.customer_id, row]));

  // Customers are the authoritative left side. Activity tables only enrich
  // these rows, so an inactive customer is represented by explicit zeroes.
  let rows = local.customers.map((customer): PeriodCloseSummaryRow => {
    const breakdown = credits.get(customer.id) ?? ZERO_CREDITS();
    const ledgerRow = ledger.get(customer.id);
    const syncRow = sync.get(customer.id);
    return {
      customer_id: customer.id,
      customer_name: customer.name,
      usage_billed: ledgerRow?.usage_billed ?? "0",
      credits_consumed_by_source: breakdown,
      commit_drawn_down: breakdown.commit,
      overage: breakdown.overage,
      expired_credits: expired.get(customer.id) ?? "0",
      adjustments: ledgerRow?.adjustments ?? "0",
      last_stripe_sync_status: syncRow?.status ?? null,
      last_stripe_sync_error: syncRow?.error_message ?? null,
    };
  });

  const search = input.search?.trim().toLocaleLowerCase();
  if (search) rows = rows.filter((row) => row.customer_name.toLocaleLowerCase().includes(search));
  sortRows(rows, input.sort ?? "name");
  return rows;
}
