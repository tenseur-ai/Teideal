import type { Pool } from "pg";

export interface BlockedAttempt {
  actingTenantId: string;
  targetTenantId?: string | null;
  endpoint: string;
  method: string;
  detail: string;
  resolvedAction: string;
}

// Logged synchronously, in the same request as the attempt, so the
// "detected within 60 seconds" requirement (TEID-41-T6) holds by
// construction rather than by batching.
export async function logBlocked(pool: Pool, a: BlockedAttempt): Promise<void> {
  await pool.query(
    `INSERT INTO security_events (acting_tenant_id, target_tenant_id, endpoint, http_method, detail, resolved_action)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.actingTenantId, a.targetTenantId ?? null, a.endpoint, a.method, a.detail, a.resolvedAction],
  );
}
