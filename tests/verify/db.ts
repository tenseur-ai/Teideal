import { randomUUID } from "node:crypto";
import pg from "pg";
import { SUPERUSER_DATABASE_URL, TENANT_ID } from "./env.js";

export const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });

export interface Fixture {
  connectorId: string;
  marker: string;
}

export interface BilledRow {
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
}

export interface ExpectedActivityEvidence {
  usageEventId: string;
  ledgerLineId: string;
  overageConsumptionLineId: string | null;
}

export async function createFixture(marker: string): Promise<Fixture> {
  const connectorId = randomUUID();
  await superPool.query(
    `INSERT INTO connectors (id, tenant_id, connector_type, display_name)
     VALUES ($1, $2, 'stripe', $3)`,
    [connectorId, TENANT_ID, marker],
  );
  return { connectorId, marker };
}

export async function createCustomer(fixture: Fixture, suffix: string): Promise<string> {
  const customerId = randomUUID();
  await superPool.query(
    `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)`,
    [customerId, TENANT_ID, `${fixture.marker}-${suffix}`, `${customerId}@verify.example.test`],
  );
  return customerId;
}

export async function linkCustomer(customerId: string, stripeCustomerId: string): Promise<void> {
  await superPool.query(
    `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
     VALUES ($1, $2, $3, 'stripe_id')`,
    [TENANT_ID, customerId, stripeCustomerId],
  );
}

export async function seedRecord(
  fixture: Fixture,
  entityType: "customer" | "price" | "contract" | "invoice" | "credit" | "payment" | "refund",
  externalId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [TENANT_ID, fixture.connectorId, entityType, externalId, JSON.stringify(data)],
  );
}

