import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { customerVisible, parseExplicitTimestamp } from "../lib/grants.js";
import {
  assignSubscription,
  isFamilyVersionConflict,
  nextPeriodBoundary,
  planIdForFamilyVersion,
  previewMigration,
  publishNewVersion,
  readBillingAnchor,
  scheduleMigration,
  setGrandfathered,
  type PlanVersionOverrides,
} from "../lib/planVersions.js";
import { validatePlanInput, type PlanRate } from "../lib/plans.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";
const EITHER_SCHEDULE =
  "provide either migration_date or use_next_period_boundary";

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
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

function versionOverrides(body: unknown): { error: string } | { rates: PlanRate[]; overrides: PlanVersionOverrides } {
  const parsed = validatePlanInput(body ?? {}, "patch");
  if ("error" in parsed) return parsed;
  if (parsed.rates === undefined) return { error: "rates must be an array" };
  const overrides: PlanVersionOverrides = {};
  if (parsed.name !== undefined) overrides.name = parsed.name;
  if (parsed.currency !== undefined) overrides.currency = parsed.currency;
  if (parsed.billing_interval !== undefined) overrides.billing_interval = parsed.billing_interval;
  if (parsed.included_credits !== undefined) overrides.included_credits = parsed.included_credits;
  if (parsed.hard_cap !== undefined) overrides.hard_cap = parsed.hard_cap;
  if (parsed.soft_cap !== undefined) overrides.soft_cap = parsed.soft_cap;
  if (parsed.consumption_order !== undefined) overrides.consumption_order = parsed.consumption_order;
  return { rates: parsed.rates, overrides };
}

function positiveInteger(value: unknown, field: string): { error: string } | { value: number } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { error: `${field} must be a positive integer` };
  }
  return { value };
}

