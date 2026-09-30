import type { Pool } from "pg";
import { withTenant } from "./db.js";
import { attemptDelivery, type WebhookDeliveryRef } from "./webhooks.js";

export function webhookDeliveryIntervalMs(): number {
  const raw = process.env.WEBHOOK_DELIVERY_INTERVAL_MS;
  if (raw === undefined || raw === "") return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`invalid WEBHOOK_DELIVERY_INTERVAL_MS ${JSON.stringify(raw)}; using 30000`);
    return 30_000;
  }
  return parsed;
}

export async function evaluateWebhookRetries(pool: Pool, now = new Date()): Promise<number> {
  const tenantRows = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
  let attempted = 0;
  for (const tenant of tenantRows.rows) {
    const rows = await withTenant(pool, tenant.id, async (client) =>
      (await client.query<{
        id: string;
        webhook_event_id: string;
        webhook_endpoint_id: string;
      }>(
        `SELECT id, webhook_event_id, webhook_endpoint_id
         FROM webhook_deliveries
         WHERE tenant_id = $1 AND status = 'pending'
           AND attempt_count > 0 AND next_retry_at <= $2
         ORDER BY next_retry_at, id`,
        [tenant.id, now],
      )).rows,
    );
    for (const row of rows) {
      const delivery: WebhookDeliveryRef = {
        id: row.id,
        tenantId: tenant.id,
        webhookEventId: row.webhook_event_id,
        webhookEndpointId: row.webhook_endpoint_id,
      };
      await attemptDelivery(pool, delivery, now);
      attempted += 1;
    }
  }
  return attempted;
}
