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
