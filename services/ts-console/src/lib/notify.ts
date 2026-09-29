import type { Pool } from "pg";
import { withTenant } from "./db.js";

// Placeholder email "sender" -- mirrors how the Stripe connector is meant
// to be pluggable per docs/adr/0001: a real provider (SES, Postmark, ...)
// slots in here later without changing callers. For now, "sending" means
// recording the notification as a real, tenant-scoped, queryable fact
// (TEID-91-T4 asserts against this row rather than an inbox).
export async function sendEmail(pool: Pool, tenantId: string, toEmail: string, subject: string, body: string): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO notifications_sent (tenant_id, to_email, subject, body) VALUES ($1, $2, $3, $4)`,
      [tenantId, toEmail, subject, body],
    );
  });
}

// Slack incoming webhook. Mirrors go-usage postAlert: config-provided URL,
// JSON POST, 10s timeout, any non-2xx is a failure. The URL is an argument
// because each tenant stores its own webhook on billing_alert_thresholds;
// this service does not import the Go helper.
const SLACK_TIMEOUT_MS = 10_000;

export async function sendSlackAlert(webhookUrl: string, payload: { text: string }): Promise<void> {
  if (webhookUrl === "") {
    throw new Error("slack webhook URL is not configured");
  }
  const body = JSON.stringify(payload);
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  if (response.status < 200 || response.status >= 300) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`webhook returned HTTP ${response.status}`);
  }
  await response.arrayBuffer().catch(() => undefined);
}
