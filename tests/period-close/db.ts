import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, SUPERUSER_DATABASE_URL } from "./env.js";

export const appPool = new pg.Pool({ connectionString: DATABASE_URL });
export const superPool = new pg.Pool({ connectionString: SUPERUSER_DATABASE_URL });

export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

export async function createCustomer(tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)`,
      [id, tenantId, name, `${id}@period-close.example.test`],
    );
  });
  return id;
}

export async function seedCompleteActivity(tenantId: string, customerId: string, marker: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const usageEventId = randomUUID();
    const adjustmentEventId = randomUUID();
    const transactionId = randomUUID();
    const adjustmentTransactionId = randomUUID();
    const consumptionId = randomUUID();
    const grantId = randomUUID();
    await client.query(
      `INSERT INTO usage_events (id, tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at, is_prior_period_adjustment)
       VALUES ($1, $2, $3, 'tokens.in', 100, $4, '2026-08-10T12:00:00Z', false),
              ($5, $2, $3, 'tokens.in', 5, $6, '2026-08-11T12:00:00Z', true)`,
      [usageEventId, tenantId, customerId, `${marker}-usage`, adjustmentEventId, `${marker}-adjustment-usage`],
    );
    await client.query(
      `INSERT INTO ledger_transactions (id, tenant_id, customer_id, usage_event_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, '2026-08-10T12:00:00Z'),
              ($6, $2, $3, $7, $8, '2026-08-20T12:00:00Z')`,
      [transactionId, tenantId, customerId, usageEventId, `${marker}-base`, adjustmentTransactionId, adjustmentEventId, `${marker}-adjustment`],
    );
    await client.query(
      `INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       VALUES ($1, $2, 'receivable', 'debit', 100.00),
              ($1, $2, 'revenue', 'credit', 100.00),
              ($1, $3, 'receivable', 'debit', 5.00),
              ($1, $3, 'revenue', 'credit', 5.00)`,
      [tenantId, transactionId, adjustmentTransactionId],
    );
    await client.query(
      `INSERT INTO usage_adjustments (
         tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at,
         period_start, period_end, status, resulting_usage_event_id, reviewed_at
       ) VALUES ($1, $2, 'tokens.in', 5, $3, '2026-08-11T12:00:00Z',
                 '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'approved', $4, '2026-09-10T00:00:00Z')`,
      [tenantId, customerId, `${marker}-adjustment`, adjustmentEventId],
    );
    await client.query(
      `INSERT INTO usage_consumptions (id, tenant_id, customer_id, requested_amount, unit, occurred_at)
       VALUES ($1, $2, $3, 65, 'credits', '2026-08-15T00:00:00Z')`,
      [consumptionId, tenantId, customerId],
    );
    await client.query(
      `INSERT INTO usage_consumption_lines (tenant_id, consumption_id, source_category, amount)
       VALUES ($1, $2, 'paid', 30), ($1, $2, 'promotional', 5),
              ($1, $2, 'commit', 20), ($1, $2, 'goodwill', 3), ($1, $2, 'overage', 7)`,
      [tenantId, consumptionId],
    );
    await client.query(
      `INSERT INTO grants (id, tenant_id, customer_id, amount, remaining_amount, unit, source, start_date, expiry_date, status)
       VALUES ($1, $2, $3, 10, 0, 'credits', 'promotional', '2026-07-01T00:00:00Z', '2026-08-25T00:00:00Z', 'expired')`,
      [grantId, tenantId, customerId],
    );
    await client.query(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount, occurred_at)
       VALUES ($1, $2, 'expired', -10, '2026-08-25T00:00:00Z')`,
      [tenantId, grantId],
    );
  });
}

export async function directRevenueTotal(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(l.amount), 0)::text AS total
       FROM ledger_transactions t
       JOIN ledger_lines l ON l.transaction_id = t.id
       WHERE t.tenant_id = $1 AND l.account_code = 'revenue' AND l.direction = 'credit'
         AND t.created_at >= '2026-08-01T00:00:00Z' AND t.created_at < '2026-09-01T00:00:00Z'`,
      [tenantId],
    );
    return rows[0].total;
  });
}

export async function bulkSeed50k(tenantId: string, marker: string): Promise<void> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customers (tenant_id, name, email)
       SELECT $1, $2 || '-' || lpad(g::text, 5, '0'), $2 || '-' || g::text || '@example.test'
       FROM generate_series(1, 50000) AS g`,
      [tenantId, marker],
    );
    await client.query(
      `WITH inserted AS (
         INSERT INTO ledger_transactions (tenant_id, customer_id, description, created_at)
         SELECT $1, id, $2, '2026-08-12T00:00:00Z'
         FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '-%'
         RETURNING id, tenant_id
       )
       INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
       SELECT i.tenant_id, i.id, side.account_code, side.direction, 1.25
       FROM inserted i
       CROSS JOIN (VALUES ('receivable', 'debit'), ('revenue', 'credit')) AS side(account_code, direction)`,
      [tenantId, marker],
    );
    await client.query(
      `WITH inserted AS (
         INSERT INTO usage_consumptions (tenant_id, customer_id, requested_amount, unit, occurred_at)
         SELECT $1, id, 1, 'credits', '2026-08-13T00:00:00Z'
         FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '-%'
         RETURNING id, tenant_id
       )
       INSERT INTO usage_consumption_lines (tenant_id, consumption_id, source_category, amount)
       SELECT tenant_id, id, 'paid', 1 FROM inserted`,
      [tenantId, marker],
    );
    await client.query(
      `WITH inserted AS (
         INSERT INTO grants (tenant_id, customer_id, amount, remaining_amount, unit, source, start_date, expiry_date, status)
         SELECT $1, id, 2, 0, 'credits', 'promotional', '2026-07-01T00:00:00Z', '2026-08-20T00:00:00Z', 'expired'
         FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '-%'
         RETURNING id, tenant_id
       )
       INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount, occurred_at)
       SELECT tenant_id, id, 'expired', -2, '2026-08-20T00:00:00Z' FROM inserted`,
      [tenantId, marker],
    );
    await client.query("COMMIT");
    await client.query("ANALYZE customers");
    await client.query("ANALYZE ledger_transactions");
    await client.query("ANALYZE usage_consumptions");
    await client.query("ANALYZE grant_ledger_entries");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupMarker(tenantId: string, marker: string): Promise<void> {
  const client = await superPool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    const { rows } = await client.query<{ ids: string[] | null }>(
      `SELECT array_agg(id)::uuid[] AS ids FROM customers WHERE tenant_id = $1 AND name LIKE $2 || '%'`,
      [tenantId, marker],
    );
    const ids = rows[0]?.ids ?? [];
    if (ids.length === 0) return;
    await client.query(`DELETE FROM ledger_lines WHERE transaction_id IN (SELECT id FROM ledger_transactions WHERE customer_id = ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM usage_adjustments WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM usage_consumption_lines WHERE consumption_id IN (SELECT id FROM usage_consumptions WHERE customer_id = ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM usage_consumptions WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM usage_events WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM grant_ledger_entries WHERE grant_id IN (SELECT id FROM grants WHERE customer_id = ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM grants WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM customer_billing_config WHERE customer_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [ids]);
  } finally {
    await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    client.release();
  }
}
