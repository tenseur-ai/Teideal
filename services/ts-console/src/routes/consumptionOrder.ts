import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { upsertCustomerOverride, validateConsumptionOrder } from "../lib/consumptionOrder.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";

async function rejectInvisibleCustomer(
  pool: Pool,
  tenantId: string,
  method: string,
  reply: FastifyReply,
) {
  await logBlocked(pool, {
    actingTenantId: tenantId,
    endpoint: "/customers/:id/consumption-order",
    method,
    detail: "customer id not visible to caller's tenant",
    resolvedAction: "blocked_customer_not_visible",
  });
  return reply.code(403).send({ error: CUSTOMER_NOT_VISIBLE });
}

export function registerConsumptionOrderRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "put", "/customers/:id/consumption-order", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validateConsumptionOrder((req.body as { consumption_order?: unknown } | null)?.consumption_order);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const saved = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        const row = await upsertCustomerOverride(client, tenantId, id, userId, parsed.value);
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "CustomerConsumptionOverride",
          objectId: row.id,
          customerId: id,
          before: row.previous === null ? null : { consumption_order: row.previous },
          after: { consumption_order: row.consumption_order },
        });
        return row;
      });
      if (!saved) {
        await rejectInvisibleCustomer(pool, tenantId, "PUT", reply);
        return;
      }
      return reply.send({ consumption_order: saved.consumption_order });
    });

    consoleRoute(scoped, "get", "/customers/:id/consumption-order", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const result = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        const { rows } = await client.query<{ consumption_order: string[] }>(
          `SELECT consumption_order
           FROM customer_consumption_overrides
           WHERE customer_id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        return { consumption_order: rows[0]?.consumption_order ?? null };
      });
      if (!result) {
        await rejectInvisibleCustomer(pool, tenantId, "GET", reply);
        return;
      }
      return reply.send(result);
    });
  });
}
