import { randomUUID } from "node:crypto";
import pg from "pg";
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

export async function createCustomer(tenantID: string, label: string): Promise<string> {
  const id = randomUUID();
  await superPool.query(
    `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)`,
    [id, tenantID, label, `${id}@balance.test`],
  );
  return id;
}

export async function removeCustomers(customerIDs: string[]): Promise<void> {
  if (customerIDs.length === 0) return;
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM balance_integrity_checks WHERE customer_id = ANY($1::uuid[])", [customerIDs]);
    await client.query("DELETE FROM customer_balance_cache WHERE customer_id = ANY($1::uuid[])", [customerIDs]);
    await client.query(
      `DELETE FROM ledger_lines WHERE transaction_id IN (
         SELECT id FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])
       )`,
      [customerIDs],
    );
    await client.query("DELETE FROM ledger_transactions WHERE customer_id = ANY($1::uuid[])", [customerIDs]);
    await client.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [customerIDs]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function seedBalancedScaleFixture(
  tenantID: string,
  marker: string,
  customerCount: number,
): Promise<void> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    // Scale setup is set-based and the rows themselves are balanced. Disabling
    // per-line deferred triggers keeps fixture creation outside the timed run.
    await client.query("SET LOCAL session_replication_role = replica");
    const result = await client.query<{ count: string }>(
      `WITH inserted_customers AS (
         INSERT INTO customers (tenant_id, name, email)
         SELECT $1, $2 || '-' || n, $2 || '-' || n || '@scale.test'
         FROM generate_series(1, $3::int) AS n
         RETURNING id, tenant_id
       ), inserted_transactions AS (
         INSERT INTO ledger_transactions (tenant_id, customer_id, description)
         SELECT tenant_id, id, $2 FROM inserted_customers
         RETURNING id, tenant_id, customer_id
       ), inserted_lines AS (
         INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
         SELECT t.tenant_id, t.id, side.account_code, side.direction, 1.00
         FROM inserted_transactions t
         CROSS JOIN (VALUES ('receivable', 'debit'), ('revenue', 'credit')) AS side(account_code, direction)
         RETURNING transaction_id
       ), inserted_cache AS (
         INSERT INTO customer_balance_cache (
           tenant_id, customer_id, account_code, cached_balance, last_recalculated_at
         )
         SELECT tenant_id, customer_id, 'receivable', 1.00, now()
         FROM inserted_transactions
         RETURNING customer_id
       )
       SELECT count(*)::text AS count FROM inserted_cache`,
      [tenantID, marker, customerCount],
    );
    if (result.rows[0]?.count !== String(customerCount)) {
      throw new Error(`scale fixture inserted ${result.rows[0]?.count ?? 0} of ${customerCount} customers`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function removeScaleFixture(marker: string): Promise<void> {
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `CREATE TEMP TABLE teid33_scale_customer_ids (id UUID PRIMARY KEY) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO teid33_scale_customer_ids (id)
       SELECT id FROM customers WHERE name LIKE $1 || '-%'`,
      [marker],
    );
    await client.query(
      `DELETE FROM balance_integrity_checks checks
       USING teid33_scale_customer_ids target WHERE checks.customer_id = target.id`,
    );
    await client.query(
      `DELETE FROM customer_balance_cache cache
       USING teid33_scale_customer_ids target WHERE cache.customer_id = target.id`,
    );
    await client.query(
      `DELETE FROM ledger_lines line
       USING ledger_transactions transaction, teid33_scale_customer_ids target
       WHERE line.transaction_id = transaction.id AND transaction.customer_id = target.id`,
    );
    await client.query(
      `DELETE FROM ledger_transactions transaction
       USING teid33_scale_customer_ids target WHERE transaction.customer_id = target.id`,
    );
    await client.query(
      `DELETE FROM customers customer
       USING teid33_scale_customer_ids target WHERE customer.id = target.id`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
