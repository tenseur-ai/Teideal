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

export async function removeLedgerFixtures(transactionIDs: string[]): Promise<void> {
  if (transactionIDs.length === 0) return;
  const client = await superPool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query("DELETE FROM ledger_lines WHERE transaction_id = ANY($1::uuid[])", [transactionIDs]);
    await client.query("DELETE FROM ledger_transactions WHERE id = ANY($1::uuid[])", [transactionIDs]);
  } finally {
    await client.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    client.release();
  }
}
