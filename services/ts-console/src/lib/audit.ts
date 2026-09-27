import type { Pool, PoolClient } from "pg";
import { withTenant } from "./db.js";

// TEID-91-AC5: every sign-in, failed attempt, MFA change and lockout is
// recorded here. TEID-42 will broaden this table's use to general
// config-change auditing; this function's event vocabulary is deliberately
// just what TEID-91 produces.
export type AuthEventType =
  | "sign_in_success"
  | "sign_in_failed"
  | "account_locked"
  | "mfa_enrolled"
  | "mfa_method_changed"
  | "mfa_disabled";

export async function writeAuditEvent(
  pool: Pool,
  tenantId: string,
  actorUserId: string | null,
  eventType: AuthEventType,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await withTenant(pool, tenantId, (client) => writeAuditEventWithClient(client, tenantId, actorUserId, eventType, detail));
}

// For callers already holding an open, tenant-scoped client (e.g.
// loginFlow.ts) -- see sessions.ts's Queryable comment for why acquiring a
// second pool connection while the first is still open is unsafe under load.
export async function writeAuditEventWithClient(
  client: PoolClient,
  tenantId: string,
  actorUserId: string | null,
  eventType: AuthEventType,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await client.query(`INSERT INTO audit_log (tenant_id, actor_user_id, event_type, detail) VALUES ($1, $2, $3, $4)`, [
    tenantId,
    actorUserId,
    eventType,
    JSON.stringify(detail),
  ]);
}

export type ConfigChangeActor = { userId: string } | { apiKeyId: string };

export interface ConfigChange {
  objectType: string;
  objectId: string;
  customerId?: string | null;
  before: unknown;
  after: unknown;
}

export async function recordConfigChange(
  pool: Pool,
  tenantId: string,
  actor: ConfigChangeActor,
  change: ConfigChange,
): Promise<void> {
  await withTenant(pool, tenantId, (client) => recordConfigChangeWithClient(client, tenantId, actor, change));
}

// Configuration mutations already running inside withTenant must use this
// variant so the mutation and its audit row commit atomically on one client.
export async function recordConfigChangeWithClient(
  client: PoolClient,
  tenantId: string,
  actor: ConfigChangeActor,
  change: ConfigChange,
): Promise<void> {
  const actorUserId = "userId" in actor ? actor.userId : null;
  const actorApiKeyId = "apiKeyId" in actor ? actor.apiKeyId : null;
  await client.query(
    `INSERT INTO audit_log (
       tenant_id, occurred_at, actor_user_id, actor_api_key_id, event_type,
       object_type, object_id, customer_id, before, after
     ) VALUES ($1, clock_timestamp(), $2, $3, 'config_change', $4, $5, $6, $7, $8)`,
    [
      tenantId,
      actorUserId,
      actorApiKeyId,
      change.objectType,
      change.objectId,
      change.customerId ?? null,
      JSON.stringify(change.before),
      JSON.stringify(change.after),
    ],
  );
}
