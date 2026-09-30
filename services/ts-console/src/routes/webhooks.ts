import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import {
  attemptDelivery,
  emitWebhookEvent,
  WEBHOOK_EVENT_TYPES,
  type WebhookDeliveryRef,
  type WebhookEventType,
} from "../lib/webhooks.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEBHOOK_ROLES = ["Owner", "Billing Admin", "Developer"] as const;
const EVENT_TYPES = new Set<string>(WEBHOOK_EVENT_TYPES);

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
  subscribed_events: WebhookEventType[];
  active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  endpoint_id: string;
  endpoint_url: string;
  status: "pending" | "sent" | "exhausted";
  attempt_count: number;
  last_http_status: number | null;
  last_response_body: string | null;
  first_attempted_at: Date | string | null;
  next_retry_at: Date | string | null;
  created_at: Date | string;
}

interface AttemptRow {
  attempt_number: number;
  outcome: "sent" | "failed";
  http_status: number | null;
  response_body: string | null;
  attempted_at: Date | string;
}

const ENDPOINT_COLUMNS = "id, url, secret, subscribed_events, active, created_at, updated_at";
const DELIVERY_COLUMNS = `
  d.id, e.id AS event_id, e.event_type, ep.id AS endpoint_id, ep.url AS endpoint_url,
  d.status, d.attempt_count, d.last_http_status, d.last_response_body,
  d.first_attempted_at, d.next_retry_at, d.created_at`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readEvents(value: unknown): { error: string } | { value: WebhookEventType[] } {
  if (!Array.isArray(value)) return { error: "subscribed_events must be an array of supported event types" };
  const events: WebhookEventType[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !EVENT_TYPES.has(item)) {
      return { error: "subscribed_events contains an unsupported event type" };
    }
    if (!events.includes(item as WebhookEventType)) events.push(item as WebhookEventType);
  }
  return { value: events };
}

