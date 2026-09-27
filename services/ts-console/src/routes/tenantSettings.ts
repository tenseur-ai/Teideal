import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { requireSession } from "../lib/sessionAuth.js";
import { recordConfigChangeWithClient } from "../lib/audit.js";

interface TenantSettingsRow {
  require_mfa_all_roles: boolean;
  idle_timeout_minutes: number;
}

// TEID-91-AC2/AC3: only an Owner can turn on mandatory MFA for everyone or
// shorten the idle timeout. Full role-based access control is TEID-43;
// this is the one check TEID-91 itself needs.
export function registerTenantSettingsRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    scoped.patch("/tenant-settings", async (req, reply) => {
      const { tenantId, userId, role } = req.consolePrincipal!;
      if (role !== "Owner") {
        return reply.code(403).send({ error: "only an Owner can change tenant settings" });
      }
      const body = req.body as { require_mfa_all_roles?: unknown; idle_timeout_minutes?: unknown };
      if (body.require_mfa_all_roles !== undefined && typeof body.require_mfa_all_roles !== "boolean") {
        return reply.code(400).send({ error: "require_mfa_all_roles must be a boolean" });
      }
      if (body.idle_timeout_minutes !== undefined && (typeof body.idle_timeout_minutes !== "number" || body.idle_timeout_minutes <= 0)) {
        return reply.code(400).send({ error: "idle_timeout_minutes must be a positive number" });
      }

      const row = await withTenant(pool, tenantId, async (client) => {
        const beforeResult = await client.query<TenantSettingsRow>(
          `SELECT require_mfa_all_roles, idle_timeout_minutes
           FROM tenant_settings
           WHERE tenant_id = $1
           FOR UPDATE`,
          [tenantId],
        );
        const before = beforeResult.rows[0];
        const { rows } = await client.query<TenantSettingsRow>(
          `UPDATE tenant_settings
           SET require_mfa_all_roles = COALESCE($2, require_mfa_all_roles),
               idle_timeout_minutes = COALESCE($3, idle_timeout_minutes),
               updated_at = now()
           WHERE tenant_id = $1
           RETURNING require_mfa_all_roles, idle_timeout_minutes`,
          [tenantId, body.require_mfa_all_roles ?? null, body.idle_timeout_minutes ?? null],
        );
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "TenantSettings",
          objectId: tenantId,
          before,
          after: rows[0],
        });
        return rows[0];
      });
      return reply.send(row);
    });
  });
}
