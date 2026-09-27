import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { consumeAcrossGrants, listConsumptionTimeline, validateCustomerConsumeInput } from "../lib/consumptionOrder.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";

function pageQuery(
  query: { limit?: unknown; cursor?: unknown },
): { error: string } | { limit: number; cursor: string | null } {
  if (query.limit !== undefined && typeof query.limit !== "string") return { error: "limit must be an integer" };
  const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) return { error: "limit must be a positive integer" };
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
    return { error: "cursor must be a valid consumption id" };
  }
  return {
    limit: Math.min(requestedLimit, 200),
    cursor: typeof query.cursor === "string" ? query.cursor : null,
  };
}

async function rejectInvisibleCustomer(
  pool: Pool,
  tenantId: string,
  endpoint: string,
  method: string,
  reply: FastifyReply,
) {
  await logBlocked(pool, {
    actingTenantId: tenantId,
    endpoint,
    method,
    detail: "customer id not visible to caller's tenant",
    resolvedAction: "blocked_customer_not_visible",
  });
  return reply.code(403).send({ error: CUSTOMER_NOT_VISIBLE });
}

export function registerConsumptionRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/customers/:id/consume", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validateCustomerConsumeInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const consumed = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        return consumeAcrossGrants(client, tenantId, id, parsed);
      });
      if (!consumed) {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consume", "POST", reply);
        return;
      }
      return reply.code(201).send(consumed);
    });

    consoleRoute(scoped, "get", "/customers/:id/consumption-timeline", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const page = pageQuery(req.query as { limit?: unknown; cursor?: unknown });
      if ("error" in page) return reply.code(400).send({ error: page.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        return listConsumptionTimeline(client, tenantId, id, page.cursor, page.limit + 1);
      });
      if (!rows) {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consumption-timeline", "GET", reply);
        return;
      }
      const hasMore = rows.length > page.limit;
      const data = hasMore ? rows.slice(0, page.limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });
  });
}
