import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { customerVisible } from "../lib/grants.js";
import { requireSession } from "../lib/sessionAuth.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = new Set(["ingest-only", "read-only", "admin"]);
const ENVIRONMENTS = new Set(["sandbox", "production"]);

type KeyEnvironment = "sandbox" | "production";

interface KeyRow {
  id: string;
  display_hint: string;
  scope: string;
  environment: KeyEnvironment;
  label: string;
  creator_user_id: string | null;
  created_at: string;
  last_used_at: string | null;
  status: "active" | "expired" | "revoked";
}

interface StoredKeyRow extends KeyRow {
  expires_at: string | null;
  revoked_at: string | null;
  customer_id: string | null;
}

interface GeneratedKey {
  plaintext: string;
  hash: string;
  displayHint: string;
}

const KEY_VIEW = `
  id, display_hint, scope, environment, label, creator_user_id, created_at, last_used_at,
  CASE
    WHEN revoked_at IS NOT NULL THEN 'revoked'
    WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
    ELSE 'active'
  END AS status`;

function generateKey(environment: KeyEnvironment): GeneratedKey {
  const token = randomBytes(32).toString("base64url");
  const prefix = environment === "production" ? "sk_live_" : "sk_test_";
  const plaintext = `${prefix}${token}`;
  return {
    plaintext,
    hash: createHash("sha256").update(plaintext).digest("hex"),
    displayHint: `${prefix}****${plaintext.slice(-4)}`,
  };
}

export async function insertKey(
  client: PoolClient,
  tenantId: string,
  creatorUserId: string,
  scope: string,
  environment: KeyEnvironment,
  label: string,
  customerId: string | null = null,
): Promise<{ row: KeyRow; plaintext: string }> {
  const generated = generateKey(environment);
  const { rows } = await client.query<KeyRow>(
    `INSERT INTO api_keys
       (issued_to_tenant_id, key_hash, label, scope, environment, display_hint, creator_user_id, customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${KEY_VIEW}`,
    [tenantId, generated.hash, label, scope, environment, generated.displayHint, creatorUserId, customerId],
  );
  return { row: rows[0], plaintext: generated.plaintext };
}

function creationResponse(row: KeyRow, plaintext: string, customerId: string | null) {
  return {
    id: row.id,
    key: plaintext,
    scope: row.scope,
    environment: row.environment,
    label: row.label,
    display_hint: row.display_hint,
    customer_id: customerId,
  };
}

