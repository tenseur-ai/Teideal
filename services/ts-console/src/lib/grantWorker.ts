import type { Pool, PoolClient } from "pg";
import { withTenant } from "./db.js";

// "monthly" is the only cadence this story issues. The key is the UTC year
// and month so two runs on either side of a local midnight still agree.
export function monthlyPeriodKey(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

async function tenantIds(pool: Pool): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((row) => row.id);
}

// One statement for every active template in the tenant: the partial unique
// index makes a second run in the same period insert nothing and, because
// the ledger write reads that INSERT's RETURNING rows, write no second
// issued entry either.
async function issueRecurringForTenant(client: PoolClient, now: Date, periodKey: string): Promise<number> {
  const { rows } = await client.query<{ issued: number }>(
    `WITH inserted AS (
       INSERT INTO grants (
         tenant_id, customer_id, amount, remaining_amount, unit, source,
         start_date, recurring_template_id, period_key
       )
       SELECT tenant_id, customer_id, amount, amount, unit, source,
              $1::timestamptz, id, $2
       FROM recurring_grant_templates
       WHERE active = true
       ON CONFLICT (recurring_template_id, period_key) WHERE recurring_template_id IS NOT NULL
       DO NOTHING
       RETURNING id, tenant_id, amount
     ),
     ledger AS (
       INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
       SELECT tenant_id, id, 'issued', amount
       FROM inserted
       RETURNING grant_id
     )
     SELECT count(*)::int AS issued FROM ledger`,
    [now, periodKey],
  );
  return rows[0]?.issued ?? 0;
}

export async function processRecurringGrants(pool: Pool, now = new Date()): Promise<number> {
  const periodKey = monthlyPeriodKey(now);
  let issued = 0;
  for (const tenantId of await tenantIds(pool)) {
    issued += await withTenant(pool, tenantId, (client) => issueRecurringForTenant(client, now, periodKey));
  }
  return issued;
}

interface ExpiredGrant {
  id: string;
  tenant_id: string;
  remaining_amount: string;
}

// Claim and settle in the same transaction. SKIP LOCKED lets a second
// worker take the rows this one does not already hold, instead of waiting
// and then expiring them again.
async function expireForTenant(client: PoolClient, now: Date): Promise<number> {
  const claimed = await client.query<ExpiredGrant>(
    `SELECT id, tenant_id, remaining_amount::text AS remaining_amount
     FROM grants
     WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= $1
     FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const row of claimed.rows) {
    await client.query(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
       VALUES ($1, $2, 'expired', -$3::numeric)`,
      [row.tenant_id, row.id, row.remaining_amount],
    );
    await client.query(`UPDATE grants SET status = 'expired' WHERE id = $1`, [row.id]);
  }
  return claimed.rows.length;
}

export async function processExpiredGrants(pool: Pool, now = new Date()): Promise<number> {
  let expired = 0;
  for (const tenantId of await tenantIds(pool)) {
    expired += await withTenant(pool, tenantId, (client) => expireForTenant(client, now));
  }
  return expired;
}
