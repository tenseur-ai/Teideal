import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import {
  readCustomerOverride,
  readPlanOrderForCustomer,
  upsertCustomerOverride,
  validateConsumptionOrder,
  type ConsumptionSource,
  type DrawableGrant,
} from "../lib/consumptionOrder.js";
import { replayConsumption, type ReplayableConsumeInput } from "../lib/consumptionReplay.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";
const REPLAY_BODY_LIMIT = 4 * 1024 * 1024;

interface ReplayConsumptionRow {
  id: string;
  customer_id: string;
  requested_amount: string;
  unit: string;
  occurred_at: Date | string;
}

interface ReplayGrantRow {
  id: string;
  source: ConsumptionSource;
  expiry_date: Date | string | null;
  created_at: Date | string;
  starting_remaining_amount: string;
  overage_rate: string | null;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function shuffled<T>(values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[replacement]] = [copy[replacement], copy[index]];
  }
  return copy;
}

function parseReplayEventIds(body: unknown): { error: string } | { value: string[] } {
  const ids = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as { event_ids?: unknown }).event_ids
    : undefined;
  if (!Array.isArray(ids) || ids.length === 0) return { error: "event_ids must be a non-empty array" };
  if (ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    return { error: "event_ids must contain only UUIDs" };
  }
  return { value: [...new Set(ids as string[])] };
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
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consumption-order", "PUT", reply);
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
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consumption-order", "GET", reply);
        return;
      }
      return reply.send(result);
    });

    consoleRoute(scoped, "post", "/customers/:id/consumption/replay-check", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = parseReplayEventIds(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const replayed = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        const consumptions = (await client.query<ReplayConsumptionRow>(
          `SELECT id, customer_id, requested_amount::text AS requested_amount, unit, occurred_at
           FROM usage_consumptions
           WHERE tenant_id = $1 AND customer_id = $2 AND id = ANY($3::uuid[])`,
          [tenantId, id, parsed.value],
        )).rows;
        if (consumptions.length !== parsed.value.length) return { error: "one or more event_ids were not found for this customer" };

        const earliest = consumptions.reduce((minimum, row) => {
          const occurredAt = asDate(row.occurred_at) as Date;
          return occurredAt < minimum ? occurredAt : minimum;
        }, asDate(consumptions[0].occurred_at) as Date);
        const grantRows = (await client.query<ReplayGrantRow>(
          `SELECT g.id, g.source, g.expiry_date, g.created_at,
                  (g.remaining_amount + COALESCE(SUM(l.amount) FILTER (WHERE consumed.id IS NOT NULL), 0))::text
                    AS starting_remaining_amount,
                  g.overage_rate::text AS overage_rate
           FROM grants g
           LEFT JOIN usage_consumption_lines l
             ON l.grant_id = g.id AND l.tenant_id = g.tenant_id
           LEFT JOIN usage_consumptions consumed
             ON consumed.id = l.consumption_id
            AND consumed.tenant_id = g.tenant_id
            AND consumed.occurred_at >= $3::timestamptz
           WHERE g.tenant_id = $1
             AND g.customer_id = $2
             AND g.status = 'active'
             AND g.start_date <= $3::timestamptz
             AND (g.expiry_date IS NULL OR g.expiry_date > $3::timestamptz)
           GROUP BY g.id, g.source, g.expiry_date, g.created_at, g.remaining_amount, g.overage_rate`,
          [tenantId, id, earliest],
        )).rows;
        const grants: DrawableGrant[] = grantRows.map((row) => ({
          id: row.id,
          source: row.source,
          expiry_date: asDate(row.expiry_date),
          created_at: asDate(row.created_at) as Date,
          remaining_amount: Number(row.starting_remaining_amount),
          overage_rate: row.overage_rate === null ? null : Number(row.overage_rate),
        }));
        const events: ReplayableConsumeInput[] = consumptions.map((row) => ({
          id: row.id,
          customerId: row.customer_id,
          occurredAt: asDate(row.occurred_at) as Date,
          amount: Number(row.requested_amount),
          unit: row.unit,
        }));
        const [override, planOrder] = await Promise.all([
          readCustomerOverride(client, tenantId, id),
          readPlanOrderForCustomer(client, tenantId, id),
        ]);
        return replayConsumption(shuffled(events), grants, override, planOrder);
      });
      if (!replayed) {
        await rejectInvisibleCustomer(pool, tenantId, "/customers/:id/consumption/replay-check", "POST", reply);
        return;
      }
      if ("error" in replayed) return reply.code(400).send(replayed);
      return reply.send(replayed);
    }, { bodyLimit: REPLAY_BODY_LIMIT });
  });
}