export function registerApiKeyRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/api-keys", { role: ["Owner", "Developer"] }, async (req, reply) => {
      const body = req.body as { scope?: unknown; environment?: unknown; label?: unknown };
      if (typeof body.scope !== "string" || !SCOPES.has(body.scope)) {
        return reply.code(400).send({ error: "scope must be ingest-only, read-only, or admin" });
      }
      if (typeof body.environment !== "string" || !ENVIRONMENTS.has(body.environment)) {
        return reply.code(400).send({ error: "environment must be sandbox or production" });
      }
      if (typeof body.label !== "string" || !body.label.trim()) {
        return reply.code(400).send({ error: "label is required" });
      }
      const scope = body.scope;
      const environment = body.environment as KeyEnvironment;
      const label = body.label.trim();
      const rawCustomerId = (body as { customer_id?: unknown }).customer_id;
      if (rawCustomerId !== undefined && rawCustomerId !== null && (typeof rawCustomerId !== "string" || !UUID_RE.test(rawCustomerId))) {
        return reply.code(400).send({ error: "customer_id must be a UUID" });
      }
      const customerId = typeof rawCustomerId === "string" ? rawCustomerId : null;

      const { tenantId, userId } = req.consolePrincipal!;
      const created = await withTenant(pool, tenantId, async (client) => {
        if (customerId && !(await customerVisible(client, customerId))) return null;
        const result = await insertKey(client, tenantId, userId, scope, environment, label, customerId);
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "ApiKey",
          objectId: result.row.id,
          before: null,
          after: {
            scope: result.row.scope,
            environment: result.row.environment,
            label: result.row.label,
            display_hint: result.row.display_hint,
            ...(customerId ? { customer_id: customerId } : {}),
          },
        });
        return result;
      });
      if (!created) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/api-keys",
          method: "POST",
          detail: "customer_id not visible to caller's tenant",
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "customer not found for this tenant" });
      }
      return reply.code(201).send(creationResponse(created.row, created.plaintext, customerId));
    });

    consoleRoute(scoped, "get", "/api-keys", { role: [...ROLES] }, async (req, reply) => {
      const query = req.query as { limit?: unknown; cursor?: unknown };
      if (query.limit !== undefined && typeof query.limit !== "string") {
        return reply.code(400).send({ error: "limit must be an integer" });
      }
      const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        return reply.code(400).send({ error: "limit must be a positive integer" });
      }
      const limit = Math.min(requestedLimit, 200);
      if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
        return reply.code(400).send({ error: "cursor must be a valid key id" });
      }

      const tenantId = req.consolePrincipal!.tenantId;
      const values: unknown[] = [tenantId];
      let cursorClause = "";
      if (query.cursor) {
        values.push(query.cursor);
        cursorClause = `AND id > $2`;
      }
      values.push(limit + 1);
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query<KeyRow>(
          `SELECT ${KEY_VIEW}
           FROM api_keys
           WHERE issued_to_tenant_id = $1 ${cursorClause}
           ORDER BY id
           LIMIT $${values.length}`,
          values,
        )).rows,
      );
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });

    consoleRoute(scoped, "get", "/api-keys/:id", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<KeyRow>(
          `SELECT ${KEY_VIEW} FROM api_keys WHERE id = $1 AND issued_to_tenant_id = $2`,
          [id, tenantId],
        )).rows[0] ?? null,
      );
      if (!row) return reply.code(404).send({ error: "api key not found" });
      return reply.send(row);
    });

    consoleRoute(scoped, "post", "/api-keys/:id/rotate", { role: ["Owner", "Developer"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = (req.body ?? {}) as { grace_period_hours?: unknown };
      const graceHours = body.grace_period_hours ?? 24;
      if (typeof graceHours !== "number" || !Number.isFinite(graceHours) || graceHours <= 0) {
        return reply.code(400).send({ error: "grace_period_hours must be a positive number" });
      }

      const { tenantId, userId } = req.consolePrincipal!;
      const rotated = await withTenant(pool, tenantId, async (client) => {
        const old = (await client.query<StoredKeyRow>(
          `SELECT ${KEY_VIEW}, expires_at, revoked_at, customer_id
           FROM api_keys
           WHERE id = $1 AND issued_to_tenant_id = $2
             AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
           FOR UPDATE`,
          [id, tenantId],
        )).rows[0];
        if (!old) return null;

        const created = await insertKey(client, tenantId, userId, old.scope, old.environment, old.label, old.customer_id);
        const expiresAt = (await client.query<{ expires_at: string }>(
          `UPDATE api_keys
           SET expires_at = now() + ($3 * interval '1 hour')
           WHERE id = $1 AND issued_to_tenant_id = $2
           RETURNING expires_at`,
          [id, tenantId, graceHours],
        )).rows[0].expires_at;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "ApiKey",
          objectId: id,
          before: { status: "active" },
          after: { status: "expiring", expires_at: expiresAt, rotated_to_id: created.row.id },
        });
        return { ...created, customerId: old.customer_id };
      });
      if (!rotated) return reply.code(403).send({ error: "api key not found for this tenant" });
      return reply.code(201).send(creationResponse(rotated.row, rotated.plaintext, rotated.customerId));
    });

    consoleRoute(scoped, "post", "/api-keys/:id/revoke", { role: ["Owner", "Developer"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      const revoked = await withTenant(pool, tenantId, async (client) => {
        const row = (await client.query<{ id: string }>(
          `UPDATE api_keys SET revoked_at = now()
           WHERE id = $1 AND issued_to_tenant_id = $2
           RETURNING id`,
          [id, tenantId],
        )).rows[0];
        if (!row) return false;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "ApiKey",
          objectId: id,
          before: { status: "active" },
          after: { status: "revoked" },
        });
        return true;
      });
      if (!revoked) return reply.code(403).send({ error: "api key not found for this tenant" });
      return reply.send({ id, status: "revoked" });
    });
  });
}
