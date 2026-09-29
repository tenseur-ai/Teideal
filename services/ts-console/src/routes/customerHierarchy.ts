import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  HierarchyMoveError,
  moveCustomer,
  readCustomerTree,
  type BalanceMode,
} from "../lib/customerHierarchy.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";
const WRITE_ROLES = ["Owner", "Billing Admin"] as const;

interface CustomerInsert {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  parent_customer_id: string | null;
  balance_mode: BalanceMode;
  created_at: Date | string;
  updated_at: Date | string;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function parseIdentity(body: unknown): { error: string } | { name: string; email: string } {
  const record = asRecord(body);
  if (typeof record.name !== "string" || !record.name.trim() || typeof record.email !== "string" || !record.email.trim()) {
    return { error: "name and email are required" };
  }
  return { name: record.name, email: record.email };
}

function parseBalanceMode(body: unknown): { error: string } | { value: BalanceMode | null } {
  const value = asRecord(body).balance_mode;
  if (value === undefined) return { value: null };
  if (value !== "pooled" && value !== "isolated") return { error: "balance_mode must be pooled or isolated" };
  return { value };
}

async function rejectInvisible(
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

export function registerCustomerHierarchyRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/organisations", { role: [...WRITE_ROLES] }, async (req, reply) => {
      const identity = parseIdentity(req.body);
      if ("error" in identity) return reply.code(400).send({ error: identity.error });
      const mode = parseBalanceMode(req.body);
      if ("error" in mode) return reply.code(400).send({ error: mode.error });
      // The schema rejects a pooled root. Say so before the insert.
      if (mode.value === "pooled") {
        return reply.code(400).send({ error: "an organisation root must use an isolated balance" });
      }
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<CustomerInsert>(
          `INSERT INTO customers (tenant_id, name, email, parent_customer_id, balance_mode)
           VALUES ($1, $2, $3, NULL, 'isolated')
           RETURNING id, tenant_id, name, email, parent_customer_id, balance_mode, created_at, updated_at`,
          [tenantId, identity.name, identity.email],
        )).rows[0],
      );
      return reply.code(201).send(row);
    });

    consoleRoute(scoped, "post", "/organisations/:id/teams", { role: [...WRITE_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const identity = parseIdentity(req.body);
      if ("error" in identity) return reply.code(400).send({ error: identity.error });
      const mode = parseBalanceMode(req.body);
      if ("error" in mode) return reply.code(400).send({ error: mode.error });
      const balanceMode: BalanceMode = mode.value ?? "isolated";
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, id))) return null;
        return (await client.query<CustomerInsert>(
          `INSERT INTO customers (tenant_id, name, email, parent_customer_id, balance_mode)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, tenant_id, name, email, parent_customer_id, balance_mode, created_at, updated_at`,
          [tenantId, identity.name, identity.email, id, balanceMode],
        )).rows[0];
      });
      if (!row) {
        await rejectInvisible(pool, tenantId, "/organisations/:id/teams", "POST", reply);
        return;
      }
      return reply.code(201).send(row);
    });

    consoleRoute(scoped, "get", "/organisations/:id/tree", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const tree = await withTenant(pool, tenantId, (client) => readCustomerTree(client, tenantId, id));
      if (!tree) {
        await rejectInvisible(pool, tenantId, "/organisations/:id/tree", "GET", reply);
        return;
      }
      return reply.send(tree);
    });

    consoleRoute(scoped, "patch", "/organisations/:id/parent", { role: [...WRITE_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const newParent = asRecord(req.body).new_parent_customer_id;
      if (typeof newParent !== "string" || !UUID_RE.test(newParent)) {
        return reply.code(400).send({ error: "new_parent_customer_id must be a UUID" });
      }
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const updated = await withTenant(pool, tenantId, async (client) => {
          await moveCustomer(client, tenantId, id, newParent, userId);
          return (await client.query<CustomerInsert>(
            `SELECT id, tenant_id, name, email, parent_customer_id, balance_mode, created_at, updated_at
             FROM customers WHERE id = $1`,
            [id],
          )).rows[0] ?? null;
        });
        return reply.send(updated);
      } catch (error) {
        if (!(error instanceof HierarchyMoveError)) throw error;
        if (error.reason === "cycle") return reply.code(400).send({ error: "circular hierarchy" });
        await rejectInvisible(pool, tenantId, "/organisations/:id/parent", "PATCH", reply);
        return;
      }
    });
  });
}
