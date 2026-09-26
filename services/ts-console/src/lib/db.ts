// Mirrors services/go-usage/internal/db: no tenant-scoped query runs without
// first setting app.tenant_id for the transaction. RLS in Postgres does the
// actual filtering; this helper exists so skipping that step is structurally
// awkward rather than easy to forget.
import { Pool, type PoolClient } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config with is_local=true binds tenantId as a parameter -- it is
    // never interpolated into SQL text.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
