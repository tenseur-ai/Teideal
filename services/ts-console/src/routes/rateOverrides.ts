import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { resolveEffectivePlanId } from "../lib/planVersions.js";
import {
  checkOverlap,
  insertOverride,
  insertPricedUsageLine,
  listOverrides,
  planVisible,
  readOverride,
  resolveEffectiveRate,
  validateOverrideInput,
  validatePriceUsageInput,
} from "../lib/rateOverrides.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";
const NO_RATE = "no rate configured for this metric/model on this plan";
const NO_SUBSCRIPTION = "no plan subscription for this customer";
const OVERLAP = "an overlapping rate override already exists for this customer, metric, and model";
const PRECEDENCE_RULE =
  "An active customer rate override always takes precedence over the plan rate for the same metric and model. When no override is active, or the override's date range has ended, pricing uses the plan's configured rate.";

function pageQuery(
  query: { limit?: unknown; cursor?: unknown },
): { error: string } | { limit: number; cursor: string | null } {
  if (query.limit !== undefined && typeof query.limit !== "string") return { error: "limit must be an integer" };
  const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) return { error: "limit must be a positive integer" };
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
    return { error: "cursor must be a valid override id" };
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

export function registerRateOverrideRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/customers/:id/rate-overrides", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const parsed = validateOverrideInput({ ...body, customer_id: id });
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const created = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { kind: "invisible" as const };
        if (await checkOverlap(client, tenantId, id, parsed.metric, parsed.model, parsed.start_date, parsed.end_date)) {
          return { kind: "overlap" as const };
        }
        const overrideId = await insertOverride(client, tenantId, userId, parsed);
        const override = await readOverride(client, tenantId, overrideId);
        if (!override) throw new Error("inserted rate override was not readable");
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "CustomerRateOverride",
          objectId: overrideId,
          customerId: id,
          before: null,
          after: override,
        });
        return { kind: "ok" as const, override };
      });
      if (created.kind === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/rate-overrides", "POST", reply);
        return;
      }
      if (created.kind === "overlap") return reply.code(409).send({ error: OVERLAP });
      return reply.code(201).send(created.override);
    });

    consoleRoute(scoped, "get", "/customers/:id/rate-overrides", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const page = pageQuery(req.query as { limit?: unknown; cursor?: unknown });
      if ("error" in page) return reply.code(400).send({ error: page.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        return listOverrides(client, tenantId, id, page.cursor, page.limit + 1);
      });
      if (!rows) {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/rate-overrides", "GET", reply);
        return;
      }
      const hasMore = rows.length > page.limit;
      const data = hasMore ? rows.slice(0, page.limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });

    consoleRoute(scoped, "get", "/docs/rate-override-precedence", { role: [...ROLES] }, async (_req, reply) => {
      return reply.send({ rule: PRECEDENCE_RULE });
    });

    consoleRoute(scoped, "post", "/customers/:id/price-usage", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validatePriceUsageInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const priced = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { kind: "invisible" as const };
        let planId = parsed.plan_id;
        if (planId === undefined) {
          const resolvedPlanId = await resolveEffectivePlanId(client, tenantId, id, parsed.as_of);
          if (!resolvedPlanId) return { kind: "no_subscription" as const };
          planId = resolvedPlanId;
        }
        if (!(await planVisible(client, planId))) return { kind: "no_rate" as const };
        const resolved = await resolveEffectiveRate(
          client,
          tenantId,
          id,
          planId,
          parsed.metric,
          parsed.model,
          parsed.as_of,
        );
        if (!resolved) return { kind: "no_rate" as const };
        const line = await insertPricedUsageLine(
          client,
          tenantId,
          id,
          planId,
          parsed.metric,
          parsed.model,
          parsed.quantity,
          resolved.rate,
          resolved.overrideId,
          parsed.as_of,
        );
        return { kind: "ok" as const, line };
      });
      if (priced.kind === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/price-usage", "POST", reply);
        return;
      }
      if (priced.kind === "no_subscription") return reply.code(404).send({ error: NO_SUBSCRIPTION });
      if (priced.kind === "no_rate") return reply.code(404).send({ error: NO_RATE });
      return reply.code(201).send(priced.line);
    });
  });
}
