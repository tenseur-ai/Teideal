import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { mapBilledLines } from "../lib/verify/billedLineMapper.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const VERIFY_ROLES = ["Owner", "Billing Admin", "Finance"] as const;

export function registerVerifyRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/verify/map-billed-lines", { role: [...VERIFY_ROLES] }, async (req, reply) => {
      const result = await mapBilledLines(pool, req.consolePrincipal!.tenantId);
      return reply.code(200).send(result);
    });
  });
}
