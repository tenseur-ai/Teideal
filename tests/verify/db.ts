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
  entityType: "customer" | "price" | "contract" | "invoice",
  externalId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [TENANT_ID, fixture.connectorId, entityType, externalId, JSON.stringify(data)],
  );
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

export async function cleanupFixture(fixture: Fixture): Promise<void> {
  await superPool.query("DELETE FROM connectors WHERE id = $1", [fixture.connectorId]);
  const customers = (await superPool.query<{ id: string }>(
    `SELECT id FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '%'`,
    [TENANT_ID, fixture.marker],
  )).rows.map((row) => row.id);
  if (customers.length > 0) {
    await superPool.query("DELETE FROM stripe_customer_links WHERE customer_id = ANY($1::uuid[])", [customers]);
    await superPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [customers]);
  }
}
