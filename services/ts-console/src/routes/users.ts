import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { hashPassword } from "../lib/passwords.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES, type Role } from "../lib/users.js";

interface ManagedUserRow {
  id: string;
  email: string;
  role: Role;
  created_at: string;
}

const validRolesMessage = `role must be one of ${ROLES.join(", ")}`;

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.includes(value as Role);
}

export function registerUserRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/users", { role: ["Owner"] }, async (req, reply) => {
      const body = req.body as { email?: unknown; password?: unknown; role?: unknown };
      if (typeof body.email !== "string" || !body.email.trim()) {
        return reply.code(400).send({ error: "email is required" });
      }
      if (typeof body.password !== "string" || !body.password.trim()) {
        return reply.code(400).send({ error: "password is required" });
      }
      if (!isRole(body.role)) return reply.code(400).send({ error: validRolesMessage });

      const email = body.email.trim();
      const passwordHash = await hashPassword(body.password);
      const role = body.role;
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const created = await withTenant(pool, tenantId, async (client) => {
          const { rows } = await client.query<ManagedUserRow>(
            `INSERT INTO users (tenant_id, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, role, created_at`,
            [tenantId, email, passwordHash, role],
          );
          const row = rows[0];
          await recordConfigChangeWithClient(client, tenantId, { userId }, {
            objectType: "User",
            objectId: row.id,
            before: null,
            after: { email: row.email, role: row.role },
          });
          return row;
        });
        return reply.code(201).send(created);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: "a user with this email already exists" });
        }
        throw error;
      }
    });

    consoleRoute(scoped, "get", "/users", { role: ["Owner"] }, async (req, reply) => {
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query(
          `SELECT id, email, role, mfa_enrolled_at IS NOT NULL AS mfa_enrolled, created_at
           FROM users
           WHERE tenant_id = $1
           ORDER BY created_at`,
          [tenantId],
        )).rows,
      );
      return reply.send({ data: rows });
    });

    consoleRoute(scoped, "patch", "/users/:id/role", { role: ["Owner"] }, async (req, reply) => {
      const body = req.body as { role?: unknown };
      if (!isRole(body.role)) return reply.code(400).send({ error: validRolesMessage });
      const { id } = req.params as { id: string };
      const { tenantId, userId } = req.consolePrincipal!;
      const updated = await withTenant(pool, tenantId, async (client) => {
        const before = (await client.query<{ role: Role }>(
          `SELECT role FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [id, tenantId],
        )).rows[0];
        if (!before) return null;
        const row = (await client.query<ManagedUserRow>(
          `UPDATE users SET role = $3 WHERE id = $1 AND tenant_id = $2
           RETURNING id, email, role, created_at`,
          [id, tenantId, body.role],
        )).rows[0];
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "User",
          objectId: id,
          before: { role: before.role },
          after: { role: row.role },
        });
        return row;
      });
      if (!updated) return reply.code(403).send({ error: "user not found for this tenant" });
      return reply.send(updated);
    });

    consoleRoute(scoped, "delete", "/users/:id", { role: ["Owner"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId, userId } = req.consolePrincipal!;
      const deleted = await withTenant(pool, tenantId, async (client) => {
        const before = (await client.query<{ email: string; role: Role }>(
          `SELECT email, role FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [id, tenantId],
        )).rows[0];
        if (!before) return false;
        await client.query(`DELETE FROM users WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "User",
          objectId: id,
          before: { email: before.email, role: before.role },
          after: null,
        });
        return true;
      });
      if (!deleted) return reply.code(403).send({ error: "user not found for this tenant" });
      return reply.send({ id, status: "deleted" });
    });
  });
}
