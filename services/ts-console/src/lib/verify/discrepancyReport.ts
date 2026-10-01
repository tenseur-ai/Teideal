import type { Pool } from "pg";
import { withTenant } from "../db.js";
import { generatePeriodCloseSummary } from "../periodCloseSummary.js";

export const DEFAULT_QUANTITY_TOLERANCE = "0.01";

export type DiscrepancyClassification =
  | "missing_line"
  | "quantity"
  | "rate_drift"
  | "known_coverage_gap";

interface Decimal {
  digits: bigint;
  scale: number;
}

interface BilledLineRow {
  id: string;
  customer_id: string;
  connector_id: string;
  stripe_invoice_line_id: string;
  price_id: string;
  period_start: Date;
  period_end: Date;
  quantity: string;
  amount: string;
  currency: string;
  mapped_at: Date;
  billed_total: string;
  billed_quantity: string;
  billed_line_count: string;
}

interface CoverageGapRow {
  customer_id: string;
  reasons: string[];
  connector_record_ids: string[];
}

interface UnmappedRow {
  customer_id: string;
  customer_name: string | null;
  billed_total: string;
  connector_record_ids: string[];
  stripe_invoice_line_ids: string[];
}

export interface DiscrepancyBilledLineEvidence {
  id: string;
  connector_id: string;
  stripe_invoice_line_id: string;
  price_id: string;
  period_start: string;
  period_end: string;
  quantity: string;
  amount: string;
  currency: string;
  mapped_at: string;
}

export interface DiscrepancyReportRow {
  customer_id: string;
  customer_name: string;
  expected_total: string;
  billed_total: string;
  delta: string;
  classification: DiscrepancyClassification | null;
  granularity: "period_total";
  evidence: {
    expected: {
      usage_billed: string;
      overage: string;
      ledger_line_ids: string[];
      overage_consumption_line_ids: string[];
      usage_event_ids: string[];
      usage_event_count: string;
      usage_quantity: string;
    };
    billed: {
      line_count: string;
      quantity: string;
      lines: DiscrepancyBilledLineEvidence[];
    };
    coverage_gaps: {
      reasons: string[];
      connector_record_ids: string[];
    };
  };
}

export interface DiscrepancyReport {
  data: DiscrepancyReportRow[];
  excluded: Array<{
    customer_id: string;
    customer_name: string | null;
    reason: "unmapped_customer";
    billed_total: string;
    evidence: { connector_record_ids: string[]; stripe_invoice_line_ids: string[] };
  }>;
  totals: {
    expected: string;
    billed: string;
    delta: string;
    excluded_billed: string;
  };
  granularity: "period_total";
  quantity_tolerance: string;
  caveats: string[];
}

export interface DiscrepancyReportInput {
  pool: Pool;
  tenantId: string;
  authorization: string;
  periodStart: string;
  periodEnd: string;
  quantityTolerance?: string;
}

function parseDecimal(value: string): Decimal {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`invalid decimal value: ${value}`);
  const fraction = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { digits: match[1] ? -magnitude : magnitude, scale: fraction.length };
}

function scaledDigits(value: Decimal, scale: number): bigint {
  return value.digits * 10n ** BigInt(scale - value.scale);
}

function formatDecimal(value: bigint, scale: number): string {
  const outputScale = Math.max(scale, 2);
  const scaled = value * 10n ** BigInt(outputScale - scale);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(outputScale + 1, "0");
  const rendered = outputScale === 0
    ? digits
    : `${digits.slice(0, -outputScale)}.${digits.slice(-outputScale)}`;
  return `${negative ? "-" : ""}${rendered}`;
}

function addDecimals(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return formatDecimal(scaledDigits(a, scale) + scaledDigits(b, scale), scale);
}

function subtractDecimals(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return formatDecimal(scaledDigits(a, scale) - scaledDigits(b, scale), scale);
}

function isZero(value: string): boolean {
  return parseDecimal(value).digits === 0n;
}

