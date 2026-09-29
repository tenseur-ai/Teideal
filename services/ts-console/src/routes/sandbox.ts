import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { insertPlan, insertPlanRates, listPlans, readPlan, type CreatePlanInput, type PlanRecord } from "../lib/plans.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";
import { insertKey } from "./apiKeys.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TenantRow {
  id: string;
  external_key: string;
  name: string;
  kind: "production" | "sandbox";
  parent_tenant_id: string | null;
}

interface PromotionRow {
  source_plan_id: string;
  created_plan_id: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function tenantById(pool: Pool, id: string): Promise<TenantRow | null> {
  return (await pool.query<TenantRow>(
    `SELECT id, external_key, name, kind, parent_tenant_id FROM tenants WHERE id = $1`,
    [id],
  )).rows[0] ?? null;
}

export async function ownedSandbox(pool: Pool, sandboxId: string, productionId: string): Promise<TenantRow | null> {
  const tenant = await tenantById(pool, sandboxId);
  if (!tenant || tenant.kind !== "sandbox" || tenant.parent_tenant_id !== productionId) return null;
  return tenant;
}

function planInput(plan: PlanRecord): CreatePlanInput {
  return {
    name: plan.name,
    currency: plan.currency,
    billing_interval: plan.billing_interval,
    included_credits: plan.included_credits,
    hard_cap: plan.hard_cap,
    soft_cap: plan.soft_cap,
    consumption_order: plan.consumption_order,
    rates: plan.rates,
  };
}

async function promotedSourceIds(pool: Pool, productionId: string, sandboxId: string): Promise<Set<string>> {
  const rows = await withTenant(pool, productionId, async (client) =>
    (await client.query<{ source_plan_id: string }>(
      `SELECT source_plan_id
       FROM sandbox_promotions
       WHERE production_tenant_id = $1 AND sandbox_tenant_id = $2`,
      [productionId, sandboxId],
    )).rows,
  );
  return new Set(rows.map((row) => row.source_plan_id));
}

async function insertPromotedPlans(
  client: PoolClient,
  productionId: string,
  sandboxId: string,
  userId: string,
  plans: PlanRecord[],
): Promise<PromotionRow[]> {
  // Serialize promotions for this sandbox. The cataloged schema intentionally
  // has no cross-tenant FK/unique constraint on source_plan_id.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sandbox-promotion:${sandboxId}`]);
  const existing = new Set((await client.query<{ source_plan_id: string }>(
    `SELECT source_plan_id
     FROM sandbox_promotions
     WHERE production_tenant_id = $1 AND sandbox_tenant_id = $2
       AND source_plan_id::text = ANY($3::text[])`,
    [productionId, sandboxId, plans.map((plan) => plan.id)],
  )).rows.map((row) => row.source_plan_id));
  if (existing.size > 0) {
    const error = new Error("one or more plans have already been promoted");
    (error as Error & { statusCode: number }).statusCode = 409;
    throw error;
  }

  const promoted: PromotionRow[] = [];
  for (const source of plans) {
    const createdPlanId = await insertPlan(client, productionId, userId, planInput(source));
    await insertPlanRates(client, productionId, createdPlanId, source.rates);
    const created = await readPlan(client, productionId, createdPlanId);
    if (!created) throw new Error("promoted plan was not readable");
    await client.query(
      `INSERT INTO sandbox_promotions (
         sandbox_tenant_id, production_tenant_id, source_plan_id, created_plan_id, promoted_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)`,
      [sandboxId, productionId, source.id, createdPlanId, userId],
    );
    await recordConfigChangeWithClient(client, productionId, { userId }, {
      objectType: "Plan",
      objectId: createdPlanId,
      before: null,
      after: created,
    });
    promoted.push({ source_plan_id: source.id, created_plan_id: createdPlanId });
  }
  return promoted;
}

export function registerSandboxRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/tenants/:id/sandbox", { role: ["Owner"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      if (id !== tenantId) return reply.code(403).send({ error: "tenant is not accessible to this operator" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const parent = (await client.query<TenantRow>(
          `SELECT id, external_key, name, kind, parent_tenant_id
           FROM tenants WHERE id = $1 FOR UPDATE`,
          [id],
        )).rows[0];
        if (!parent) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "tenant not found" });
        }
        if (parent.kind !== "production") {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "a sandbox can only be created for a production tenant" });
        }
        const existing = (await client.query<{ id: string }>(
          `SELECT id FROM tenants WHERE kind = 'sandbox' AND parent_tenant_id = $1`,
          [id],
        )).rows[0];
        if (existing) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "sandbox already exists for this tenant" });
        }

        const sandboxId = randomUUID();
        await client.query(
          `INSERT INTO tenants (id, external_key, name, kind, parent_tenant_id)
           VALUES ($1, $2, $3, 'sandbox', $4)`,
          [sandboxId, `${parent.external_key}_sandbox_${sandboxId}`, `${parent.name} Sandbox`, id],
        );
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [sandboxId]);
        const created = await insertKey(client, sandboxId, userId, "admin", "sandbox", "Initial sandbox key");
        await client.query("COMMIT");
        return reply.code(201).send({
          sandbox_tenant_id: sandboxId,
          api_key: {
            id: created.row.id,
            key: created.plaintext,
            scope: created.row.scope,
            environment: created.row.environment,
            label: created.row.label,
            display_hint: created.row.display_hint,
            customer_id: null,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "sandbox already exists for this tenant" });
        }
        throw error;
      } finally {
        client.release();
      }
    });

    consoleRoute(scoped, "get", "/tenants/:id", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenant = await tenantById(pool, id);
      const callerTenantId = req.consolePrincipal!.tenantId;
      if (!tenant || (tenant.id !== callerTenantId && tenant.parent_tenant_id !== callerTenantId)) {
        return reply.code(404).send({ error: "tenant not found" });
      }
      return reply.send({ id: tenant.id, kind: tenant.kind, parent_tenant_id: tenant.parent_tenant_id });
    });

    consoleRoute(
      scoped,
      "get",
      "/tenants/:id/sandbox/promote-plans/preview",
      { role: ["Owner", "Billing Admin"] },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
        const productionId = req.consolePrincipal!.tenantId;
        if (!(await ownedSandbox(pool, id, productionId))) {
          return reply.code(403).send({ error: "sandbox is not accessible to this operator" });
        }
        const alreadyPromoted = await promotedSourceIds(pool, productionId, id);
        const plans = await withTenant(pool, id, (client) => listPlans(client, id, null, 10_000));
        return reply.send({
          sandbox_tenant_id: id,
          production_tenant_id: productionId,
          plans: plans.filter((plan) => !alreadyPromoted.has(plan.id)),
        });
      },
    );

    consoleRoute(
      scoped,
      "post",
      "/tenants/:id/sandbox/promote-plans",
      { role: ["Owner", "Billing Admin"] },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
        const body = (req.body ?? {}) as { plan_ids?: unknown };
        if (!Array.isArray(body.plan_ids) || body.plan_ids.some((value) => typeof value !== "string" || !UUID_RE.test(value))) {
          return reply.code(400).send({ error: "plan_ids must be an array of UUIDs" });
        }
        const planIds = [...new Set(body.plan_ids as string[])];
        const productionId = req.consolePrincipal!.tenantId;
        const userId = req.consolePrincipal!.userId;
        if (!(await ownedSandbox(pool, id, productionId))) {
          return reply.code(403).send({ error: "sandbox is not accessible to this operator" });
        }

        const plans = await withTenant(pool, id, async (client) => {
          const loaded: PlanRecord[] = [];
          for (const planId of planIds) {
            const plan = await readPlan(client, id, planId);
            if (!plan) return null;
            loaded.push(plan);
          }
          return loaded;
        });
        if (!plans) return reply.code(404).send({ error: "one or more sandbox plans were not found" });

        try {
          const promoted = await withTenant(pool, productionId, (client) =>
            insertPromotedPlans(client, productionId, id, userId, plans),
          );
          return reply.send({
            sandbox_tenant_id: id,
            production_tenant_id: productionId,
            promoted,
          });
        } catch (error) {
          if (typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 409) {
            return reply.code(409).send({ error: (error as Error).message });
          }
          throw error;
        }
      },
    );
  });
}
