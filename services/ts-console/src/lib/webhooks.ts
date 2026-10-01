import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "./db.js";

export const WEBHOOK_EVENT_TYPES = [
  "threshold.reached",
  "balance.depleted",
  "grant.expiring_soon",
  "grant.expired",
  "reservation.overrun",
  "reconciliation.mismatch",
  "customer.suspended",
  "period_close_sync.stalled",
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export const RETRY_DELAYS_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
] as const;

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookDeliveryRef {
  id: string;
  tenantId: string;
  webhookEventId: string;
  webhookEndpointId: string;
}

interface DeliverySource {
  id: string;
  attempt_count: number;
  first_attempted_at: Date | string | null;
  webhook_event_id: string;
  webhook_endpoint_id: string;
  event_id: string;
  event_type: WebhookEventType;
  raw_body: string;
  url: string;
  secret: string;
}

export function signBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expectedDigest = createHash("sha256").update(signBody(secret, rawBody)).digest();
  const suppliedDigest = createHash("sha256").update(signatureHeader).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function attemptDelivery(
  pool: Pool,
  delivery: WebhookDeliveryRef,
  attemptedAt = new Date(),
): Promise<void> {
  const source = await withTenant(pool, delivery.tenantId, async (client) => {
    const { rows } = await client.query<DeliverySource>(
      `SELECT d.id, d.attempt_count, d.first_attempted_at,
              d.webhook_event_id, d.webhook_endpoint_id,
              e.id AS event_id, e.event_type, e.raw_body,
              ep.url, ep.secret
       FROM webhook_deliveries d
       JOIN webhook_events e ON e.id = d.webhook_event_id AND e.tenant_id = d.tenant_id
       JOIN webhook_endpoints ep ON ep.id = d.webhook_endpoint_id AND ep.tenant_id = d.tenant_id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [delivery.id, delivery.tenantId],
    );
    return rows[0] ?? null;
  });
  if (!source) return;

  let httpStatus: number | null = null;
  let responseBody: string | null = null;
  let sent = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Teideal-Event-Id": source.event_id,
        "X-Teideal-Event-Type": source.event_type,
        "X-Teideal-Signature": signBody(source.secret, source.raw_body),
      },
      body: source.raw_body,
      signal: controller.signal,
    });
    httpStatus = response.status;
    responseBody = await response.text();
    sent = response.status >= 200 && response.status < 300;
  } catch (error) {
    responseBody = errorText(error);
  } finally {
    clearTimeout(timeout);
  }

  const attemptNumber = source.attempt_count + 1;
  const firstAttemptedAt = source.first_attempted_at === null
    ? attemptedAt
    : source.first_attempted_at instanceof Date
      ? source.first_attempted_at
      : new Date(source.first_attempted_at);
  let status: "pending" | "sent" | "exhausted";
  let nextRetryAt: Date | null = null;
  if (sent) {
    status = "sent";
  } else if (attemptNumber <= RETRY_DELAYS_MS.length) {
    status = "pending";
    nextRetryAt = new Date(firstAttemptedAt.getTime() + RETRY_DELAYS_MS[attemptNumber - 1]);
  } else {
    status = "exhausted";
  }

  await withTenant(pool, delivery.tenantId, async (client) => {
    await client.query(
      `INSERT INTO webhook_delivery_attempts (
         tenant_id, webhook_delivery_id, attempt_number, outcome,
         http_status, response_body, attempted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        delivery.tenantId,
        source.id,
        attemptNumber,
        sent ? "sent" : "failed",
        httpStatus,
        responseBody,
        attemptedAt,
      ],
    );
    await client.query(
      `UPDATE webhook_deliveries
       SET status = $1,
           attempt_count = $2,
           first_attempted_at = COALESCE(first_attempted_at, $3),
           next_retry_at = $4,
           last_http_status = $5,
           last_response_body = $6
       WHERE id = $7 AND tenant_id = $8`,
      [status, attemptNumber, attemptedAt, nextRetryAt, httpStatus, responseBody, source.id, delivery.tenantId],
    );
  });
}

// Cheap, single per-tenant check so a hot bulk-evaluation loop (e.g.
// balanceAlertWorker's threshold sweep) can skip emitWebhookEvent entirely,
// candidate by candidate, for the common case of a tenant with no webhook
// endpoints configured at all -- see the TEID-47-T5 regression this fixed
// (a 10,000-candidate tick timed out once this story wired a sequential,
// per-candidate emitWebhookEvent call into that loop unconditionally; every
// call still paid for a dedup INSERT plus an endpoints lookup even though
// zero endpoints existed, purely wasted work at that scale).
export async function tenantHasActiveWebhookEndpoints(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1 AND active = true) AS exists`,
      [tenantId],
    );
    return rows[0]?.exists ?? false;
  });
}

export async function emitWebhookEvent(
  pool: Pool,
  tenantId: string,
  eventType: WebhookEventType,
  dedupKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const rawBody = JSON.stringify(payload);
  const deliveries = await withTenant(pool, tenantId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (tenant_id, event_type, dedup_key, payload, raw_body)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [tenantId, eventType, dedupKey, rawBody, rawBody],
    );
    const event = inserted.rows[0];
    if (!event) return [];

    const endpoints = await client.query<{ id: string }>(
      `SELECT id
       FROM webhook_endpoints
       WHERE tenant_id = $1 AND active = true
         AND (subscribed_events = '{}'::text[] OR $2 = ANY(subscribed_events))
       ORDER BY id`,
      [tenantId, eventType],
    );
    const refs: WebhookDeliveryRef[] = [];
    for (const endpoint of endpoints.rows) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO webhook_deliveries (tenant_id, webhook_event_id, webhook_endpoint_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (webhook_event_id, webhook_endpoint_id) DO NOTHING
         RETURNING id`,
        [tenantId, event.id, endpoint.id],
      );
      if (created.rows[0]) {
        refs.push({
          id: created.rows[0].id,
          tenantId,
          webhookEventId: event.id,
          webhookEndpointId: endpoint.id,
        });
      }
    }
    return refs;
  });

  for (const delivery of deliveries) await attemptDelivery(pool, delivery);
}
