import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sweepExpiredSessions } from "../lib/sessions.js";

// The security monitoring dashboard (TEID-41-T6/AC2). security_events spans
// tenants by nature (an attempt made *by* one tenant *against* another), so
// it is deliberately not gated by tenant API key -- it is gated by a
// separate internal-admin secret, outside tenant-console RBAC; see
// docs/isolation-design.md.
export function registerSecurityRoutes(app: FastifyInstance, pool: Pool, adminSecret: string) {
  app.get("/admin/security-events", async (req, reply) => {
    if (req.headers["x-internal-admin-key"] !== adminSecret) {
      return reply.code(401).send({ error: "missing or invalid admin key" });
    }
    const { rows } = await pool.query(
      `SELECT id, occurred_at, acting_tenant_id, target_tenant_id, endpoint, http_method, detail, resolved_action
       FROM security_events
       ORDER BY occurred_at DESC
       LIMIT 500`,
    );
    return reply.send({ data: rows });
  });

  // TEID-91-T6: reclaims idle-expired sessions on demand. Runs
  // automatically on a timer too (see server.ts); exposed here, admin-key
  // gated the same way, both as a genuine ops control (force a sweep
  // without waiting for the timer) and so tests can measure it under load.
  app.post("/admin/session-sweep", async (req, reply) => {
    if (req.headers["x-internal-admin-key"] !== adminSecret) {
      return reply.code(401).send({ error: "missing or invalid admin key" });
    }
    const removed = await sweepExpiredSessions(pool);
    return reply.send({ removed });
  });
}
