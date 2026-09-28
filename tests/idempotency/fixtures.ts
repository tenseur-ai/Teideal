import { superPool } from "./db.js";
import type { TenantFixture } from "./env.js";

export interface BackdatedUsageEvent {
  id: string;
  fixedNow: Date;
}

export async function seedBackdatedUsageEvent(
  tenant: TenantFixture,
  idempotencyKey: string,
  eventType: string,
  quantity: string,
  ageDays: number,
): Promise<BackdatedUsageEvent> {
  const nowResult = await superPool.query<{ fixed_now: Date }>("SELECT clock_timestamp() AS fixed_now");
  const fixedNow = nowResult.rows[0].fixed_now;
  const result = await superPool.query<{ id: string }>(
    `INSERT INTO usage_events (
       tenant_id, customer_id, event_type, quantity, idempotency_key,
       occurred_at, created_at
     ) VALUES ($1, $2, $3, $4::numeric, $5, $6::timestamptz, $6::timestamptz - ($7::int * interval '1 day'))
     RETURNING id`,
    [tenant.id, tenant.customerId, eventType, quantity, idempotencyKey, fixedNow, ageDays],
  );
  return { id: result.rows[0].id, fixedNow };
}

export async function setUsageEventAge(id: string, fixedNow: Date, ageDays: number): Promise<void> {
  await superPool.query(
    `UPDATE usage_events
     SET created_at = $2::timestamptz - ($3::int * interval '1 day')
     WHERE id = $1`,
    [id, fixedNow, ageDays],
  );
}

export async function usageRowsForKey(tenantID: string, idempotencyKey: string): Promise<Array<{ id: string }>> {
  const result = await superPool.query<{ id: string }>(
    `SELECT id FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantID, idempotencyKey],
  );
  return result.rows;
}
