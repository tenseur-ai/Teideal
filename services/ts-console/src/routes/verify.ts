import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { GoUsageError } from "../lib/goUsageClient.js";
import { mapBilledLines } from "../lib/verify/billedLineMapper.js";
import { generateDiscrepancyReport } from "../lib/verify/discrepancyReport.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { calendarMonthBounds } from "./periodClose.js";

const VERIFY_ROLES = ["Owner", "Billing Admin", "Finance"] as const;

export function registerVerifyRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/verify/map-billed-lines", { role: [...VERIFY_ROLES] }, async (req, reply) => {
      const result = await mapBilledLines(pool, req.consolePrincipal!.tenantId);
      return reply.code(200).send(result);
    });

    consoleRoute(scoped, "get", "/verify/discrepancy-report", { role: [...VERIFY_ROLES] }, async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (typeof query.period !== "string") {
        return reply.code(400).send({ error: "period must be in YYYY-MM format" });
      }
      const bounds = calendarMonthBounds(query.period);
      if (!bounds) return reply.code(400).send({ error: "period must be in YYYY-MM format" });

      try {
        const report = await generateDiscrepancyReport({
          pool,
          tenantId: req.consolePrincipal!.tenantId,
          authorization: req.headers.authorization!,
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
        });
        return reply.code(200).send(report);
      } catch (error) {
        if (error instanceof GoUsageError) {
          if (error.statusCode === 401 || error.statusCode === 403) {
            return reply.code(error.statusCode).send(error.body ?? { error: "usage service authorization failed" });
          }
          return reply.code(502).send({ error: "usage service request failed" });
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          return reply.code(504).send({ error: "usage service request timed out" });
        }
        throw error;
      }
    });
  });
}
