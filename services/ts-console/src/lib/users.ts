import type { PoolClient } from "pg";
import type { TenantSettings } from "./tenants.js";

export type Role = "Owner" | "Billing Admin" | "Finance" | "Support" | "Developer";

// TEID-91-AC2: mandatory for Owner and Billing Admin, optional for others.
export const MANDATORY_MFA_ROLES: ReadonlySet<Role> = new Set(["Owner", "Billing Admin"]);

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string | null;
  google_subject: string | null;
  role: Role;
  mfa_secret: string | null;
  pending_mfa_secret: string | null;
  mfa_enrolled_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
}

export async function findUserByEmail(client: PoolClient, email: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

export async function findUserByGoogleSubjectOrEmail(
  client: PoolClient,
  subject: string,
  email: string,
): Promise<UserRow | null> {
  const { rows } = await client.query<UserRow>(
    `SELECT * FROM users WHERE google_subject = $1 OR email = $2 LIMIT 1`,
    [subject, email],
  );
  return rows[0] ?? null;
}

export async function findUserById(client: PoolClient, id: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// TEID-91-AC2: mandatory role, OR the tenant has turned it on for
// everyone, OR the user has already enrolled voluntarily -- once enrolled,
// MFA is checked every sign-in rather than becoming meaningless.
export function mfaRequiredFor(user: UserRow, settings: TenantSettings): boolean {
  return MANDATORY_MFA_ROLES.has(user.role) || settings.requireMfaAllRoles || user.mfa_enrolled_at !== null;
}