function quantitiesDiffer(independent: string, billed: string, tolerance: string): boolean {
  const expected = parseDecimal(independent);
  const actual = parseDecimal(billed);
  const toleranceValue = parseDecimal(tolerance);
  if (toleranceValue.digits < 0n) throw new Error("quantity tolerance cannot be negative");
  const commonScale = Math.max(expected.scale, actual.scale);
  const expectedDigits = scaledDigits(expected, commonScale);
  const actualDigits = scaledDigits(actual, commonScale);
  const difference = expectedDigits >= actualDigits
    ? expectedDigits - actualDigits
    : actualDigits - expectedDigits;
  const expectedMagnitude = expectedDigits < 0n ? -expectedDigits : expectedDigits;
  if (expectedMagnitude === 0n) return difference !== 0n;
  return difference * 10n ** BigInt(toleranceValue.scale)
    > expectedMagnitude * toleranceValue.digits;
}

function classify(input: {
  expectedTotal: string;
  billedTotal: string;
  delta: string;
  billedLineCount: string;
  independentQuantity: string;
  billedQuantity: string;
  coverageGapReasons: string[];
  tolerance: string;
}): DiscrepancyClassification | null {
  if (isZero(input.delta)) return null;
  if (!isZero(input.expectedTotal) && input.billedLineCount === "0" && isZero(input.billedTotal)) {
    // Coverage evidence distinguishes a known unsupported-activity-only period
    // from a genuinely missing invoice, but does not mask discrepancies when
    // overlapping billed lines exist.
    if (input.coverageGapReasons.length > 0) return "known_coverage_gap";
    return "missing_line";
  }
  if (quantitiesDiffer(input.independentQuantity, input.billedQuantity, input.tolerance)) {
    return "quantity";
  }
  return "rate_drift";
}

