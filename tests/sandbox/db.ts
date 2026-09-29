import pg from "pg";
import { DATABASE_URL } from "./env.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function tenantRow(id: string): Promise<{ id: string; kind: string; parent_tenant_id: string | null } | null> {
  const { rows } = await pool.query(
    `SELECT id, kind, parent_tenant_id FROM tenants WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
