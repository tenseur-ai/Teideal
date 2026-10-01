import type { Pool } from "pg";
import { withTenant } from "../db.js";

export interface SyncWatermarkPosition {
  since: string | null;
  cursor: string | null;
}

export type SyncWatermark = Record<string, SyncWatermarkPosition>;

export interface SyncOutcome {
  status: "succeeded" | "failed";
  recordsSynced: number;
  errorMessage?: string;
  watermark?: SyncWatermark;
}

export interface ConnectorSyncHealth {
  connector_id: string;
  connector_type: string;
  display_name: string;
  status: string;
  last_sync_at: string | null;
  last_sync_status: "running" | "succeeded" | "failed" | null;
  consecutive_failures: number;
  cursor_high_water: SyncWatermark;
}

interface SyncHealthRow extends Omit<ConnectorSyncHealth, "last_sync_at"> {
  last_sync_at: Date | string | null;
}

export async function startSync(pool: Pool, tenantId: string, connectorId: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO connector_syncs (tenant_id, connector_id, status)
       SELECT $1, id, 'running'
       FROM connectors
       WHERE id = $2 AND tenant_id = $1
       RETURNING id`,
      [tenantId, connectorId],
    );
    if (!rows[0]) throw new Error("connector not found");
    return rows[0].id;
  });
}

export async function completeSync(
  pool: Pool,
  tenantId: string,
  syncId: string,
  outcome: SyncOutcome,
): Promise<void> {
  if (!Number.isInteger(outcome.recordsSynced) || outcome.recordsSynced < 0) {
    throw new Error("recordsSynced must be a non-negative integer");
  }
  if (outcome.status === "succeeded" && outcome.errorMessage !== undefined) {
    throw new Error("a succeeded sync cannot have an errorMessage");
  }
  const errorMessage = outcome.errorMessage?.slice(0, 500) ?? null;
  const successfulWatermark = outcome.status === "succeeded" && outcome.watermark !== undefined
    ? JSON.stringify(outcome.watermark)
    : null;

  await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ connector_id: string }>(
      `UPDATE connector_syncs
       SET completed_at = now(), status = $1, records_synced = $2, error_message = $3
       WHERE id = $4 AND tenant_id = $5 AND status = 'running'
       RETURNING connector_id`,
      [outcome.status, outcome.recordsSynced, errorMessage, syncId, tenantId],
    );
    const sync = rows[0];
    if (!sync) throw new Error("running connector sync not found");

    const updated = await client.query(
      `UPDATE connectors
       SET consecutive_failures = CASE
             WHEN $1 = 'succeeded' THEN 0
             ELSE consecutive_failures + 1
           END,
           cursor_high_water = CASE
             WHEN $1 = 'succeeded' AND $4::jsonb IS NOT NULL
               -- JSONB || is a shallow merge: each supplied top-level entity key fully replaces its prior {since, cursor} object; nested fields are not merged.
               THEN cursor_high_water || $4::jsonb
             ELSE cursor_high_water
           END,
           updated_at = now()
       WHERE id = $2 AND tenant_id = $3`,
      [outcome.status, sync.connector_id, tenantId, successfulWatermark],
    );
    if (updated.rowCount !== 1) throw new Error("connector not found");
  });
}

export async function getSyncHealth(pool: Pool, tenantId: string): Promise<ConnectorSyncHealth[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<SyncHealthRow>(
      `SELECT c.id AS connector_id, c.connector_type, c.display_name, c.status,
              latest.started_at AS last_sync_at,
              latest.status AS last_sync_status,
              c.consecutive_failures,
              c.cursor_high_water
       FROM connectors c
       LEFT JOIN (
         SELECT DISTINCT ON (connector_id)
                connector_id, started_at, status
         FROM connector_syncs
         WHERE tenant_id = $1
         ORDER BY connector_id, started_at DESC
       ) latest ON latest.connector_id = c.id
       WHERE c.tenant_id = $1
       ORDER BY c.display_name, c.id`,
      [tenantId],
    );
    return rows.map((row) => ({
      ...row,
      last_sync_at: row.last_sync_at === null ? null : new Date(row.last_sync_at).toISOString(),
    }));
  });
}
