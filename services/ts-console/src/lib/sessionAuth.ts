import type { FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { validateSession } from "./sessions.js";
import { withTenant } from "./db.js";
import { findUserById, type Role } from "./users.js";

export interface ConsolePrincipal {
  sessionId: string;
  tenantId: string;
  userId: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    consolePrincipal?: ConsolePrincipal;
  }
}

// Distinct from lib/auth.ts's requireAuth (API-key -> tenant, for
// programmatic callers): this is a human console user's session, checked
// for idle expiry on every request (TEID-91-AC3/T3).
export function requireSession(pool: Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length) {
      return reply.code(401).send({ error: "missing or malformed Authorization header" });
    }
    const token = header.slice("Bearer ".length).trim();

    const validated = await validateSession(pool, token);
    if (!validated) {
      return reply.code(401).send({ error: "session expired or invalid; please sign in again" });
    }

    const role = await withTenant(pool, validated.tenantId, async (client) => {
      const user = await findUserById(client, validated.userId);
      return user?.role ?? null;
    });
    if (!role) {
      return reply.code(401).send({ error: "session refers to a user that no longer exists" });
    }

    req.consolePrincipal = { sessionId: validated.sessionId, tenantId: validated.tenantId, userId: validated.userId, role };
  };
}
