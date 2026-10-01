import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { CsvInvoiceImportError, parseAndImportInvoiceCsv } from "../lib/connectors/csvInvoiceImporter.js";
import { StripeBillingConnector, STRIPE_BILLING_ENTITY_TYPES } from "../lib/connectors/stripeBillingConnector.js";
import {
  connectorBackfillTimeBudgetMs,
  runConnectorSync,
  type RunConnectorSyncResult,
  type SyncConnectorRow,
} from "../lib/connectors/syncWorker.js";
import { getSyncHealth, humanizeConnectorError } from "../lib/connectors/syncHealth.js";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const CONNECTOR_ROLES = ["Owner", "Billing Admin", "Developer"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StripeConnectionRow {
  id: string;
  scope: string;
  status: string;
}

async function loadConnector(pool: Pool, tenantId: string, id: string): Promise<SyncConnectorRow | null> {
  return withTenant(pool, tenantId, async (client) => (await client.query<SyncConnectorRow>(
    `SELECT id, tenant_id, connector_type, display_name, status, stripe_connection_id,
            backfill_completed_at, cursor_high_water
     FROM connectors WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )).rows[0] ?? null);
}

export function registerConnectorRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "get", "/connectors/sync-health", { role: [...CONNECTOR_ROLES] }, async (req, reply) => {
      const data = await getSyncHealth(pool, req.consolePrincipal!.tenantId);
      return reply.send({ data });
    });

    consoleRoute(scoped, "post", "/connectors/stripe/register", { role: [...CONNECTOR_ROLES] }, async (req, reply) => {
      const body = (req.body ?? {}) as { stripe_connection_id?: unknown; display_name?: unknown };
      if (typeof body.stripe_connection_id !== "string" || !UUID_RE.test(body.stripe_connection_id)) {
        return reply.code(400).send({ error: "stripe_connection_id must be a UUID" });
      }
      if (typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
        return reply.code(400).send({ error: "display_name is required" });
      }
      const stripeConnectionId = body.stripe_connection_id;
      const displayName = body.display_name.trim();
      const tenantId = req.consolePrincipal!.tenantId;
      type RegisterResult =
        | { error: string; statusCode: number }
        | { connector: { id: string; status: string } };
      const result = await withTenant<RegisterResult>(pool, tenantId, async (client) => {
        const connection = (await client.query<StripeConnectionRow>(
          `SELECT id, scope, status
           FROM stripe_connections WHERE id = $1 AND tenant_id = $2`,
          [stripeConnectionId, tenantId],
        )).rows[0];
        if (!connection) return { error: "Stripe connection not found", statusCode: 404 };
        if (connection.status !== "connected") {
          return { error: "Stripe connection must be connected", statusCode: 400 };
        }
        if (connection.scope !== "read_only") {
          return { error: "Stripe connection must be read-only", statusCode: 403 };
        }
        const connector = (await client.query<{ id: string; status: string }>(
          `INSERT INTO connectors (tenant_id, connector_type, display_name, stripe_connection_id)
           VALUES ($1, 'stripe', $2, $3)
           RETURNING id, status`,
          [tenantId, displayName, connection.id],
        )).rows[0];
        return { connector };
      });
      if ("error" in result) return reply.code(result.statusCode).send({ error: result.error });
      return reply.code(201).send(result.connector);
    });

    consoleRoute(scoped, "post", "/connectors/csv-import/invoices", { role: [...CONNECTOR_ROLES] }, async (req, reply) => {
      if (!req.isMultipart()) return reply.code(400).send({ error: "a multipart CSV file is required" });
      const upload = await req.file();
      if (!upload) return reply.code(400).send({ error: "a multipart CSV file is required" });
      const csvText = (await upload.toBuffer()).toString("utf8");
      const tenantId = req.consolePrincipal!.tenantId;
      const connectorId = await withTenant(pool, tenantId, async (client) => (await client.query<{ id: string }>(
        `INSERT INTO connectors (tenant_id, connector_type, display_name, backfill_completed_at)
         VALUES ($1, 'csv_import', 'CSV invoice imports', now())
         ON CONFLICT (tenant_id, connector_type, display_name)
         DO UPDATE SET status = 'connected',
                       backfill_completed_at = COALESCE(connectors.backfill_completed_at, now()),
                       updated_at = now()
         RETURNING id`,
        [tenantId],
      )).rows[0].id);
      try {
        const summary = await parseAndImportInvoiceCsv(pool, tenantId, connectorId, csvText);
        return reply.code(202).send(summary);
      } catch (error) {
        if (error instanceof CsvInvoiceImportError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    });

    consoleRoute(scoped, "post", "/connectors/:id/sync", { role: [...CONNECTOR_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const connector = await loadConnector(pool, tenantId, id);
      if (!connector || connector.status !== "connected") return reply.code(404).send({ error: "connector not found" });
      if (connector.connector_type !== "stripe" || !connector.stripe_connection_id) {
        return reply.code(400).send({ error: "this connector does not support remote synchronization" });
      }
      let result: RunConnectorSyncResult;
      try {
        result = await runConnectorSync(
          pool,
          tenantId,
          connector,
          new StripeBillingConnector(pool, tenantId, connector.stripe_connection_id),
          { entityTypes: STRIPE_BILLING_ENTITY_TYPES, timeBudgetMs: connectorBackfillTimeBudgetMs() },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: humanizeConnectorError(message) });
      }
      if (result.completed && connector.backfill_completed_at === null) {
        await withTenant(pool, tenantId, async (client) => {
          await client.query(
            `UPDATE connectors SET backfill_completed_at = now(), updated_at = now()
             WHERE id = $1 AND tenant_id = $2 AND backfill_completed_at IS NULL`,
            [id, tenantId],
          );
        });
      }
      return reply.send(result);
    });

    consoleRoute(scoped, "delete", "/connectors/:id", { role: [...CONNECTOR_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const connector = await loadConnector(pool, tenantId, id);
      if (!connector || connector.status !== "connected") return reply.code(404).send({ error: "connector not found" });
      await withTenant(pool, tenantId, async (client) => {
        await client.query(
          `UPDATE connectors SET status = 'disconnected', updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
      });
      return reply.send({ id, status: "disconnected" });
    });
  });
}
