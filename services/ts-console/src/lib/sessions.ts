import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

// Accepts either the pool or an already-checked-out client: callers that
// already hold a client open (e.g. mid-transaction in loginFlow.ts) must
// reuse it rather than acquiring a second connection from the same pool
// while the first is still held -- concurrent logins deep enough to
// exhaust the pool would otherwise deadlock each other (every held
// connection waiting on a login that itself needs a free connection).
type Queryable = Pool | PoolClient;

function newToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

export async function createSession(
  db: Queryable,
  tenantId: string,
  userId: string,
  idleTimeoutMinutes: number,
): Promise<string> {
  const { plaintext, hash } = newToken();
  await db.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes) VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, hash, idleTimeoutMinutes],
  );
  return plaintext;
}

export interface ValidatedSession {
  sessionId: string;
  tenantId: string;
  userId: string;
}

// Sliding idle timeout: each valid request pushes last_seen_at forward.
// TEID-91-T3's "next action requires re-authentication" after the idle
// window is what the expiry check below produces -- once now() -
// last_seen_at exceeds the timeout snapshotted at session creation, the
// session is gone, not merely stale.
export async function validateSession(pool: Pool, tokenPlaintext: string): Promise<ValidatedSession | null> {
  const hash = createHash("sha256").update(tokenPlaintext).digest("hex");
  const { rows } = await pool.query<{
    id: string;
    issued_to_tenant_id: string;
    user_id: string;
    idle_timeout_minutes: number;
    last_seen_at: string;
  }>(`SELECT id, issued_to_tenant_id, user_id, idle_timeout_minutes, last_seen_at FROM sessions WHERE token_hash = $1`, [hash]);
  if (rows.length === 0) return null;

  const row = rows[0];
  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > row.idle_timeout_minutes * 60_000) {
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [row.id]);
    return null;
  }

  await pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
  return { sessionId: row.id, tenantId: row.issued_to_tenant_id, userId: row.user_id };
}

export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

// TEID-91-T6: bulk-clears every idle-expired session in one statement.
// sessions carries no RLS (see the migration's header comment), so this
// needs no per-tenant loop -- it is the same "system housekeeping, not
// tenant application logic" category as looking up an API key by hash.
export async function sweepExpiredSessions(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sessions WHERE now() - last_seen_at > (idle_timeout_minutes || ' minutes')::interval`,
  );
  return rowCount ?? 0;
}
