import type { PoolClient } from "pg";
import { recordConfigChangeWithClient } from "./audit.js";
import type { ConsumptionSource } from "./consumptionOrder.js";
import {
  insertPlanRates,
  readPlan,
  type BillingInterval,
  type PlanRate,
  type PlanRecord,
} from "./plans.js";

export interface PlanVersionOverrides {
  name?: string;
  currency?: string;
  billing_interval?: BillingInterval;
  included_credits?: number;
  hard_cap?: number | null;
  soft_cap?: number | null;
  consumption_order?: ConsumptionSource[] | null;
}

export interface SubscriptionRecord {
  id: string;
  customer_id: string;
  plan_family_id: string;
  current_plan_id: string;
  grandfathered: boolean;
  scheduled_plan_id: string | null;
  scheduled_migration_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface MigrationPreview {
  total: number;
  by_date: Array<{ date: string; count: number }>;
}

export type PublishNewVersionResult =
  | { status: "ok"; plan: PlanRecord }
  | { status: "not_found" }
  | { status: "unpublished" };

export type SubscriptionWriteResult =
  | { status: "ok"; subscription: SubscriptionRecord }
  | { status: "not_found" }
  | { status: "plan_not_found" };

interface SubscriptionRow {
  id: string;
  customer_id: string;
  plan_family_id: string;
  current_plan_id: string;
  grandfathered: boolean;
  scheduled_plan_id: string | null;
  scheduled_migration_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LockedPlanRow {
  id: string;
  version: number | null;
}

const SUBSCRIPTION_RETURNING = `
  id, customer_id, plan_family_id, current_plan_id, grandfathered,
  scheduled_plan_id, scheduled_migration_date, created_at, updated_at`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function shapeSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    customer_id: row.customer_id,
    plan_family_id: row.plan_family_id,
    current_plan_id: row.current_plan_id,
    grandfathered: row.grandfathered,
    scheduled_plan_id: row.scheduled_plan_id,
    scheduled_migration_date: row.scheduled_migration_date === null ? null : toIso(row.scheduled_migration_date),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function isFamilyVersionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pg = error as { code?: string; constraint?: string };
  return pg.code === "23505" && pg.constraint === "plans_family_version_uniq";
}

function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of formatted) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Local midnight as a UTC instant. Two passes correct the offset when the
// first guess lands on the other side of a DST transition.
function localMidnightUtc(timeZone: string, year: number, month: number, day: number): Date {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let utc = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = zonedParts(new Date(utc), timeZone);
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = desired - observed;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

// Next monthly anchor strictly after `now`. An instant that lands exactly on
// this month's anchor schedules the following month. The anchor day is
// clamped to the month's length (31 in February becomes the last day).
export function nextPeriodBoundary(timezone: string, anchorDay: number, now: Date): Date {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error("billing anchor day must be between 1 and 31");
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error("billing_timezone is not a valid IANA time zone");
  }
  const local = zonedParts(now, timezone);
  const thisDay = Math.min(anchorDay, daysInMonth(local.year, local.month));
  const thisBoundary = localMidnightUtc(timezone, local.year, local.month, thisDay);
  if (now.getTime() < thisBoundary.getTime()) return thisBoundary;
  const nextMonth = local.month === 12 ? 1 : local.month + 1;
  const nextYear = local.month === 12 ? local.year + 1 : local.year;
  const nextDay = Math.min(anchorDay, daysInMonth(nextYear, nextMonth));
  return localMidnightUtc(timezone, nextYear, nextMonth, nextDay);
}

