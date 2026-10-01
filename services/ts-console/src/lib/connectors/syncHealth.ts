import type { Pool } from "pg";
import { withTenant } from "../db.js";
import { ConnectorError } from "./connector.js";

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
  backfill_completed_at: string | null;
  last_error: string | null;
}

interface SyncHealthRow extends Omit<ConnectorSyncHealth, "last_sync_at" | "backfill_completed_at" | "last_error"> {
  last_sync_at: Date | string | null;
  backfill_completed_at: Date | string | null;
  raw_last_error: string | null;
}

/**
 * Checkpoints one fully persisted page. This is deliberately independent of
 * completeSync: a failed multi-hour attempt remains failed, while its durable
 * page-level progress can still be resumed by the next attempt.
 */
export async function advanceWatermark(
  pool: Pool,
  tenantId: string,
  connectorId: string,
  entityType: string,
  position: SyncWatermarkPosition,
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE connectors
       SET cursor_high_water = jsonb_set(
             cursor_high_water,
             ARRAY[$3]::text[],
             $4::jsonb,
             true
           ),
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId, entityType, JSON.stringify(position)],
    );
    if (result.rowCount !== 1) throw new Error("connector not found");
  });
}

export function humanizeConnectorError(rawMessage: string | ConnectorError): string {
  const statusCode = rawMessage instanceof ConnectorError ? rawMessage.statusCode : null;
  const message = rawMessage instanceof Error ? rawMessage.message : rawMessage;
  const normalized = message.toLowerCase();
  if (statusCode === 0 || statusCode === 408 || /network|timed? out|timeout|econn|socket|fetch failed/.test(normalized)) {
    return "The billing system could not be reached. Check the connection and try again.";
  }
  if (statusCode === 401 || statusCode === 403 || /http (401|403)|unauthori[sz]ed|forbidden/.test(normalized)) {
    return "The billing system authorization is no longer valid. Reconnect it and try again.";
  }
  if (statusCode === 429 || /http 429|rate.?limit/.test(normalized)) {
    return "The billing system is temporarily rate-limiting requests. Teideal will try again.";
  }
  if ((statusCode !== null && statusCode >= 500) || /http 5\d\d|upstream/.test(normalized)) {
    return "The billing system is temporarily unavailable. Teideal will try again.";
  }
  return "The last sync failed. Contact support if this persists.";
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
              COALESCE(last_success.completed_at, latest.started_at) AS last_sync_at,
              latest.status AS last_sync_status,
              c.consecutive_failures,
              c.cursor_high_water,
              c.backfill_completed_at,
              CASE WHEN latest.status = 'failed' THEN latest.error_message ELSE NULL END AS raw_last_error
       FROM connectors c
       LEFT JOIN (
         SELECT DISTINCT ON (connector_id)
                connector_id, started_at, status, error_message
         FROM connector_syncs
         WHERE tenant_id = $1
         ORDER BY connector_id, started_at DESC
       ) latest ON latest.connector_id = c.id
       LEFT JOIN (
         SELECT connector_id, max(completed_at) AS completed_at
         FROM connector_syncs
         WHERE tenant_id = $1 AND status = 'succeeded'
         GROUP BY connector_id
       ) last_success ON last_success.connector_id = c.id
       WHERE c.tenant_id = $1
       ORDER BY c.display_name, c.id`,
      [tenantId],
    );
    return rows.map((row) => ({
      connector_id: row.connector_id,
      connector_type: row.connector_type,
      display_name: row.display_name,
      status: row.status,
      last_sync_at: row.last_sync_at === null ? null : new Date(row.last_sync_at).toISOString(),
      last_sync_status: row.last_sync_status,
      consecutive_failures: row.consecutive_failures,
      cursor_high_water: row.cursor_high_water,
      backfill_completed_at: row.backfill_completed_at === null
        ? null
        : new Date(row.backfill_completed_at).toISOString(),
      last_error: row.raw_last_error === null
        ? null
        : `${row.display_name}: ${humanizeConnectorError(row.raw_last_error)}`,
    }));
  });
}