export async function seedExpectedActivity(
  customerId: string,
  marker: string,
  usageBilled: string,
  usageQuantity: string,
  overage = "0",
): Promise<ExpectedActivityEvidence> {
  const usageEventId = randomUUID();
  const transactionId = randomUUID();
  const consumptionId = randomUUID();
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO usage_events (
         id, tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at
       ) VALUES ($1, $2, $3, 'verify.units', $4, $5, '2026-08-15T12:00:00Z')`,
      [usageEventId, TENANT_ID, customerId, usageQuantity, `${marker}-usage`],
    );
    await client.query(
      `INSERT INTO ledger_transactions (
         id, tenant_id, customer_id, usage_event_id, description, created_at
       ) VALUES ($1, $2, $3, $4, $5, '2026-08-15T12:00:00Z')`,
      [transactionId, TENANT_ID, customerId, usageEventId, marker],
    );
    await client.query(
      `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       VALUES ($1, $2, 'receivable', 'debit', $3)`,
      [TENANT_ID, transactionId, usageBilled],
    );
    const ledgerLineId = (await client.query<{ id: string }>(
      `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       VALUES ($1, $2, 'revenue', 'credit', $3) RETURNING id::text`,
      [TENANT_ID, transactionId, usageBilled],
    )).rows[0].id;
    let overageConsumptionLineId: string | null = null;
    if (overage !== "0") {
      await client.query(
        `INSERT INTO usage_consumptions (
           id, tenant_id, customer_id, requested_amount, unit, occurred_at
         ) VALUES ($1, $2, $3, $4, 'credits', '2026-08-15T12:00:00Z')`,
        [consumptionId, TENANT_ID, customerId, overage],
      );
      overageConsumptionLineId = (await client.query<{ id: string }>(
        `INSERT INTO usage_consumption_lines (tenant_id, consumption_id, source_category, amount)
         VALUES ($1, $2, 'overage', $3) RETURNING id::text`,
        [TENANT_ID, consumptionId, overage],
      )).rows[0].id;
    }
    await client.query("COMMIT");
    return { usageEventId, ledgerLineId, overageConsumptionLineId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateInvoice(
  fixture: Fixture,
  externalId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await superPool.query(
    `UPDATE connector_records SET data = $3::jsonb, synced_at = now()
     WHERE connector_id = $1 AND entity_type = 'invoice' AND external_id = $2`,
    [fixture.connectorId, externalId, JSON.stringify(data)],
  );
}

export async function billedRows(lineIds: string[]): Promise<BilledRow[]> {
  return (await superPool.query<BilledRow>(
    `SELECT id, customer_id, connector_id, stripe_invoice_line_id, price_id,
            period_start, period_end, quantity::text, amount::text, currency, mapped_at
     FROM verify_billed_lines
     WHERE tenant_id = $1 AND stripe_invoice_line_id = ANY($2::text[])
     ORDER BY stripe_invoice_line_id`,
    [TENANT_ID, lineIds],
  )).rows;
}

export async function seedScale(fixture: Fixture): Promise<void> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email)
       SELECT md5($2 || '-customer-' || g)::uuid, $1, $2 || '-customer-' || g,
              $2 || '-' || g || '@verify.example.test'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
       SELECT $1, md5($2 || '-customer-' || g)::uuid, $2 || '-cus-' || g, 'stripe_id'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
       SELECT $1, $2, 'invoice', $3 || '-invoice-' || customer_number,
              jsonb_build_object(
                'id', $3 || '-invoice-' || customer_number,
                'customer_id', $3 || '-cus-' || customer_number,
                'status', 'paid',
                'lines', (
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', $3 || '-line-' || customer_number || '-' || line_number,
                    'invoice_id', $3 || '-invoice-' || customer_number,
                    'price_id', 'price_scale',
                    'period_start', '2026-08-01T00:00:00.000Z',
                    'period_end', '2026-09-01T00:00:00.000Z',
                    'quantity', '1000000000000.000001',
                    'amount', '123456789.123456',
                    'currency', 'USD'
                  ) ORDER BY line_number)
                  FROM generate_series(1, 100) AS line_number
                )
              )
       FROM generate_series(1, 500) AS customer_number`,
      [TENANT_ID, fixture.connectorId, fixture.marker],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function seedInvoiceRecord(
  fixture: Fixture,
  invoiceId: string,
  stripeCustomerId: string,
  lineId: string,
  quantity: string,
  amount: string,
): Promise<void> {
  await seedRecord(fixture, "invoice", invoiceId, {
    id: invoiceId,
    customer_id: stripeCustomerId,
    amount,
    currency: "USD",
    status: "open",
    issued_at: "2026-09-01T00:00:00.000Z",
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-09-01T00:00:00.000Z",
    lines: [{
      id: lineId,
      invoice_id: invoiceId,
      price_id: "price_verify",
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
      quantity,
      amount,
      currency: "USD",
      passthrough: {},
    }],
    passthrough: {},
  });
}

export async function seedDiscrepancyScale(fixture: Fixture): Promise<string[]> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email)
       SELECT md5($2 || '-discrepancy-customer-' || g)::uuid, $1,
              $2 || '-discrepancy-customer-' || g,
              $2 || '-discrepancy-' || g || '@verify.example.test'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO usage_events (
         id, tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at
       )
       SELECT md5($2 || '-discrepancy-event-' || g)::uuid, $1,
              md5($2 || '-discrepancy-customer-' || g)::uuid,
              'verify.units', 1, $2 || '-discrepancy-key-' || g,
              '2026-08-15T12:00:00Z'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO ledger_transactions (
         id, tenant_id, customer_id, usage_event_id, description, created_at
       )
       SELECT md5($2 || '-discrepancy-transaction-' || g)::uuid, $1,
              md5($2 || '-discrepancy-customer-' || g)::uuid,
              md5($2 || '-discrepancy-event-' || g)::uuid, $2,
              '2026-08-15T12:00:00Z'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       SELECT $1, md5($2 || '-discrepancy-transaction-' || g)::uuid,
              side.account_code, side.direction, 1.00
       FROM generate_series(1, 500) AS g
       CROSS JOIN (VALUES ('receivable', 'debit'), ('revenue', 'credit')) AS side(account_code, direction)`,
      [TENANT_ID, fixture.marker],
    );
    await client.query(
      `INSERT INTO verify_billed_lines (
         tenant_id, customer_id, connector_id, stripe_invoice_line_id,
         price_id, period_start, period_end, quantity, amount, currency
       )
       SELECT $1, md5($3 || '-discrepancy-customer-' || g)::uuid, $2,
              $3 || '-discrepancy-line-' || g, 'price_scale',
              '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 1.00, 'USD'
       FROM generate_series(1, 500) AS g`,
      [TENANT_ID, fixture.connectorId, fixture.marker],
    );
    await client.query("COMMIT");
    return (await superPool.query<{ id: string }>(
      `SELECT id::text FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '-discrepancy-customer-%'
       ORDER BY id`,
      [TENANT_ID, fixture.marker],
    )).rows.map((row) => row.id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupFixture(fixture: Fixture): Promise<void> {
  const client = await superPool.connect();
  try {
    // Keep FK cascades enabled while removing the connector and its landed /
    // mapped rows. Replica mode is needed only for the immutable ledger
    // triggers in discrepancy fixtures below.
    await client.query("DELETE FROM connectors WHERE id = $1", [fixture.connectorId]);
    const customers = (await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '%'`,
      [TENANT_ID, fixture.marker],
    )).rows.map((row) => row.id);
    if (customers.length > 0) {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `DELETE FROM ledger_lines WHERE transaction_id IN (
           SELECT id FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])
         )`,
        [customers],
      );
      await client.query("DELETE FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])", [customers]);
      await client.query(
        `DELETE FROM usage_consumption_lines WHERE consumption_id IN (
           SELECT id FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])
         )`,
        [customers],
      );
      await client.query("DELETE FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])", [customers]);
      await client.query("DELETE FROM usage_events WHERE customer_id = ANY($1::uuid[])", [customers]);
      await client.query("DELETE FROM stripe_customer_links WHERE customer_id = ANY($1::uuid[])", [customers]);
      await client.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [customers]);
    }
  } finally {
    await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    client.release();
  }
}