export function registerPlanVersionRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/plans/:planFamilyId/versions", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { planFamilyId } = req.params as { planFamilyId: string };
      if (!UUID_RE.test(planFamilyId)) return reply.code(400).send({ error: "planFamilyId must be a UUID" });
      const parsed = versionOverrides(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const published = await withTenant(pool, tenantId, (client) =>
          publishNewVersion(client, tenantId, planFamilyId, userId, parsed.rates, parsed.overrides),
        );
        if (published.status === "not_found") return reply.code(404).send({ error: "plan not found" });
        if (published.status === "unpublished") {
          return reply.code(409).send({ error: "publish the plan before creating another version" });
        }
        return reply.code(201).send(published.plan);
      } catch (error) {
        if (isFamilyVersionConflict(error)) {
          return reply.code(409).send({
            error: "a version with that number was published concurrently; retry the request",
          });
        }
        if (isUniqueViolation(error)) {
          return reply.code(400).send({ error: "duplicate rate for the same metric and model" });
        }
        throw error;
      }
    });

    consoleRoute(scoped, "post", "/customers/:id/subscription", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = asRecord(req.body);
      if (typeof body.plan_id !== "string" || !UUID_RE.test(body.plan_id)) {
        return reply.code(400).send({ error: "plan_id must be a UUID" });
      }
      const planId = body.plan_id;
      const tenantId = req.consolePrincipal!.tenantId;
      const assigned = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { status: "invisible" as const };
        return assignSubscription(client, tenantId, id, planId);
      });
      if (assigned.status === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/subscription", "POST", reply);
        return;
      }
      if (assigned.status === "plan_not_found") return reply.code(404).send({ error: "plan not found" });
      if (assigned.status !== "ok") return reply.code(404).send({ error: "subscription not found" });
      return reply.code(201).send(assigned.subscription);
    });

    consoleRoute(scoped, "post", "/customers/:id/subscription/schedule-migration", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = asRecord(req.body);
      const targetVersion = positiveInteger(body.target_version, "target_version");
      if ("error" in targetVersion) return reply.code(400).send({ error: targetVersion.error });
      if (body.use_next_period_boundary !== undefined && typeof body.use_next_period_boundary !== "boolean") {
        return reply.code(400).send({ error: "use_next_period_boundary must be a boolean" });
      }
      const useBoundary = body.use_next_period_boundary === true;
      const hasDate = body.migration_date !== undefined && body.migration_date !== null;
      if (useBoundary === hasDate) return reply.code(400).send({ error: EITHER_SCHEDULE });
      let explicitDate: Date | null = null;
      if (hasDate) {
        const parsedDate = parseExplicitTimestamp(body.migration_date, "migration_date");
        if ("error" in parsedDate) return reply.code(400).send({ error: parsedDate.error });
        explicitDate = parsedDate.value;
      }
      const tenantId = req.consolePrincipal!.tenantId;
      const scheduled = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { status: "invisible" as const };
        const family = (await client.query<{ plan_family_id: string }>(
          `SELECT plan_family_id FROM customer_plan_subscriptions
           WHERE tenant_id = $1 AND customer_id = $2`,
          [tenantId, id],
        )).rows[0];
        if (!family) return { status: "not_found" as const };
        const targetPlanId = await planIdForFamilyVersion(client, tenantId, family.plan_family_id, targetVersion.value);
        if (!targetPlanId) return { status: "plan_not_found" as const };
        let migrationDate = explicitDate;
        if (migrationDate === null) {
          const anchor = await readBillingAnchor(client, tenantId, id);
          try {
            migrationDate = nextPeriodBoundary(anchor.timezone, anchor.anchorDay, new Date());
          } catch (error) {
            const message = error instanceof Error ? error.message : "billing timezone is invalid";
            return { status: "bad_anchor" as const, message };
          }
        }
        return scheduleMigration(client, tenantId, id, targetPlanId, migrationDate);
      });
      if (scheduled.status === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/subscription/schedule-migration", "POST", reply);
        return;
      }
      if (scheduled.status === "bad_anchor") return reply.code(400).send({ error: scheduled.message });
      if (scheduled.status === "not_found") return reply.code(404).send({ error: "subscription not found" });
      if (scheduled.status === "plan_not_found") return reply.code(404).send({ error: "plan version not found" });
      return reply.send(scheduled.subscription);
    });

    consoleRoute(scoped, "post", "/customers/:id/subscription/grandfather", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = asRecord(req.body);
      if (typeof body.grandfathered !== "boolean") {
        return reply.code(400).send({ error: "grandfathered must be a boolean" });
      }
      const grandfathered = body.grandfathered;
      const tenantId = req.consolePrincipal!.tenantId;
      const updated = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return { status: "invisible" as const };
        const subscription = await setGrandfathered(client, tenantId, id, grandfathered);
        if (!subscription) return { status: "not_found" as const };
        return { status: "ok" as const, subscription };
      });
      if (updated.status === "invisible") {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/subscription/grandfather", "POST", reply);
        return;
      }
      if (updated.status === "not_found") return reply.code(404).send({ error: "subscription not found" });
      return reply.send(updated.subscription);
    });

    consoleRoute(scoped, "get", "/plans/:planFamilyId/versions/:version/migration-preview", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { planFamilyId, version } = req.params as { planFamilyId: string; version: string };
      if (!UUID_RE.test(planFamilyId)) return reply.code(400).send({ error: "planFamilyId must be a UUID" });
      if (!/^[1-9]\d*$/.test(version)) return reply.code(400).send({ error: "version must be a positive integer" });
      const versionNumber = Number(version);
      const tenantId = req.consolePrincipal!.tenantId;
      const preview = await withTenant(pool, tenantId, async (client) => {
        const targetPlanId = await planIdForFamilyVersion(client, tenantId, planFamilyId, versionNumber);
        if (!targetPlanId) return null;
        return previewMigration(client, tenantId, targetPlanId);
      });
      if (!preview) return reply.code(404).send({ error: "plan version not found" });
      return reply.send(preview);
    });
  });
}
