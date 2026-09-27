import pg from "pg";
import { DATABASE_URL } from "./env.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Mirrors services/ts-console's lib/db.ts: teideal_app is subject to RLS
// like any other caller, so creating fixture rows directly (bypassing the
// HTTP API) still needs a tenant context set first.
export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
