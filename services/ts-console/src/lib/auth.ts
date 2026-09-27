// Deliberately minimal API-key-to-tenant lookup -- see the Go service's
// internal/auth for the same rationale. Superseded, not duplicated, by
// TEID-92 (key lifecycle) and TEID-43 (RBAC).
import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";

export interface Principal {
  tenantId: string;
  tenantKey: string;
  apiKeyId: string;
  scope: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export async function resolveApiKey(pool: Pool, plaintextKey: string): Promise<Principal | null> {
  const { rows } = await pool.query<{ id: string; external_key: string; api_key_id: string; scope: string }>(
    `SELECT t.id, t.external_key, k.id AS api_key_id, k.scope
     FROM api_keys k
     JOIN tenants t ON t.id = k.issued_to_tenant_id
     WHERE k.key_hash = $1
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [hashKey(plaintextKey)],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.api_key_id]).catch(() => undefined);
  return { tenantId: row.id, tenantKey: row.external_key, apiKeyId: row.api_key_id, scope: row.scope };
}

export function requireAuth(pool: Pool, requiredScope?: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length) {
      return reply.code(401).send({ error: "missing or malformed Authorization header" });
    }
    const key = header.slice("Bearer ".length).trim();
    const principal = await resolveApiKey(pool, key);
    if (!principal) {
      return reply.code(401).send({ error: "invalid api key" });
    }
    if (requiredScope && principal.scope !== requiredScope && principal.scope !== "admin") {
      return reply.code(403).send({ error: "api key scope does not permit this operation" });
    }
    req.principal = principal;
  };
}
