import type { Pool, PoolClient } from "pg";

export async function resolveTenantByKey(pool: Pool, tenantKey: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE external_key = $1`, [tenantKey]);
  return rows[0]?.id ?? null;
}

export interface TenantSettings {
  requireMfaAllRoles: boolean;
  idleTimeoutMinutes: number;
  ssoEnabled: boolean;
}

export async function getTenantSettings(client: PoolClient, tenantId: string): Promise<TenantSettings> {
  const { rows } = await client.query<{ require_mfa_all_roles: boolean; idle_timeout_minutes: number; sso_enabled: boolean }>(
    `SELECT require_mfa_all_roles, idle_timeout_minutes, sso_enabled FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  // A tenant created without a settings row (shouldn't happen -- migration
  // backfills one per tenant -- but fail safe to the documented defaults
  // rather than erroring the login path).
  if (rows.length === 0) return { requireMfaAllRoles: false, idleTimeoutMinutes: 480, ssoEnabled: true };
  return {
    requireMfaAllRoles: rows[0].require_mfa_all_roles,
    idleTimeoutMinutes: rows[0].idle_timeout_minutes,
    ssoEnabled: rows[0].sso_enabled,
  };
}