async function insertNextVersion(
  client: PoolClient,
  tenantId: string,
  planFamilyId: string,
  userId: string,
  rates: PlanRate[],
  overrides: PlanVersionOverrides,
): Promise<PublishNewVersionResult> {
  // Lock every row in the family. SELECT MAX(...) FOR UPDATE is rejected by
  // Postgres, so the max is computed from the locked rows.
  const locked = (await client.query<LockedPlanRow>(
    `SELECT id, version
     FROM plans
     WHERE plan_family_id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [planFamilyId, tenantId],
  )).rows;
  if (locked.length === 0) return { status: "not_found" };

  let maxVersion = -1;
  let latestId: string | null = null;
  for (const row of locked) {
    if (row.version !== null && row.version > maxVersion) {
      maxVersion = row.version;
      latestId = row.id;
    }
  }
  if (latestId === null || maxVersion < 1) return { status: "unpublished" };

  const inserted = (await client.query<{ id: string }>(
    `INSERT INTO plans (
       tenant_id, name, currency, billing_interval, included_credits, hard_cap, soft_cap,
       consumption_order, status, version, created_by_user_id, published_by_user_id,
       published_at, plan_family_id
     )
     SELECT
       tenant_id,
       COALESCE($3::text, name),
       COALESCE($4::text, currency),
       COALESCE($5::text, billing_interval),
       COALESCE($6::numeric, included_credits),
       CASE WHEN $7::boolean THEN $8::numeric ELSE hard_cap END,
       CASE WHEN $9::boolean THEN $10::numeric ELSE soft_cap END,
       CASE WHEN $11::boolean THEN $12::text[] ELSE consumption_order END,
       'published',
       $13::int,
       $14::uuid,
       $14::uuid,
       now(),
       plan_family_id
     FROM plans
     WHERE id = $1 AND tenant_id = $2
     RETURNING id`,
    [
      latestId,
      tenantId,
      overrides.name ?? null,
      overrides.currency ?? null,
      overrides.billing_interval ?? null,
      overrides.included_credits ?? null,
      Object.prototype.hasOwnProperty.call(overrides, "hard_cap") && overrides.hard_cap !== undefined,
      overrides.hard_cap ?? null,
      Object.prototype.hasOwnProperty.call(overrides, "soft_cap") && overrides.soft_cap !== undefined,
      overrides.soft_cap ?? null,
      Object.prototype.hasOwnProperty.call(overrides, "consumption_order") && overrides.consumption_order !== undefined,
      overrides.consumption_order ?? null,
      maxVersion + 1,
      userId,
    ],
  )).rows[0];

  await insertPlanRates(client, tenantId, inserted.id, rates);
  const plan = await readPlan(client, tenantId, inserted.id);
  if (!plan) throw new Error("published plan version was not readable");
  await recordConfigChangeWithClient(client, tenantId, { userId }, {
    objectType: "Plan",
    objectId: inserted.id,
    before: null,
    after: plan,
  });
  return { status: "ok", plan };
}

export async function publishNewVersion(
  client: PoolClient,
  tenantId: string,
  planFamilyId: string,
  userId: string,
  rates: PlanRate[],
  overrides: PlanVersionOverrides = {},
): Promise<PublishNewVersionResult> {
  const attempt = () => insertNextVersion(client, tenantId, planFamilyId, userId, rates, overrides);
  // A unique-index loser aborts only back to this savepoint, then recomputes
  // max(version) against the winner's committed row. One retry.
  await client.query("SAVEPOINT plan_version_publish");
  try {
    return await attempt();
  } catch (error) {
    if (!isFamilyVersionConflict(error)) throw error;
    await client.query("ROLLBACK TO SAVEPOINT plan_version_publish");
    await client.query("SAVEPOINT plan_version_publish");
    return await attempt();
  }
}

export async function resolveEffectivePlanId(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  asOf: Date,
): Promise<string | null> {
  const row = (await client.query<{ plan_id: string | null }>(
    `SELECT CASE
       WHEN scheduled_migration_date IS NOT NULL
            AND $3::timestamptz >= scheduled_migration_date
       THEN scheduled_plan_id
       ELSE current_plan_id
     END AS plan_id
     FROM customer_plan_subscriptions
     WHERE tenant_id = $1 AND customer_id = $2`,
    [tenantId, customerId, asOf],
  )).rows[0];
  return row?.plan_id ?? null;
}

export async function assignSubscription(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  planId: string,
): Promise<SubscriptionWriteResult> {
  const plan = (await client.query<{ plan_family_id: string }>(
    `SELECT plan_family_id FROM plans WHERE id = $1 AND tenant_id = $2`,
    [planId, tenantId],
  )).rows[0];
  if (!plan) return { status: "plan_not_found" };

  // Replacement matches a fresh row: grandfathering and a pending migration
  // belong to the previous assignment and do not carry over.
  const row = (await client.query<SubscriptionRow>(
    `INSERT INTO customer_plan_subscriptions (
       tenant_id, customer_id, plan_family_id, current_plan_id
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (customer_id) DO UPDATE SET
       plan_family_id = EXCLUDED.plan_family_id,
       current_plan_id = EXCLUDED.current_plan_id,
       grandfathered = false,
       scheduled_plan_id = NULL,
       scheduled_migration_date = NULL,
       updated_at = now()
     RETURNING ${SUBSCRIPTION_RETURNING}`,
    [tenantId, customerId, plan.plan_family_id, planId],
  )).rows[0];
  return { status: "ok", subscription: shapeSubscription(row) };
}

export async function scheduleMigration(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  targetPlanId: string,
  migrationDate: Date,
): Promise<SubscriptionWriteResult> {
  const locked = (await client.query<{ id: string; plan_family_id: string }>(
    `SELECT id, plan_family_id
     FROM customer_plan_subscriptions
     WHERE tenant_id = $1 AND customer_id = $2
     FOR UPDATE`,
    [tenantId, customerId],
  )).rows[0];
  if (!locked) return { status: "not_found" };

  const target = (await client.query<{ plan_family_id: string }>(
    `SELECT plan_family_id FROM plans WHERE id = $1 AND tenant_id = $2`,
    [targetPlanId, tenantId],
  )).rows[0];
  if (!target || target.plan_family_id !== locked.plan_family_id) return { status: "plan_not_found" };

  const row = (await client.query<SubscriptionRow>(
    `UPDATE customer_plan_subscriptions
     SET scheduled_plan_id = $3,
         scheduled_migration_date = $4,
         grandfathered = false,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${SUBSCRIPTION_RETURNING}`,
    [locked.id, tenantId, targetPlanId, migrationDate],
  )).rows[0];
  return { status: "ok", subscription: shapeSubscription(row) };
}

export async function setGrandfathered(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  grandfathered: boolean,
): Promise<SubscriptionRecord | null> {
  const locked = (await client.query<{ id: string }>(
    `SELECT id
     FROM customer_plan_subscriptions
     WHERE tenant_id = $1 AND customer_id = $2
     FOR UPDATE`,
    [tenantId, customerId],
  )).rows[0];
  if (!locked) return null;

  const row = grandfathered
    ? (await client.query<SubscriptionRow>(
      `UPDATE customer_plan_subscriptions
       SET grandfathered = true,
           scheduled_plan_id = NULL,
           scheduled_migration_date = NULL,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${SUBSCRIPTION_RETURNING}`,
      [locked.id, tenantId],
    )).rows[0]
    : (await client.query<SubscriptionRow>(
      `UPDATE customer_plan_subscriptions
       SET grandfathered = false,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${SUBSCRIPTION_RETURNING}`,
      [locked.id, tenantId],
    )).rows[0];
  return shapeSubscription(row);
}

export async function previewMigration(
  client: PoolClient,
  tenantId: string,
  targetPlanId: string,
): Promise<MigrationPreview> {
  const rows = (await client.query<{ scheduled_migration_date: Date; count: string }>(
    `SELECT scheduled_migration_date, count(*)::text AS count
     FROM customer_plan_subscriptions
     WHERE tenant_id = $1 AND scheduled_plan_id = $2
     GROUP BY scheduled_migration_date
     ORDER BY scheduled_migration_date`,
    [tenantId, targetPlanId],
  )).rows;
  const byDate = rows.map((row) => ({
    date: toIso(row.scheduled_migration_date),
    count: Number(row.count),
  }));
  return {
    total: byDate.reduce((sum, row) => sum + row.count, 0),
    by_date: byDate,
  };
}

export async function planIdForFamilyVersion(
  client: PoolClient,
  tenantId: string,
  planFamilyId: string,
  version: number,
): Promise<string | null> {
  const row = (await client.query<{ id: string }>(
    `SELECT id FROM plans
     WHERE tenant_id = $1 AND plan_family_id = $2 AND version = $3`,
    [tenantId, planFamilyId, version],
  )).rows[0];
  return row?.id ?? null;
}

export async function readBillingAnchor(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<{ timezone: string; anchorDay: number }> {
  const row = (await client.query<{ billing_timezone: string; billing_anchor_day: number }>(
    `SELECT billing_timezone, billing_anchor_day
     FROM customer_billing_config
     WHERE tenant_id = $1 AND customer_id = $2`,
    [tenantId, customerId],
  )).rows[0];
  if (!row) return { timezone: "UTC", anchorDay: 1 };
  return { timezone: row.billing_timezone, anchorDay: Number(row.billing_anchor_day) };
}
