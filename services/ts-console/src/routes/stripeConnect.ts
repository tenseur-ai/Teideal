import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import {
  READ_ONLY_NOTICE,
  StripeOAuthError,
  buildAuthorizeUrl,
  deauthorize,
  encryptToken,
  exchangeCode,
  verifyState,
  type StripeScope,
} from "../lib/stripeConnect.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ["Owner", "Billing Admin"] as const;

interface ConnectionRow {
  id: string;
  stripe_account_id: string;
  scope: string;
  status: string;
  connected_at: Date | string;
  disconnected_at?: Date | string | null;
}

function parseScope(value: unknown, fallback: StripeScope | null): StripeScope | { error: string } {
  if (value === undefined || value === null || value === "") {
    if (fallback) return fallback;
    return { error: "scope must be read_only or read_write" };
  }
  if (value === "read_only" || value === "read_write") return value;
  return { error: "scope must be read_only or read_write" };
}

function publicConnection(row: ConnectionRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    stripe_account_id: row.stripe_account_id,
    scope: row.scope,
    status: row.status,
    connected_at: new Date(row.connected_at).toISOString(),
  };
  if (row.disconnected_at) view.disconnected_at = new Date(row.disconnected_at).toISOString();
  return view;
}

function oauthFailure(err: unknown): { error: string } | null {
  if (err instanceof StripeOAuthError) return { error: err.message };
  return null;
}

export function registerStripeConnectRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "get", "/stripe/connect/authorize-url", { role: [...ROLES] }, async (req, reply) => {
      const query = (req.query ?? {}) as { scope?: unknown };
      const scope = parseScope(query.scope, "read_only");
      if (typeof scope !== "string") return reply.code(400).send({ error: scope.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const url = await buildAuthorizeUrl(tenantId, userId, scope);
      return reply.send({ url, notice: READ_ONLY_NOTICE });
    });

    consoleRoute(scoped, "post", "/stripe/connect/callback", { role: [...ROLES] }, async (req, reply) => {
      const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
      if (typeof body.code !== "string" || body.code.length === 0 || typeof body.state !== "string" || body.state.length === 0) {
        return reply.code(400).send({ error: "code and state are required" });
      }
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const state = await verifyState(body.state);
        if (state.tenantId !== tenantId || state.userId !== userId) {
          return reply.code(400).send({ error: "oauth state does not match the signed-in operator" });
        }
        const exchanged = await exchangeCode(body.code);
        // Stripe is the authority for the granted scope, but it must match
        // the scope this operator actually requested. A wider grant would be
        // the silent upgrade AC3 forbids.
        if (exchanged.scope !== state.scope) {
          throw new StripeOAuthError("stripe granted a different scope than the one requested");
        }
        const encrypted = encryptToken(exchanged.accessToken);
        const created = await withTenant(pool, tenantId, async (client) => {
          const row = (await client.query<ConnectionRow>(
            `INSERT INTO stripe_connections (
               tenant_id, stripe_account_id, access_token_ciphertext, access_token_iv, access_token_auth_tag,
               scope, status, connected_by_user_id
             ) VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7)
             RETURNING id, stripe_account_id, scope, status, connected_at`,
            [
              tenantId,
              exchanged.stripeAccountId,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.authTag,
              exchanged.scope,
              userId,
            ],
          )).rows[0];
          await recordConfigChangeWithClient(client, tenantId, { userId }, {
            objectType: "StripeConnection",
            objectId: row.id,
            before: null,
            after: { stripe_account_id: row.stripe_account_id, scope: row.scope, status: "connected" },
          });
          return row;
        });
        return reply.code(201).send(publicConnection(created));
      } catch (err) {
        const failure = oauthFailure(err);
        if (failure) return reply.code(400).send(failure);
        throw err;
      }
    });

    consoleRoute(scoped, "post", "/stripe/connections/:id/request-write-access", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      const existing = await withTenant(pool, tenantId, async (client) => {
        const row = (await client.query<{ id: string }>(
          `SELECT id FROM stripe_connections WHERE id = $1`,
          [id],
        )).rows[0];
        return row ?? null;
      });
      if (!existing) return reply.code(404).send({ error: "stripe connection not found" });
      const url = await buildAuthorizeUrl(tenantId, userId, "read_write");
      return reply.send({ url });
    });

    consoleRoute(scoped, "post", "/stripe/connections/:id/disconnect", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      const loaded = await withTenant(pool, tenantId, async (client) => {
        return (await client.query<{ id: string; stripe_account_id: string; status: string }>(
          `SELECT id, stripe_account_id, status FROM stripe_connections WHERE id = $1`,
          [id],
        )).rows[0] ?? null;
      });
      if (!loaded || loaded.status !== "connected") {
        return reply.code(404).send({ error: "stripe connection not found" });
      }
      try {
        await deauthorize(loaded.stripe_account_id);
      } catch (err) {
        const failure = oauthFailure(err);
        if (failure) return reply.code(400).send(failure);
        throw err;
      }
      // Status transition only. Token columns are left untouched.
      const updated = await withTenant(pool, tenantId, async (client) => {
        const row = (await client.query<ConnectionRow>(
          `UPDATE stripe_connections
           SET status = 'disconnected', disconnected_at = now()
           WHERE id = $1 AND status = 'connected'
           RETURNING id, stripe_account_id, scope, status, connected_at, disconnected_at`,
          [id],
        )).rows[0];
        if (!row) return null;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "StripeConnection",
          objectId: id,
          before: { status: "connected" },
          after: { status: "disconnected" },
        });
        return row;
      });
      if (!updated) return reply.code(404).send({ error: "stripe connection not found" });
      return reply.send(publicConnection(updated));
    });
  });
}