export async function generateDiscrepancyReport(input: DiscrepancyReportInput): Promise<DiscrepancyReport> {
  const tolerance = input.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE;
  // Validate once even if this period has no rows.
  quantitiesDiffer("0", "0", tolerance);

  const [summary, local] = await Promise.all([
    // Expected totals and their go-usage evidence have one authoritative path.
    generatePeriodCloseSummary({
      pool: input.pool,
      tenantId: input.tenantId,
      authorization: input.authorization,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sort: "name",
      includeEvidence: true,
    }),
    withTenant(input.pool, input.tenantId, async (client) => {
      const billed = await client.query<BilledLineRow>(
        `SELECT id::text, customer_id::text, connector_id::text,
                stripe_invoice_line_id, price_id, period_start, period_end,
                quantity::text, amount::text, currency, mapped_at,
                SUM(amount) OVER (PARTITION BY customer_id)::text AS billed_total,
                SUM(quantity) OVER (PARTITION BY customer_id)::text AS billed_quantity,
                COUNT(*) OVER (PARTITION BY customer_id)::text AS billed_line_count
         FROM verify_billed_lines
         WHERE tenant_id = $1 AND period_start < $3 AND period_end > $2
         ORDER BY customer_id, stripe_invoice_line_id, id`,
        [input.tenantId, input.periodStart, input.periodEnd],
      );

      const coverage = await client.query<CoverageGapRow>(
        `WITH resolved_customer_links AS (
           SELECT tenant_id, stripe_customer_id,
                  (array_agg(customer_id ORDER BY created_at, id))[1] AS customer_id
           FROM stripe_customer_links
           GROUP BY tenant_id, stripe_customer_id
           HAVING count(*) = 1
         ), non_invoice_activity AS (
           SELECT r.id, r.entity_type, r.connector_id,
                  CASE WHEN r.entity_type = 'refund'
                       THEN payment.data->>'customer_id'
                       ELSE r.data->>'customer_id' END AS stripe_customer_id,
                  CASE WHEN r.entity_type = 'credit' THEN nullif(r.data->>'issued_at', '')::timestamptz
                       WHEN r.entity_type = 'payment' THEN nullif(r.data->>'paid_at', '')::timestamptz
                       ELSE nullif(r.data->>'refunded_at', '')::timestamptz END AS activity_at
           FROM connector_records r
           LEFT JOIN connector_records payment
             ON r.entity_type = 'refund'
            AND payment.connector_id = r.connector_id
            AND payment.entity_type = 'payment'
            AND payment.external_id = r.data->>'payment_id'
           WHERE r.tenant_id = $1 AND r.entity_type IN ('credit', 'payment', 'refund')
         ), gaps AS (
           SELECT link.customer_id, activity.id AS connector_record_id,
                  'credit_payment_refund_not_mapped'::text AS reason
           FROM non_invoice_activity activity
           JOIN resolved_customer_links link
             ON link.tenant_id = $1 AND link.stripe_customer_id = activity.stripe_customer_id
           WHERE activity.activity_at >= $2 AND activity.activity_at < $3
           UNION ALL
           SELECT link.customer_id, invoice.id,
                  'invoice_line_not_mapped'::text AS reason
           FROM connector_records invoice
           JOIN resolved_customer_links link
             ON link.tenant_id = invoice.tenant_id
            AND link.stripe_customer_id = invoice.data->>'customer_id'
           CROSS JOIN LATERAL jsonb_to_recordset(
             CASE WHEN jsonb_typeof(invoice.data->'lines') = 'array'
                  THEN invoice.data->'lines' ELSE '[]'::jsonb END
           ) AS line(price_id text, period_start timestamptz, period_end timestamptz)
           WHERE invoice.tenant_id = $1 AND invoice.entity_type = 'invoice'
             AND (line.price_id IS NULL OR line.period_start IS NULL OR line.period_end IS NULL)
             AND (
               (line.period_start IS NOT NULL AND line.period_start >= $2 AND line.period_start < $3)
               OR (line.period_end IS NOT NULL AND line.period_end > $2 AND line.period_end <= $3)
               OR (nullif(invoice.data->>'period_start', '')::timestamptz < $3
                   AND nullif(invoice.data->>'period_end', '')::timestamptz > $2)
               OR (nullif(invoice.data->>'issued_at', '')::timestamptz > $2
                   AND nullif(invoice.data->>'issued_at', '')::timestamptz <= $3)
             )
         )
         SELECT customer_id::text,
                array_agg(DISTINCT reason ORDER BY reason) AS reasons,
                array_agg(DISTINCT connector_record_id::text ORDER BY connector_record_id::text) AS connector_record_ids
         FROM gaps GROUP BY customer_id ORDER BY customer_id`,
        [input.tenantId, input.periodStart, input.periodEnd],
      );

      const unmapped = await client.query<UnmappedRow>(
        `SELECT u.stripe_customer_id AS customer_id,
                max(u.stripe_customer_name) AS customer_name,
                SUM(line.amount)::text AS billed_total,
                array_agg(DISTINCT invoice.id::text ORDER BY invoice.id::text) AS connector_record_ids,
                array_agg(line.id ORDER BY line.id) AS stripe_invoice_line_ids
         FROM verify_unmapped_customers u
         JOIN connector_records invoice
           ON invoice.tenant_id = u.tenant_id
          AND invoice.connector_id = u.connector_id
          AND invoice.entity_type = 'invoice'
          AND invoice.data->>'customer_id' = u.stripe_customer_id
         CROSS JOIN LATERAL jsonb_to_recordset(
           CASE WHEN jsonb_typeof(invoice.data->'lines') = 'array'
                THEN invoice.data->'lines' ELSE '[]'::jsonb END
         ) AS line(id text, period_start timestamptz, period_end timestamptz, amount numeric)
         WHERE u.tenant_id = $1 AND line.period_start < $3 AND line.period_end > $2
         GROUP BY u.stripe_customer_id
         ORDER BY u.stripe_customer_id`,
        [input.tenantId, input.periodStart, input.periodEnd],
      );

      return { billed: billed.rows, coverage: coverage.rows, unmapped: unmapped.rows };
    }),
  ]);

  const billedByCustomer = new Map<string, BilledLineRow[]>();
  for (const line of local.billed) {
    const lines = billedByCustomer.get(line.customer_id) ?? [];
    lines.push(line);
    billedByCustomer.set(line.customer_id, lines);
  }
  const coverageByCustomer = new Map(local.coverage.map((row) => [row.customer_id, row]));

  const data = summary.map((expected): DiscrepancyReportRow => {
    const source = expected.expected_evidence!;
    const billedRows = billedByCustomer.get(expected.customer_id) ?? [];
    const billed = billedRows[0];
    const coverage = coverageByCustomer.get(expected.customer_id);
    const expectedTotal = addDecimals(expected.usage_billed, expected.overage);
    const billedTotal = billed ? formatDecimal(parseDecimal(billed.billed_total).digits, parseDecimal(billed.billed_total).scale) : "0.00";
    const delta = subtractDecimals(expectedTotal, billedTotal);
    const billedQuantity = billed?.billed_quantity ?? "0";
    const billedLineCount = billed?.billed_line_count ?? "0";
    const coverageReasons = coverage?.reasons ?? [];
    return {
      customer_id: expected.customer_id,
      customer_name: expected.customer_name,
      expected_total: expectedTotal,
      billed_total: billedTotal,
      delta,
      classification: classify({
        expectedTotal,
        billedTotal,
        delta,
        billedLineCount,
        independentQuantity: source.usage_quantity,
        billedQuantity,
        coverageGapReasons: coverageReasons,
        tolerance,
      }),
      granularity: "period_total",
      evidence: {
        expected: {
          usage_billed: expected.usage_billed,
          overage: expected.overage,
          ledger_line_ids: source.ledger_line_ids,
          overage_consumption_line_ids: source.overage_consumption_line_ids,
          usage_event_ids: source.usage_event_ids,
          usage_event_count: source.usage_event_count,
          usage_quantity: source.usage_quantity,
        },
        billed: {
          line_count: billedLineCount,
          quantity: billedQuantity,
          lines: billedRows.map((line) => ({
            id: line.id,
            connector_id: line.connector_id,
            stripe_invoice_line_id: line.stripe_invoice_line_id,
            price_id: line.price_id,
            period_start: line.period_start.toISOString(),
            period_end: line.period_end.toISOString(),
            quantity: line.quantity,
            amount: line.amount,
            currency: line.currency,
            mapped_at: line.mapped_at.toISOString(),
          })),
        },
        coverage_gaps: {
          reasons: coverageReasons,
          connector_record_ids: coverage?.connector_record_ids ?? [],
        },
      },
    };
  });

  let expectedTotal = "0.00";
  let billedTotal = "0.00";
  for (const row of data) {
    expectedTotal = addDecimals(expectedTotal, row.expected_total);
    billedTotal = addDecimals(billedTotal, row.billed_total);
  }
  let excludedBilled = "0.00";
  const excluded = local.unmapped.map((row) => {
    const amount = formatDecimal(parseDecimal(row.billed_total).digits, parseDecimal(row.billed_total).scale);
    excludedBilled = addDecimals(excludedBilled, amount);
    return {
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      reason: "unmapped_customer" as const,
      billed_total: amount,
      evidence: {
        connector_record_ids: row.connector_record_ids,
        stripe_invoice_line_ids: row.stripe_invoice_line_ids,
      },
    };
  });

  return {
    data,
    excluded,
    totals: {
      expected: expectedTotal,
      billed: billedTotal,
      delta: subtractDecimals(expectedTotal, billedTotal),
      excluded_billed: excludedBilled,
    },
    granularity: "period_total",
    quantity_tolerance: tolerance,
    caveats: [
      "Billed data reflects the last successful connector sync; Stripe-side deletions or voids can leave stale verify_billed_lines rows.",
      "Invoices synced before the period-flatten fix require a resync and remap (POST /verify/map-billed-lines again) before this report can be trusted for them.",
      "Credits and refunds are tracked as coverage-gap evidence only and are never subtracted from the billed total.",
      "This v0 report compares customer-period totals, not price-matched invoice lines.",
    ],
  };
}
