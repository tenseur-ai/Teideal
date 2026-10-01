import type { Pool } from "pg";
import { withTenant } from "../db.js";
import type { Connector, ConnectorPage } from "./connector.js";
import { StripeBillingConnector, STRIPE_BILLING_ENTITY_TYPES } from "./stripeBillingConnector.js";
import {
  advanceWatermark,
  completeSync,
  startSync,
  type SyncWatermark,
  type SyncWatermarkPosition,
} from "./syncHealth.js";

export type ConnectorEntityType = typeof STRIPE_BILLING_ENTITY_TYPES[number];

export interface SyncConnectorRow {
  id: string;
  tenant_id: string;
  connector_type: string;
  display_name: string;
  status: string;
  stripe_connection_id: string | null;
  backfill_completed_at: Date | string | null;
  cursor_high_water: SyncWatermark;
}

export interface RunConnectorSyncOptions {
  entityTypes: readonly ConnectorEntityType[];
  timeBudgetMs?: number | null;
  now?: Date;
}

export interface RunConnectorSyncResult {
  completed: boolean;
  recordsSynced: number;
}

const MONTHS_OF_BACKFILL = 24;

export function connectorBackfillTickIntervalMs(): number {
  return positiveEnvMilliseconds("CONNECTOR_BACKFILL_TICK_INTERVAL_MS", 60_000);
}

export function connectorBackfillTimeBudgetMs(): number {
  return positiveEnvMilliseconds("CONNECTOR_BACKFILL_TIME_BUDGET_MS", 5 * 60_000);
}

export function connectorIncrementalIntervalMs(): number {
  // AC4 is an upper bound as well as a default: configuration may make the
  // worker more frequent, but never less frequent than hourly.
  return Math.min(
    positiveEnvMilliseconds("CONNECTOR_INCREMENTAL_INTERVAL_MS", 60 * 60_000),
    60 * 60_000,
  );
}

function positiveEnvMilliseconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`invalid ${name} ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function monthsBefore(now: Date, months: number): string {
  const date = new Date(now.getTime());
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function methodFor(
  connector: Connector,
  entityType: ConnectorEntityType,
): (since: string | null, cursor: string | null) => Promise<ConnectorPage<{ id: string }>> {
  switch (entityType) {
    case "customer": return connector.listCustomers.bind(connector);
    case "price": return connector.listPrices.bind(connector);
    case "contract": return connector.listContracts.bind(connector);
    case "invoice": return connector.listInvoices.bind(connector);
    case "credit": return connector.listCredits.bind(connector);
    case "payment": return connector.listPayments.bind(connector);
    case "refund": return connector.listRefunds.bind(connector);
  }
}

async function upsertPage(
  pool: Pool,
  tenantId: string,
  connectorId: string,
  entityType: ConnectorEntityType,
  records: Array<{ id: string }>,
): Promise<void> {
  if (records.length === 0) return;
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
       SELECT $1, $2, $3, rows.external_id, rows.data
       FROM unnest($4::text[], $5::jsonb[]) AS rows(external_id, data)
       ON CONFLICT (connector_id, entity_type, external_id)
       DO UPDATE SET data = excluded.data, synced_at = now()`,
      [
        tenantId,
        connectorId,
        entityType,
        records.map((record) => record.id),
        records.map((record) => JSON.stringify(record)),
      ],
    );
  });
}

