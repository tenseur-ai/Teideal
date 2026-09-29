import pg from "pg";
import { randomUUID } from "node:crypto";
import { DATABASE_URL, SUPERUSER_DATABASE_URL } from "./env.js";

export const appPool = new pg.Pool({ connectionString: DATABASE_URL });
export const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });

export async function withTenant<T>(tenantID: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantID]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createCustomer(
  tenantId: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const id = randomUUID();
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email, parent_customer_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, name, `${name}-${id}@example.test`, parentId ?? null],
    );
  });
  return id;
}

export async function setBillingConfig(tenantId: string, customerId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO customer_billing_config (tenant_id, customer_id, billing_timezone, billing_anchor_day)
       VALUES ($1, $2, 'UTC', 1)
       ON CONFLICT (customer_id) DO UPDATE SET
         billing_timezone = 'UTC',
         billing_anchor_day = 1,
         updated_at = now()`,
      [tenantId, customerId],
    );
  });
}

export async function insertUsageEvents(params: {
  tenantId: string;
  customerId: string;
  eventType: string;
  count: number;
  occurredAt: Date;
  keyPrefix: string;
  hourSpread?: number;
}): Promise<void> {
  const hours = params.hourSpread ?? 1;
  await superPool.query(
    `INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at)
     SELECT $1, $2, $3, 1, $4 || g::text,
            $5::timestamptz + ((g - 1) % $6::int) * INTERVAL '1 hour'
     FROM generate_series(1, $7::int) AS g`,
    [
      params.tenantId,
      params.customerId,
      params.eventType,
      params.keyPrefix,
      params.occurredAt.toISOString(),
      hours,
      params.count,
    ],
  );
  if (params.count >= 100_000) {
    await superPool.query("ANALYZE usage_events");
  }
}

export async function removeCustomers(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const client = await superPool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(
      `DELETE FROM ledger_lines WHERE transaction_id IN (
         SELECT id FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])
       )`,
      [customerIds],
    );
    await client.query(`DELETE FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM reservations WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM usage_adjustments WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(
      `DELETE FROM usage_consumption_lines WHERE consumption_id IN (
         SELECT id FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])
       )`,
      [customerIds],
    ).catch(() => undefined);
    await client.query(`DELETE FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM usage_events WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(
      `DELETE FROM grant_ledger_entries WHERE grant_id IN (SELECT id FROM grants WHERE customer_id = ANY($1::uuid[]))`,
      [customerIds],
    );
    await client.query(`DELETE FROM grants WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM recurring_grant_templates WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM audit_log WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`UPDATE api_keys SET customer_id = NULL WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM customer_billing_config WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM customer_balance_cache WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM customer_plan_subscriptions WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM customer_rate_overrides WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM priced_usage_lines WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM customer_hierarchy_moves WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`DELETE FROM stripe_customer_links WHERE customer_id = ANY($1::uuid[])`, [customerIds]).catch(() => undefined);
    await client.query(`UPDATE customers SET parent_customer_id = NULL WHERE id = ANY($1::uuid[])`, [customerIds]);
    await client.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [customerIds]);
  } finally {
    await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    client.release();
  }
}
