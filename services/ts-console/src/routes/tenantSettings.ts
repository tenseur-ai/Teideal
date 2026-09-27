import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { requireSession } from "../lib/sessionAuth.js";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { consoleRoute } from "../lib/roleGuard.js";

interface TenantSettingsRow {
  require_mfa_all_roles: boolean;
  idle_timeout_minutes: number;
  sso_enabled: boolean;
}

// Tenant-wide MFA, idle timeout, and SSO are configuration changes reserved
// for the account Owner by TEID-43's shared console route guard.
export function registerTenantSettingsRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "patch", "/tenant-settings", { role: ["Owner"] }, async (req, reply) => {
      const { tenantId, userId } = req.consolePrincipal!;
      const body = req.body as { require_mfa_all_roles?: unknown; idle_timeout_minutes?: unknown; sso_enabled?: unknown };
      if (body.require_mfa_all_roles !== undefined && typeof body.require_mfa_all_roles !== "boolean") {
        return reply.code(400).send({ error: "require_mfa_all_roles must be a boolean" });
      }
      if (body.idle_timeout_minutes !== undefined && (typeof body.idle_timeout_minutes !== "number" || body.idle_timeout_minutes <= 0)) {
        return reply.code(400).send({ error: "idle_timeout_minutes must be a positive number" });
      }
      if (body.sso_enabled !== undefined && typeof body.sso_enabled !== "boolean") {
        return reply.code(400).send({ error: "sso_enabled must be a boolean" });
      }

      const row = await withTenant(pool, tenantId, async (client) => {
        const beforeResult = await client.query<TenantSettingsRow>(
          `SELECT require_mfa_all_roles, idle_timeout_minutes, sso_enabled
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
               sso_enabled = COALESCE($4, sso_enabled),
               updated_at = now()
           WHERE tenant_id = $1
           RETURNING require_mfa_all_roles, idle_timeout_minutes, sso_enabled`,
          [tenantId, body.require_mfa_all_roles ?? null, body.idle_timeout_minutes ?? null, body.sso_enabled ?? null],
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
