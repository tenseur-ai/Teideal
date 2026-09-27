import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const TTL_MINUTES = 5;

export type PendingPurpose = "verify" | "enroll";

// See sessions.ts's Queryable comment: accepts either the pool or an
// already-checked-out client so a caller mid-transaction doesn't acquire
// a second connection from the same pool while the first is still open.
type Queryable = Pool | PoolClient;

export async function createPendingLogin(
  db: Queryable,
  tenantId: string,
  userId: string,
  purpose: PendingPurpose,
): Promise<string> {
  const plaintext = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  await db.query(
    `INSERT INTO pending_logins (issued_to_tenant_id, user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${TTL_MINUTES} minutes')`,
    [tenantId, userId, hash, purpose],
  );
  return plaintext;
}

export interface PendingLogin {
  id: string;
  tenantId: string;
  userId: string;
  purpose: PendingPurpose;
}

// Read-only: a wrong MFA code shouldn't burn the pending-login token, only
// a successful verification should (see deletePendingLogin). Expired rows
// are treated as not found.
export async function getPendingLogin(pool: Pool, tokenPlaintext: string): Promise<PendingLogin | null> {
  const hash = createHash("sha256").update(tokenPlaintext).digest("hex");
  const { rows } = await pool.query<{ id: string; issued_to_tenant_id: string; user_id: string; purpose: PendingPurpose }>(
    `SELECT id, issued_to_tenant_id, user_id, purpose FROM pending_logins WHERE token_hash = $1 AND expires_at > now()`,
    [hash],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, tenantId: rows[0].issued_to_tenant_id, userId: rows[0].user_id, purpose: rows[0].purpose };
}

export async function deletePendingLogin(pool: Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM pending_logins WHERE id = $1`, [id]);
}
