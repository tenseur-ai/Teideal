import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SUPERUSER_DATABASE_URL, TENANT_ID } from "./env.js";

export const superPool = new Pool({ connectionString: SUPERUSER_DATABASE_URL });

export async function withTenant<T>(tenantId: string, run: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

// Duplicated from tests/verify/db.ts rather than cross-imported, matching
// this project's convention of each tests/<area>/ package staying
// self-contained and independently installable.

export interface Fixture {
  connectorId: string;
  marker: string;
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
    [customerId, TENANT_ID, `${fixture.marker}-${suffix}`, `${customerId}@console-ui.example.test`],
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
