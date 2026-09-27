import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { logBlocked } from "../lib/security.js";
import { recordConfigChangeWithClient } from "../lib/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export function registerCustomerRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/customers", async (req, reply) => {
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

  app.get("/customers", async (req, reply) => {
    const principal = req.principal!;
    const rows = await withTenant(pool, principal.tenantId, async (client) => {
      const result = await client.query<CustomerRow>(`SELECT * FROM customers ORDER BY created_at DESC LIMIT 200`);
      return result.rows;
    });
    return reply.send({ data: rows });
  });

  app.get("/customers/:id", async (req, reply) => {
    const principal = req.principal!;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "id must be a UUID" });
    }

    const row = await withTenant(pool, principal.tenantId, async (client) => {
      const { rows } = await client.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });

    if (!row) {
      // RLS hides both "belongs to another tenant" and "does not exist" the
      // same way, by design -- see docs/isolation-design.md. 403, not 404,
      // rather than let either case leak which one it was.
      await logBlocked(pool, {
        actingTenantId: principal.tenantId,
        endpoint: "/customers/:id",
        method: "GET",
        detail: `requested customer id ${id} not visible to this tenant`,
        resolvedAction: "blocked_customer_not_visible",
      });
      return reply.code(403).send({ error: "not found for this tenant" });
    }
    return reply.send(row);
  });

  app.patch("/customers/:id", async (req, reply) => {
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
