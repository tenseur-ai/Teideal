import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { getSyncHealth } from "../lib/connectors/syncHealth.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const CONNECTOR_ROLES = ["Owner", "Billing Admin", "Developer"] as const;

export function registerConnectorRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));
    consoleRoute(
      scoped,
      "get",
      "/connectors/sync-health",
      { role: [...CONNECTOR_ROLES] },
      async (req, reply) => {
        const data = await getSyncHealth(pool, req.consolePrincipal!.tenantId);
        return reply.send({ data });
      },
    );
  });
}