function shapeEndpoint(row: EndpointRow) {
  return {
    ...row,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function shapeDelivery(row: DeliveryRow) {
  return {
    ...row,
    first_attempted_at: row.first_attempted_at === null ? null : toIso(row.first_attempted_at),
    next_retry_at: row.next_retry_at === null ? null : toIso(row.next_retry_at),
    created_at: toIso(row.created_at),
  };
}

async function readDelivery(client: PoolClient, tenantId: string, id: string): Promise<DeliveryRow | null> {
  const { rows } = await client.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM webhook_deliveries d
     JOIN webhook_events e ON e.id = d.webhook_event_id AND e.tenant_id = d.tenant_id
     JOIN webhook_endpoints ep ON ep.id = d.webhook_endpoint_id AND ep.tenant_id = d.tenant_id
     WHERE d.id = $1 AND d.tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

async function readDeliveryDetail(client: PoolClient, tenantId: string, id: string) {
  const delivery = await readDelivery(client, tenantId, id);
  if (!delivery) return null;
  const { rows } = await client.query<AttemptRow>(
    `SELECT attempt_number, outcome, http_status, response_body, attempted_at
     FROM webhook_delivery_attempts
     WHERE tenant_id = $1 AND webhook_delivery_id = $2
     ORDER BY attempt_number`,
    [tenantId, id],
  );
  return {
    ...shapeDelivery(delivery),
    attempts: rows.map((row) => ({
      ...row,
      attempted_at: toIso(row.attempted_at),
    })),
  };
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  pool: Pool,
  adminSecret: string,
): void {
  // Internal service-to-service ingestion is deliberately outside the
  // console session/RBAC scope, matching the existing security admin route.
  app.post("/internal/webhook-events", async (req, reply) => {
    if (req.headers["x-internal-admin-key"] !== adminSecret) {
      return reply.code(401).send({ error: "missing or invalid admin key" });
    }
    const body = asRecord(req.body);
    if (typeof body.tenant_id !== "string" || !UUID_RE.test(body.tenant_id)) {
      return reply.code(400).send({ error: "tenant_id must be a UUID" });
    }
    if (typeof body.event_type !== "string" || !EVENT_TYPES.has(body.event_type)) {
      return reply.code(400).send({ error: "event_type is unsupported" });
    }
    if (typeof body.dedup_key !== "string" || !body.dedup_key.trim()) {
      return reply.code(400).send({ error: "dedup_key is required" });
    }
    if (body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return reply.code(400).send({ error: "payload must be an object" });
    }
    await emitWebhookEvent(
      pool,
      body.tenant_id,
      body.event_type as WebhookEventType,
      body.dedup_key,
      body.payload as Record<string, unknown>,
    );
    return reply.code(202).send({ accepted: true });
  });

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/webhook-endpoints", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const body = asRecord(req.body);
      if (!validUrl(body.url)) return reply.code(400).send({ error: "url must be an http(s) URL" });
      const parsedEvents = readEvents(body.subscribed_events ?? []);
      if ("error" in parsedEvents) return reply.code(400).send({ error: parsedEvents.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const secret = randomBytes(32).toString("hex");
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<EndpointRow>(
          `INSERT INTO webhook_endpoints (tenant_id, url, secret, subscribed_events)
           VALUES ($1, $2, $3, $4::text[])
           RETURNING ${ENDPOINT_COLUMNS}`,
          [tenantId, body.url, secret, parsedEvents.value],
        )).rows[0],
      );
      return reply.code(201).send(shapeEndpoint(row));
    });

    consoleRoute(scoped, "get", "/webhook-endpoints", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query<EndpointRow>(
          `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at, id`,
          [tenantId],
        )).rows,
      );
      return reply.send({ data: rows.map(shapeEndpoint) });
    });

    consoleRoute(scoped, "patch", "/webhook-endpoints/:id", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const body = asRecord(req.body);
      const updates: string[] = [];
      const values: unknown[] = [];
      if (body.url !== undefined) {
        if (!validUrl(body.url)) return reply.code(400).send({ error: "url must be an http(s) URL" });
        values.push(body.url);
        updates.push(`url = $${values.length}`);
      }
      if (body.subscribed_events !== undefined) {
        const parsed = readEvents(body.subscribed_events);
        if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
        values.push(parsed.value);
        updates.push(`subscribed_events = $${values.length}::text[]`);
      }
      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean" });
        values.push(body.active);
        updates.push(`active = $${values.length}`);
      }
      if (updates.length === 0) {
        return reply.code(400).send({ error: "provide at least one of url, subscribed_events, or active" });
      }
      const tenantId = req.consolePrincipal!.tenantId;
      values.push(id, tenantId);
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<EndpointRow>(
          `UPDATE webhook_endpoints SET ${updates.join(", ")}, updated_at = now()
           WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
           RETURNING ${ENDPOINT_COLUMNS}`,
          values,
        )).rows[0] ?? null,
      );
      if (!row) return reply.code(404).send({ error: "webhook endpoint not found" });
      return reply.send(shapeEndpoint(row));
    });

    consoleRoute(scoped, "delete", "/webhook-endpoints/:id", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const removed = await withTenant(pool, tenantId, async (client) =>
        (await client.query<{ id: string }>(
          `DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2 RETURNING id`,
          [id, tenantId],
        )).rows[0] ?? null,
      );
      if (!removed) return reply.code(404).send({ error: "webhook endpoint not found" });
      return reply.code(204).send();
    });

    consoleRoute(scoped, "get", "/webhook-deliveries", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const query = req.query as { event_type?: unknown; status?: unknown; cursor?: unknown; limit?: unknown };
      if (query.event_type !== undefined && (typeof query.event_type !== "string" || !EVENT_TYPES.has(query.event_type))) {
        return reply.code(400).send({ error: "event_type is unsupported" });
      }
      if (query.status !== undefined && !["pending", "sent", "exhausted"].includes(String(query.status))) {
        return reply.code(400).send({ error: "status must be pending, sent, or exhausted" });
      }
      if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
        return reply.code(400).send({ error: "cursor must be a delivery UUID" });
      }
      if (query.limit !== undefined && typeof query.limit !== "string") {
        return reply.code(400).send({ error: "limit must be an integer" });
      }
      const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        return reply.code(400).send({ error: "limit must be a positive integer" });
      }
      const limit = Math.min(requestedLimit, 500);
      const tenantId = req.consolePrincipal!.tenantId;
      const values: unknown[] = [tenantId];
      const filters: string[] = ["d.tenant_id = $1"];
      if (query.event_type) {
        values.push(query.event_type);
        filters.push(`e.event_type = $${values.length}`);
      }
      if (query.status) {
        values.push(query.status);
        filters.push(`d.status = $${values.length}`);
      }
      if (query.cursor) {
        values.push(query.cursor);
        filters.push(`d.id > $${values.length}`);
      }
      values.push(limit + 1);
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS}
           FROM webhook_deliveries d
           JOIN webhook_events e ON e.id = d.webhook_event_id AND e.tenant_id = d.tenant_id
           JOIN webhook_endpoints ep ON ep.id = d.webhook_endpoint_id AND ep.tenant_id = d.tenant_id
           WHERE ${filters.join(" AND ")}
           ORDER BY d.id
           LIMIT $${values.length}`,
          values,
        )).rows,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return reply.send({
        data: page.map(shapeDelivery),
        next_cursor: hasMore ? page[page.length - 1].id : null,
      });
    });

    consoleRoute(scoped, "get", "/webhook-deliveries/:id", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const detail = await withTenant(pool, tenantId, (client) => readDeliveryDetail(client, tenantId, id));
      if (!detail) return reply.code(404).send({ error: "webhook delivery not found" });
      return reply.send(detail);
    });

    consoleRoute(scoped, "post", "/webhook-deliveries/:id/resend", { role: [...WEBHOOK_ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, (client) => readDelivery(client, tenantId, id));
      if (!row) return reply.code(404).send({ error: "webhook delivery not found" });
      const ref: WebhookDeliveryRef = {
        id: row.id,
        tenantId,
        webhookEventId: row.event_id,
        webhookEndpointId: row.endpoint_id,
      };
      await attemptDelivery(pool, ref);
      const detail = await withTenant(pool, tenantId, (client) => readDeliveryDetail(client, tenantId, id));
      return reply.send(detail);
    });
  });
}
