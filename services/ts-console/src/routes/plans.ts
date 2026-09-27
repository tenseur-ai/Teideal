import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import {
  insertPlan,
  insertPlanRates,
  listPlans,
  publishDraftPlan,
  readPlan,
  updateDraftPlan,
  validatePlanInput,
} from "../lib/plans.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISH_CONFLICT = "plan is not a draft (already published, or does not exist for this tenant)";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export function registerPlanRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/plans", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const parsed = validatePlanInput(req.body, "create");
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const created = await withTenant(pool, tenantId, async (client) => {
          const id = await insertPlan(client, tenantId, userId, parsed);
          await insertPlanRates(client, tenantId, id, parsed.rates);
          const plan = await readPlan(client, tenantId, id);
          if (!plan) throw new Error("inserted plan was not readable");
          await recordConfigChangeWithClient(client, tenantId, { userId }, {
            objectType: "Plan",
            objectId: id,
            before: null,
            after: plan,
          });
          return plan;
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(400).send({ error: "duplicate rate for the same metric and model" });
        }
        throw error;
      }
    });

    consoleRoute(scoped, "get", "/plans", { role: [...ROLES] }, async (req, reply) => {
      const query = req.query as { limit?: unknown; cursor?: unknown };
      if (query.limit !== undefined && typeof query.limit !== "string") {
        return reply.code(400).send({ error: "limit must be an integer" });
      }
      const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        return reply.code(400).send({ error: "limit must be a positive integer" });
      }
      const limit = Math.min(requestedLimit, 200);
      if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
        return reply.code(400).send({ error: "cursor must be a valid plan id" });
      }

      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, (client) =>
        listPlans(client, tenantId, typeof query.cursor === "string" ? query.cursor : null, limit + 1),
      );
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });

    consoleRoute(scoped, "get", "/plans/:id", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const plan = await withTenant(pool, tenantId, (client) => readPlan(client, tenantId, id));
      if (!plan) return reply.code(404).send({ error: "plan not found" });
      return reply.send(plan);
    });

    consoleRoute(scoped, "patch", "/plans/:id", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validatePlanInput(req.body ?? {}, "patch");
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const result = await withTenant(pool, tenantId, async (client) => {
          const updated = await updateDraftPlan(client, tenantId, id, parsed);
          if (updated.status !== "ok" || !updated.changed) return updated;
          await recordConfigChangeWithClient(client, tenantId, { userId }, {
            objectType: "Plan",
            objectId: id,
            before: updated.before,
            after: updated.after,
          });
          return updated;
        });
        if (result.status === "not_found") return reply.code(404).send({ error: "plan not found" });
        if (result.status === "published") return reply.code(409).send({ error: "cannot edit a published plan" });
        return reply.send(result.after);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(400).send({ error: "duplicate rate for the same metric and model" });
        }
        throw error;
      }
    });

    consoleRoute(scoped, "post", "/plans/:id/publish", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      const published = await withTenant(pool, tenantId, async (client) => {
        const plan = await publishDraftPlan(client, tenantId, id, userId);
        if (!plan) return null;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Plan",
          objectId: id,
          before: { status: "draft" },
          after: { status: "published", version: 1 },
        });
        return plan;
      });
      if (!published) return reply.code(409).send({ error: PUBLISH_CONFLICT });
      return reply.send(published);
    });
  });
}
