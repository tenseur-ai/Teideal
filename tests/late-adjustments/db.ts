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

export async function createCustomer(tenantId: string, label: string): Promise<string> {
  const id = randomUUID();
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)`,
      [id, tenantId, label, `${label}-${id}@example.test`],
    );
  });
  return id;
}

export async function setBillingConfig(
  tenantId: string,
  customerId: string,
  fields: { billing_timezone?: string; billing_anchor_day?: number },
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO customer_billing_config (tenant_id, customer_id, billing_timezone, billing_anchor_day)
       VALUES ($1, $2, COALESCE($3, 'UTC'), COALESCE($4, 1))
       ON CONFLICT (customer_id) DO UPDATE SET
         billing_timezone = COALESCE($3, customer_billing_config.billing_timezone),
         billing_anchor_day = COALESCE($4, customer_billing_config.billing_anchor_day),
         updated_at = now()`,
      [tenantId, customerId, fields.billing_timezone ?? null, fields.billing_anchor_day ?? null],
    );
  });
}

export async function countUsageEvents(
  tenantId: string,
  customerId: string,
  occurredFrom: string,
  occurredTo: string,
): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM usage_events
       WHERE customer_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      [customerId, occurredFrom, occurredTo],
    );
    return Number(rows[0].count);
  });
}
