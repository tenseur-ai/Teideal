// Mirrors services/go-usage/internal/db: no tenant-scoped query runs without
// first setting app.tenant_id for the transaction. RLS in Postgres does the
// actual filtering; this helper exists so skipping that step is structurally
// awkward rather than easy to forget.
import { Pool, type PoolClient } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // Backstop against a connection that gets stuck holding an open
    // transaction and never sends its next command -- confirmed possible
    // (root cause not yet found, see docs/parallel-work.md's data-export
    // flake writeup) via a live hang where Postgres itself sat idle in
    // transaction waiting on the client indefinitely. Real workloads never
    // come close to this: even a 450k-row export batches in ~180ms/10k rows
    // between queries, a >300x margin. Without this, a single stuck
    // transaction permanently removes one connection from the shared pool;
    // enough of them and every feature needing a DB connection stops
    // working, not just exports.
    idle_in_transaction_session_timeout: 60_000,
  });
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
