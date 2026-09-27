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
