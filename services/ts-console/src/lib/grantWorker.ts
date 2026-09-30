import type { Pool, PoolClient } from "pg";
import { computeNextTranche, trancheCount, type DrawdownSchedule } from "./commitSchedule.js";
import { withTenant } from "./db.js";
import { emitWebhookEvent, tenantHasActiveWebhookEndpoints } from "./webhooks.js";

// "monthly" is the only cadence this story issues. The key is the UTC year
// and month so two runs on either side of a local midnight still agree.
export function monthlyPeriodKey(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

async function tenantIds(pool: Pool): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((row) => row.id);
}

function numericToJson(value: string): number | string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return value;
  if (Number.isInteger(parsed)) return parsed;
  return String(parsed) === trimmed ? parsed : value;
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
  customer_id: string;
  remaining_amount: string;
  source: string;
  carries_over: boolean;
}

interface ExpiringSoonGrant {
  id: string;
  customer_id: string;
  expiry_date: Date | string;
  remaining_amount: string;
  amount: string;
}

interface DueCommit {
  id: string;
  tenant_id: string;
  amount: string;
  start_date: Date;
  expiry_date: Date | null;
  drawdown_schedule: DrawdownSchedule;
  released_count: number;
}

// Claim and settle in the same transaction. SKIP LOCKED lets a second
// worker take the rows this one does not already hold, instead of waiting
// and then expiring them again.
async function expireForTenant(client: PoolClient, now: Date): Promise<ExpiredGrant[]> {
  const claimed = await client.query<ExpiredGrant>(
    `SELECT id, tenant_id, customer_id, remaining_amount::text AS remaining_amount, source, carries_over
     FROM grants
     WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= $1
     FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const row of claimed.rows) {
    // A carrying commit is still closed. The ledger name is the only
    // difference: the unused balance is reported, not re-issued.
    const entryType = row.source === "commit" && row.carries_over ? "carried_over" : "expired";
    await client.query(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
       VALUES ($1, $2, $3, -$4::numeric)`,
      [row.tenant_id, row.id, entryType, row.remaining_amount],
    );
    await client.query(`UPDATE grants SET status = 'expired' WHERE id = $1`, [row.id]);
  }
  return claimed.rows;
}

export async function processExpiredGrants(pool: Pool, now = new Date()): Promise<number> {
  let expired = 0;
  for (const tenantId of await tenantIds(pool)) {
    const rows = await withTenant(pool, tenantId, (client) => expireForTenant(client, now));
    expired += rows.length;
    // The expiry transaction has committed before any external delivery is
    // attempted, so webhook availability cannot roll back grant correctness.
    // Checked once per tenant, matching balanceAlertWorker's own fix for the
    // same class of bulk-tick regression (TEID-47-T5).
    const hasWebhooks = rows.length > 0 && (await tenantHasActiveWebhookEndpoints(pool, tenantId));
    for (const row of hasWebhooks ? rows : []) {
      await emitWebhookEvent(pool, tenantId, "grant.expired", `expired:${row.id}`, {
        customer_id: row.customer_id,
        grant_id: row.id,
        source: row.source,
        expired_amount: numericToJson(row.remaining_amount),
      });
    }
  }
  return expired;
}

export function grantExpiringSoonDays(): number {
  const raw = process.env.GRANT_EXPIRING_SOON_DAYS;
  if (raw === undefined || raw === "") return 7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`invalid GRANT_EXPIRING_SOON_DAYS ${JSON.stringify(raw)}; using 7`);
    return 7;
  }
  return parsed;
}

export async function checkExpiringSoonGrants(pool: Pool, now = new Date()): Promise<number> {
  const days = grantExpiringSoonDays();
  let checked = 0;
  for (const tenantId of await tenantIds(pool)) {
    const rows = await withTenant(pool, tenantId, async (client) =>
      (await client.query<ExpiringSoonGrant>(
        `SELECT id, customer_id, expiry_date,
                remaining_amount::text AS remaining_amount, amount::text AS amount
         FROM grants
         WHERE status = 'active'
           AND expiry_date IS NOT NULL
           AND expiry_date > $1
           AND expiry_date <= $1 + ($2 || ' days')::interval
         ORDER BY id`,
        [now, days],
      )).rows,
    );
    checked += rows.length;
    const hasWebhooks = rows.length > 0 && (await tenantHasActiveWebhookEndpoints(pool, tenantId));
    for (const row of hasWebhooks ? rows : []) {
      const expiryDate = row.expiry_date instanceof Date ? row.expiry_date : new Date(row.expiry_date);
      await emitWebhookEvent(pool, tenantId, "grant.expiring_soon", `expiring_soon:${row.id}`, {
        customer_id: row.customer_id,
        grant_id: row.id,
        expiry_date: expiryDate.toISOString(),
        remaining_amount: numericToJson(row.remaining_amount),
        amount: numericToJson(row.amount),
      });
    }
  }
  return checked;
}

// One due tranche per claimed commit. A later anniversary that is already
// in the past stays due and is released on the next call, the same way a
// single expiry pass settles one row at a time.
async function releaseDueTranchesForTenant(client: PoolClient, now: Date): Promise<number> {
  const claimed = await client.query<DueCommit>(
    `SELECT g.id, g.tenant_id, g.amount::text AS amount, g.start_date, g.expiry_date,
            g.drawdown_schedule,
            (SELECT count(*)::int FROM grant_ledger_entries e
             WHERE e.grant_id = g.id AND e.entry_type IN ('issued', 'released')) AS released_count
     FROM grants g
     WHERE g.status = 'active' AND g.source = 'commit'
       AND g.next_release_at IS NOT NULL AND g.next_release_at <= $1
     FOR UPDATE OF g SKIP LOCKED`,
    [now],
  );
  for (const row of claimed.rows) {
    if (row.drawdown_schedule !== "monthly" && row.drawdown_schedule !== "quarterly") {
      await client.query(`UPDATE grants SET next_release_at = NULL WHERE id = $1`, [row.id]);
      continue;
    }
    const startDate = row.start_date instanceof Date ? row.start_date : new Date(row.start_date);
    const expiryDate = row.expiry_date === null
      ? null
      : row.expiry_date instanceof Date ? row.expiry_date : new Date(row.expiry_date);
    const releasedCount = Number(row.released_count);
    // An amended expiry can move the last anniversary before the tranche
    // this row still has queued. Nothing further is owed; do not insert a
    // zero-amount release.
    if (expiryDate === null || releasedCount >= trancheCount(startDate, expiryDate, row.drawdown_schedule)) {
      await client.query(`UPDATE grants SET next_release_at = NULL WHERE id = $1`, [row.id]);
      continue;
    }
    const next = computeNextTranche({
      amount: row.amount,
      startDate,
      expiryDate,
      drawdownSchedule: row.drawdown_schedule,
      trancheIndex: releasedCount,
    });
    await client.query(
      `UPDATE grants SET remaining_amount = remaining_amount + $2::numeric, next_release_at = $3
       WHERE id = $1`,
      [row.id, next.trancheAmount, next.nextReleaseAt],
    );
    await client.query(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
       VALUES ($1, $2, 'released', $3::numeric)`,
      [row.tenant_id, row.id, next.trancheAmount],
    );
  }
  return claimed.rows.length;
}

export async function processCommitDrawdowns(pool: Pool, now = new Date()): Promise<number> {
  let released = 0;
  for (const tenantId of await tenantIds(pool)) {
    released += await withTenant(pool, tenantId, (client) => releaseDueTranchesForTenant(client, now));
  }
  return released;
}
