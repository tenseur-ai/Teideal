import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { insertCostRate, listCostRates, validateCostRateInput } from "../lib/costRates.js";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES, type Role } from "../lib/users.js";

export function registerCostRateRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(
      scoped,
      "post",
      "/cost-rates",
      { role: ["Owner", "Billing Admin"] },
      async (req, reply) => {
        const validated = validateCostRateInput(req.body);
        if ("error" in validated) {
          return reply.code(400).send({ error: validated.error });
        }

        const { tenantId, userId } = req.consolePrincipal!;

        const result = await withTenant(pool, tenantId, async (client) => {
          const res = await insertCostRate(client, tenantId, validated);
          if (res.kind === "created") {
            await recordConfigChangeWithClient(
              client,
              tenantId,
              { userId },
              {
                objectType: "CostRate",
                objectId: res.rate.id,
                before: null,
                after: res.rate,
              },
            );
          }
          return res;
        });

        if (result.kind === "conflict") {
          return reply.code(409).send({
            error: "a cost rate entry already exists for this model, metric, and effective date",
          });
        }

        return reply.code(201).send(result.rate);
      },
    );

    consoleRoute(
      scoped,
      "get",
      "/cost-rates",
      { role: ROLES as Role[] },
      async (req, reply) => {
        const { tenantId } = req.consolePrincipal!;
        const query = req.query as { model?: string; metric?: string };

        const rates = await withTenant(pool, tenantId, async (client) => {
          return listCostRates(client, tenantId, {
            model: typeof query.model === "string" ? query.model : undefined,
            metric: typeof query.metric === "string" ? query.metric : undefined,
          });
        });

        return reply.code(200).send({ data: rates });
      },
    );
  });
}
