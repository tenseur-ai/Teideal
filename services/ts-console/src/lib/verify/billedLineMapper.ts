import type { Pool } from "pg";
import { withTenant } from "../db.js";

export interface BilledLineMappingResult {
  mapped_lines: number;
  unmapped_customers: number;
}

const RESOLVED_CUSTOMER_LINKS = `
  SELECT tenant_id,
         stripe_customer_id,
         (array_agg(customer_id ORDER BY created_at, id))[1] AS customer_id
  FROM stripe_customer_links
  GROUP BY tenant_id, stripe_customer_id
  HAVING count(*) = 1
`;

/**
 * Builds Verify's billed-side read model from the current invoice landing
 * records. Decimal fields are cast directly from JSONB to NUMERIC by
 * PostgreSQL and never pass through a JavaScript number.
 */
export async function mapBilledLines(
  pool: Pool,
  tenantId: string,
): Promise<BilledLineMappingResult> {
  return withTenant(pool, tenantId, async (client) => {
    const unmapped = await client.query(
      `WITH resolved_customer_links AS (${RESOLVED_CUSTOMER_LINKS}),
            unmapped_invoices AS (
         SELECT DISTINCT invoice.tenant_id,
                         invoice.connector_id,
                         invoice.data->>'customer_id' AS stripe_customer_id,
                         customer.data->>'name' AS stripe_customer_name
         FROM connector_records AS invoice
         LEFT JOIN resolved_customer_links AS link
           ON link.tenant_id = invoice.tenant_id
          AND link.stripe_customer_id = invoice.data->>'customer_id'
         LEFT JOIN LATERAL (
           SELECT record.data
           FROM connector_records AS record
           WHERE record.connector_id = invoice.connector_id
             AND record.entity_type = 'customer'
             AND record.external_id = invoice.data->>'customer_id'
           ORDER BY record.synced_at DESC, record.id
           LIMIT 1
         ) AS customer ON true
         WHERE invoice.tenant_id = $1
           AND invoice.entity_type = 'invoice'
           AND link.customer_id IS NULL
           AND nullif(invoice.data->>'customer_id', '') IS NOT NULL
       )
       INSERT INTO verify_unmapped_customers (
         tenant_id, connector_id, stripe_customer_id, stripe_customer_name
       )
       SELECT tenant_id, connector_id, stripe_customer_id, stripe_customer_name
       FROM unmapped_invoices
       ON CONFLICT (tenant_id, connector_id, stripe_customer_id)
       DO NOTHING`,
      [tenantId],
    );

    const mapped = await client.query(
      `WITH resolved_customer_links AS (${RESOLVED_CUSTOMER_LINKS}),
            invoice_lines AS (
         SELECT invoice.tenant_id,
                invoice.connector_id,
                link.customer_id,
                line.id AS stripe_invoice_line_id,
                line.price_id,
                line.period_start,
                line.period_end,
                line.quantity,
                line.amount,
                line.currency
         FROM connector_records AS invoice
         JOIN resolved_customer_links AS link
           ON link.tenant_id = invoice.tenant_id
          AND link.stripe_customer_id = invoice.data->>'customer_id'
         CROSS JOIN LATERAL jsonb_to_recordset(
           CASE
             WHEN jsonb_typeof(invoice.data->'lines') = 'array' THEN invoice.data->'lines'
             ELSE '[]'::jsonb
           END
         ) AS line(
           id text,
           price_id text,
           period_start timestamptz,
           period_end timestamptz,
           quantity numeric,
           amount numeric,
           currency text
         )
         WHERE invoice.tenant_id = $1
           AND invoice.entity_type = 'invoice'
           -- A one-off Stripe invoice item (not tied to a subscription) can
           -- legitimately have no period bounds at all. verify_billed_lines
           -- requires both (it exists to compare against a period's expected
           -- revenue, which a periodless line can't be), so such a line is
           -- excluded here rather than failing this entire INSERT for every
           -- other line in the tenant's data.
           AND line.period_start IS NOT NULL
           AND line.period_end IS NOT NULL
       )
       INSERT INTO verify_billed_lines (
         tenant_id, customer_id, connector_id, stripe_invoice_line_id,
         price_id, period_start, period_end, quantity, amount, currency
       )
       SELECT tenant_id, customer_id, connector_id, stripe_invoice_line_id,
              price_id, period_start, period_end, quantity, amount, currency
       FROM invoice_lines
       ON CONFLICT (tenant_id, stripe_invoice_line_id)
       DO UPDATE SET
         customer_id = excluded.customer_id,
         connector_id = excluded.connector_id,
         price_id = excluded.price_id,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         quantity = excluded.quantity,
         amount = excluded.amount,
         currency = excluded.currency,
         mapped_at = now()
       WHERE (
         verify_billed_lines.customer_id,
         verify_billed_lines.connector_id,
         verify_billed_lines.price_id,
         verify_billed_lines.period_start,
         verify_billed_lines.period_end,
         verify_billed_lines.quantity,
         verify_billed_lines.amount,
         verify_billed_lines.currency
       ) IS DISTINCT FROM (
         excluded.customer_id,
         excluded.connector_id,
         excluded.price_id,
         excluded.period_start,
         excluded.period_end,
         excluded.quantity,
         excluded.amount,
         excluded.currency
       )`,
      [tenantId],
    );

    return {
      mapped_lines: mapped.rowCount ?? 0,
      unmapped_customers: unmapped.rowCount ?? 0,
    };
  });
}
