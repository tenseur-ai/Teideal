import type { Pool } from "pg";
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
    const consumption = await client.query<ConsumptionAggregateRow>(
      `SELECT c.customer_id, l.source_category, SUM(l.amount)::text AS amount
       FROM usage_consumptions c
       JOIN usage_consumption_lines l
         ON l.consumption_id = c.id AND l.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
         AND c.occurred_at >= $2
         AND c.occurred_at < $3
       GROUP BY c.customer_id, l.source_category`,
      [input.tenantId, input.periodStart, input.periodEnd],
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
    return { customers: customers.rows, consumption: consumption.rows, expiries: expiries.rows };
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

  // Customers are the authoritative left side. Activity tables only enrich
  // these rows, so an inactive customer is represented by explicit zeroes.
  let rows = local.customers.map((customer): PeriodCloseSummaryRow => {
    const breakdown = credits.get(customer.id) ?? ZERO_CREDITS();
    const ledgerRow = ledger.get(customer.id);
    return {
      customer_id: customer.id,
      customer_name: customer.name,
      usage_billed: ledgerRow?.usage_billed ?? "0",
      credits_consumed_by_source: breakdown,
      commit_drawn_down: breakdown.commit,
      overage: breakdown.overage,
      expired_credits: expired.get(customer.id) ?? "0",
      adjustments: ledgerRow?.adjustments ?? "0",
    };
  });

  const search = input.search?.trim().toLocaleLowerCase();
  if (search) rows = rows.filter((row) => row.customer_name.toLocaleLowerCase().includes(search));
  sortRows(rows, input.sort ?? "name");
  return rows;
}