export async function runConnectorSync(
  pool: Pool,
  tenantId: string,
  connector: SyncConnectorRow,
  connectorInstance: Connector,
  options: RunConnectorSyncOptions,
): Promise<RunConnectorSyncResult> {
  if (connector.id.length === 0 || connector.tenant_id !== tenantId) throw new Error("connector tenant mismatch");
  if (connector.connector_type !== connectorInstance.connectorType) throw new Error("connector type mismatch");
  const timeBudgetMs = options.timeBudgetMs ?? null;
  if (timeBudgetMs !== null && (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0)) {
    throw new Error("timeBudgetMs must be greater than zero or null");
  }

  const attemptStartedAt = options.now ?? new Date();
  const monotonicStartedAt = Date.now();
  const syncId = await startSync(pool, tenantId, connector.id);
  let recordsSynced = 0;
  const isBackfill = connector.backfill_completed_at === null;
  const originalBackfillSince = isBackfill
    ? Object.values(connector.cursor_high_water).find((position) => position?.since)?.since
      ?? monthsBefore(attemptStartedAt, MONTHS_OF_BACKFILL)
    : null;
  try {
    for (const entityType of options.entityTypes) {
      const persisted = connector.cursor_high_water[entityType];
      // During a bounded backfill, a present null cursor means this entity was
      // already exhausted by an earlier chunk. An absent key means untouched.
      if (isBackfill && persisted && persisted.cursor === null) {
        continue;
      }
      const since = persisted?.since
        ?? (isBackfill ? originalBackfillSince! : attemptStartedAt.toISOString());
      let cursor = persisted?.cursor ?? null;
      while (true) {
        const page = await methodFor(connectorInstance, entityType)(since, cursor);
        await upsertPage(pool, tenantId, connector.id, entityType, page.data);
        recordsSynced += page.data.length;
        const position: SyncWatermarkPosition = { since, cursor: page.nextCursor };
        await advanceWatermark(pool, tenantId, connector.id, entityType, position);
        connector.cursor_high_water[entityType] = position;
        cursor = page.nextCursor;
        if (cursor === null) {
          break;
        }
        if (timeBudgetMs !== null && Date.now() - monotonicStartedAt >= timeBudgetMs) {
          await completeSync(pool, tenantId, syncId, { status: "succeeded", recordsSynced });
          return { completed: false, recordsSynced };
        }
      }
    }

    // Once all requested entities are exhausted, move their lower bound to
    // this attempt's start. Changes created during the attempt are therefore
    // safely picked up by the next incremental run.
    const caughtUpWatermark = Object.fromEntries(options.entityTypes.map((entityType) => [
      entityType,
      { since: attemptStartedAt.toISOString(), cursor: null },
    ])) as SyncWatermark;
    await completeSync(pool, tenantId, syncId, {
      status: "succeeded",
      recordsSynced,
      watermark: caughtUpWatermark,
    });
    return { completed: true, recordsSynced };
  } catch (error) {
    await completeSync(pool, tenantId, syncId, {
      status: "failed",
      recordsSynced,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function tenantIds(pool: Pool): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((row) => row.id);
}

async function loadCandidates(pool: Pool, tenantId: string, backfill: boolean): Promise<SyncConnectorRow[]> {
  return withTenant(pool, tenantId, async (client) => (await client.query<SyncConnectorRow>(
    `SELECT id, tenant_id, connector_type, display_name, status, stripe_connection_id,
            backfill_completed_at, cursor_high_water
     FROM connectors
     WHERE tenant_id = $1 AND status = 'connected'
       AND backfill_completed_at IS ${backfill ? "NULL" : "NOT NULL"}
       AND connector_type = 'stripe'
     ORDER BY created_at, id`,
    [tenantId],
  )).rows);
}

function instanceFor(pool: Pool, connector: SyncConnectorRow): Connector {
  if (connector.connector_type === "stripe" && connector.stripe_connection_id) {
    return new StripeBillingConnector(pool, connector.tenant_id, connector.stripe_connection_id);
  }
  throw new Error(`unsupported scheduled connector type: ${connector.connector_type}`);
}

async function runStripeEventSync(
  pool: Pool,
  tenantId: string,
  connector: SyncConnectorRow,
  stripe: StripeBillingConnector,
  now: Date,
): Promise<RunConnectorSyncResult> {
  const backfillCompletedAt = connector.backfill_completed_at;
  if (backfillCompletedAt === null) throw new Error("event sync requires a completed backfill");
  const syncId = await startSync(pool, tenantId, connector.id);
  const attemptStartedAt = now.toISOString();
  const persisted = connector.cursor_high_water.events;
  const since = persisted?.since ?? new Date(backfillCompletedAt).toISOString();
  let cursor = persisted?.cursor ?? null;
  let recordsSynced = 0;

  try {
    while (true) {
      const page = await stripe.listEvents(since, cursor);
      for (const event of page.data) {
        const refreshed = await stripe.retrieveEventRecord(event);
        await upsertPage(pool, tenantId, connector.id, refreshed.entityType, [refreshed.record]);
        recordsSynced += 1;
      }
      const position: SyncWatermarkPosition = { since, cursor: page.nextCursor };
      await advanceWatermark(pool, tenantId, connector.id, "events", position);
      connector.cursor_high_water.events = position;
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    const watermark: SyncWatermark = {
      events: { since: attemptStartedAt, cursor: null },
    };
    await completeSync(pool, tenantId, syncId, {
      status: "succeeded",
      recordsSynced,
      watermark,
    });
    connector.cursor_high_water.events = watermark.events;
    return { completed: true, recordsSynced };
  } catch (error) {
    await completeSync(pool, tenantId, syncId, {
      status: "failed",
      recordsSynced,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function backfillTick(pool: Pool, now = new Date()): Promise<number> {
  let completed = 0;
  for (const tenantId of await tenantIds(pool)) {
    for (const connector of await loadCandidates(pool, tenantId, true)) {
      try {
        const result = await runConnectorSync(pool, tenantId, connector, instanceFor(pool, connector), {
          entityTypes: STRIPE_BILLING_ENTITY_TYPES,
          timeBudgetMs: connectorBackfillTimeBudgetMs(),
          now,
        });
        if (result.completed) {
          await withTenant(pool, tenantId, async (client) => {
            await client.query(
              `UPDATE connectors SET backfill_completed_at = $3, updated_at = now()
               WHERE id = $1 AND tenant_id = $2 AND backfill_completed_at IS NULL`,
              [connector.id, tenantId, now],
            );
          });
          completed += 1;
        }
      } catch (error) {
        console.error(`connector backfill failed for ${connector.id}:`, error);
      }
    }
  }
  return completed;
}

export async function incrementalTick(pool: Pool, now = new Date()): Promise<number> {
  let completed = 0;
  for (const tenantId of await tenantIds(pool)) {
    for (const connector of await loadCandidates(pool, tenantId, false)) {
      try {
        const instance = instanceFor(pool, connector);
        const result = await runConnectorSync(pool, tenantId, connector, instance, {
          entityTypes: STRIPE_BILLING_ENTITY_TYPES,
          timeBudgetMs: null,
          now,
        });
        if (result.completed) {
          await runStripeEventSync(pool, tenantId, connector, instance as StripeBillingConnector, now);
          completed += 1;
        }
      } catch (error) {
        console.error(`incremental connector sync failed for ${connector.id}:`, error);
      }
    }
  }
  return completed;
}
