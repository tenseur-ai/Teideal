// Deliberately minimal API-key-to-tenant lookup -- see the Go service's
// internal/auth for the same rationale. Superseded, not duplicated, by
// TEID-92 (key lifecycle) and TEID-43 (RBAC).
import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";

export interface Principal {
  tenantId: string;
  tenantKey: string;
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
  const { rows } = await pool.query<{ id: string; external_key: string }>(
    `SELECT t.id, t.external_key
     FROM api_keys k
     JOIN tenants t ON t.id = k.issued_to_tenant_id
     WHERE k.key_hash = $1`,
    [hashKey(plaintextKey)],
  );
  if (rows.length === 0) return null;
  return { tenantId: rows[0].id, tenantKey: rows[0].external_key };
}

export function requireAuth(pool: Pool) {
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
    req.principal = principal;
  };
}
