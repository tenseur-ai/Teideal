import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  checkHierarchyLimits,
  customerIsNested,
  lockBillingGrants,
  resolveBillingCustomerId,
} from "../lib/customerHierarchy.js";
import { consumeAcrossGrants, listConsumptionTimeline, validateCustomerConsumeInput } from "../lib/consumptionOrder.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";
const INSUFFICIENT_BALANCE = "insufficient balance";

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
      // Nested customers are ceiling-checked before the draw. A standalone
      // root keeps consumeAcrossGrants' overage path. The pre-lock matches
      // lockEligibleGrants' row order so the check and the unmodified draw
      // observe the same grant rows.
      const outcome = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { kind: "invisible" as const };
        const billingCustomerId = await resolveBillingCustomerId(client, tenantId, id);
        if (await customerIsNested(client, tenantId, id)) {
          await lockBillingGrants(client, tenantId, billingCustomerId, parsed.as_of);
          const limits = await checkHierarchyLimits(client, tenantId, id, parsed.amount, parsed.as_of);
          if (!limits.ok) return { kind: "insufficient" as const, limits };
        }
        const record = await consumeAcrossGrants(client, tenantId, billingCustomerId, parsed);
        return { kind: "ok" as const, record };
      });
      if (outcome.kind === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consume", "POST", reply);
        return;
      }
      if (outcome.kind === "insufficient") {
        return reply.code(409).send({
          error: INSUFFICIENT_BALANCE,
          governing_customer_id: outcome.limits.governingCustomerId,
          available: outcome.limits.available,
        });
      }
      return reply.code(201).send(outcome.record);
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
