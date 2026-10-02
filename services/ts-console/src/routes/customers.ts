import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { logBlocked } from "../lib/security.js";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { requireAuth, resolveApiKey } from "../lib/auth.js";
import { CONSOLE_ROUTE_AUDIT } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
}

const CUSTOMER_READ_ROLES = ["Owner", "Billing Admin"] as const;

async function listCustomers(pool: Pool, tenantId: string): Promise<CustomerRow[]> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<CustomerRow>(`SELECT * FROM customers ORDER BY created_at DESC LIMIT 200`);
    return result.rows;
  });
}

async function findCustomer(pool: Pool, tenantId: string, id: string): Promise<CustomerRow | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [id]);
    return rows[0] ?? null;
  });
}

function customerReadAuth(pool: Pool) {
  const sessionAuth = requireSession(pool);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length) {
      return reply.code(401).send({ error: "missing or malformed Authorization header" });
    }
    const token = header.slice("Bearer ".length).trim();
    const apiPrincipal = await resolveApiKey(pool, token);
    if (apiPrincipal) {
      if (apiPrincipal.scope !== "read-only" && apiPrincipal.scope !== "admin") {
        return reply.code(403).send({ error: "api key scope does not permit this operation" });
      }
      req.principal = apiPrincipal;
      return;
    }
    if (token.startsWith("devkey_") || token.startsWith("sk_test_") || token.startsWith("sk_live_")) {
      return reply.code(401).send({ error: "invalid api key" });
    }
    await sessionAuth(req, reply);
    if (reply.sent) return;
    const role = req.consolePrincipal!.role;
    if (!CUSTOMER_READ_ROLES.includes(role as (typeof CUSTOMER_READ_ROLES)[number])) {
      return reply.code(403).send({
        error: `this action requires role ${CUSTOMER_READ_ROLES.join(" or ")}; your role is ${role}`,
      });
    }
  };
}

function readTenantId(req: FastifyRequest): string {
  return req.consolePrincipal?.tenantId ?? req.principal!.tenantId;
}

export function registerCustomerRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/customers", { preHandler: requireAuth(pool, "admin") }, async (req, reply) => {
    const principal = req.principal!;
    const body = req.body as { name?: unknown; email?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || typeof body.email !== "string" || !body.email.trim()) {
      return reply.code(400).send({ error: "name and email are required" });
    }

    const row = await withTenant(pool, principal.tenantId, async (client) => {
      const { rows } = await client.query<CustomerRow>(
        `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING *`,
        [principal.tenantId, body.name, body.email],
      );
      return rows[0];
    });
    return reply.code(201).send(row);
  });

  CONSOLE_ROUTE_AUDIT.push({ method: "get", url: "/customers", auth: { role: [...CUSTOMER_READ_ROLES] } });
  app.get("/customers", { preHandler: customerReadAuth(pool) }, async (req, reply) => {
    const rows = await listCustomers(pool, readTenantId(req));
    return reply.send({ data: rows });
  });

  CONSOLE_ROUTE_AUDIT.push({ method: "get", url: "/customers/:id", auth: { role: [...CUSTOMER_READ_ROLES] } });
  app.get("/customers/:id", { preHandler: customerReadAuth(pool) }, async (req, reply) => {
    const tenantId = readTenantId(req);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "id must be a UUID" });
    }

    const row = await findCustomer(pool, tenantId, id);

    if (!row) {
      // RLS hides both "belongs to another tenant" and "does not exist" the
      // same way, by design -- see docs/isolation-design.md. 403, not 404,
      // rather than let either case leak which one it was.
      await logBlocked(pool, {
        actingTenantId: tenantId,
        endpoint: "/customers/:id",
        method: "GET",
        detail: `requested customer id ${id} not visible to this tenant`,
        resolvedAction: "blocked_customer_not_visible",
      });
      return reply.code(403).send({ error: "not found for this tenant" });
    }
    return reply.send(row);
  });

  app.patch("/customers/:id", { preHandler: requireAuth(pool, "admin") }, async (req, reply) => {
    const principal = req.principal!;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "id must be a UUID" });
    }
    const body = req.body as { name?: unknown; email?: unknown };
    if (body.name !== undefined && typeof body.name !== "string") {
      return reply.code(400).send({ error: "name must be a string" });
    }
    if (body.email !== undefined && typeof body.email !== "string") {
      return reply.code(400).send({ error: "email must be a string" });
    }

    const row = await withTenant(pool, principal.tenantId, async (client) => {
      // RLS's USING clause applies to the implicit SELECT behind an UPDATE
      // too, so a row belonging to another tenant simply doesn't match --
      // this is what stops the id-substitution attack (TEID-41-T8): the
      // WHERE id = $1 is true, but the row isn't visible, so zero rows update.
      const beforeResult = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [id]);
      const before = beforeResult.rows[0];
      if (!before) return null;

      const { rows } = await client.query<CustomerRow>(
        `UPDATE customers SET name = COALESCE($2, name), email = COALESCE($3, email), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, body.name ?? null, body.email ?? null],
      );
      const after = rows[0];
      await recordConfigChangeWithClient(client, principal.tenantId, { apiKeyId: principal.apiKeyId }, {
        objectType: "Customer",
        objectId: id,
        customerId: id,
        before: { name: before.name, email: before.email },
        after: { name: after.name, email: after.email },
      });
      return after;
    });

    if (!row) {
      await logBlocked(pool, {
        actingTenantId: principal.tenantId,
        endpoint: "/customers/:id",
        method: "PATCH",
        detail: `attempted to update customer id ${id} not visible to this tenant`,
        resolvedAction: "blocked_id_substitution",
      });
      return reply.code(403).send({ error: "not found for this tenant" });
    }
    return reply.send(row);
  });
}
