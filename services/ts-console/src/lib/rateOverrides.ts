import type { PoolClient } from "pg";
import { parseAsOf, parseExplicitTimestamp, type GrantValidationError } from "./grants.js";

export type OverrideValidationError = GrantValidationError;

export interface CreateOverrideInput {
  customer_id: string;
  metric: string;
  model: string | null;
  rate: number;
  start_date: Date;
  end_date: Date | null;
}

export interface PriceUsageInput {
  plan_id: string | undefined;
  metric: string;
  model: string | null;
  quantity: number;
  as_of: Date;
}

export interface RateOverrideRecord {
  id: string;
  customer_id: string;
  metric: string;
  model: string | null;
  rate: number;
  start_date: string;
  end_date: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PricedUsageLine {
  id: string;
  customer_id: string;
  plan_id: string;
  metric: string;
  model: string | null;
  quantity: number;
  rate_applied: number;
  amount: number;
  rate_override_id: string | null;
  occurred_at: string;
  created_at: string;
}

export interface EffectiveRate {
  rate: string;
  overrideId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OVERRIDE_SELECT = `
  id, customer_id, metric, model, rate, start_date, end_date,
  created_by_user_id, created_at, updated_at`;

interface OverrideQueryRow {
  id: string;
  customer_id: string;
  metric: string;
  model: string | null;
  rate: string | number;
  start_date: Date | string;
  end_date: Date | string | null;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PricedUsageQueryRow {
  id: string;
  customer_id: string;
  plan_id: string;
  metric: string;
  model: string | null;
  quantity: string | number;
  rate_applied: string | number;
  amount: string | number;
  rate_override_id: string | null;
  occurred_at: Date | string;
  created_at: Date | string;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function validateCustomerId(value: unknown): OverrideValidationError | { value: string } {
  if (value === undefined || value === null) return { error: "customer_id is required" };
  if (typeof value !== "string" || !UUID_RE.test(value)) return { error: "customer_id must be a UUID" };
  return { value };
}

function validateMetric(value: unknown): OverrideValidationError | { value: string } {
  if (value === undefined || value === null) return { error: "metric is required" };
  if (typeof value !== "string" || value.trim() === "") return { error: "metric is required" };
  return { value: value.trim() };
}

function validateModel(value: unknown): OverrideValidationError | { value: string | null } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string" || value.trim() === "") return { error: "model must be a string" };
  return { value: value.trim() };
}

function validateRate(value: unknown): OverrideValidationError | { value: number } {
  if (value === undefined || value === null) return { error: "rate is required" };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: "rate must be a finite number greater than or equal to 0" };
  }
  return { value };
}

function validateQuantity(value: unknown): OverrideValidationError | { value: number } {
  if (value === undefined || value === null) return { error: "quantity is required" };
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { error: "quantity must be a positive finite number" };
  }
  return { value };
}

function validatePlanId(value: unknown): OverrideValidationError | { value: string | undefined } {
  // Omitted plan_id is resolved from the customer's subscription. An explicit
  // null keeps the original required-field error.
  if (value === undefined) return { value: undefined };
  if (value === null) return { error: "plan_id is required" };
  if (typeof value !== "string" || !UUID_RE.test(value)) return { error: "plan_id must be a UUID" };
  return { value };
}

export function validateOverrideInput(body: unknown): OverrideValidationError | CreateOverrideInput {
  const record = asRecord(body);
  const customerId = validateCustomerId(record.customer_id);
  if ("error" in customerId) return customerId;
  const metric = validateMetric(record.metric);
  if ("error" in metric) return metric;
  const model = validateModel(record.model);
  if ("error" in model) return model;
  const rate = validateRate(record.rate);
  if ("error" in rate) return rate;
  if (record.start_date === undefined || record.start_date === null) return { error: "start_date is required" };
  const start = parseExplicitTimestamp(record.start_date, "start_date");
  if ("error" in start) return start;

  let end: Date | null = null;
  if (record.end_date !== undefined && record.end_date !== null) {
    const parsed = parseExplicitTimestamp(record.end_date, "end_date");
    if ("error" in parsed) return parsed;
    if (parsed.value.getTime() <= start.value.getTime()) return { error: "end_date must be after start_date" };
    if (parsed.value.getTime() <= Date.now()) return { error: "end_date must not be in the past" };
    end = parsed.value;
  }

  return {
    customer_id: customerId.value,
    metric: metric.value,
    model: model.value,
    rate: rate.value,
    start_date: start.value,
    end_date: end,
  };
}

export function validatePriceUsageInput(body: unknown): OverrideValidationError | PriceUsageInput {
  const record = asRecord(body);
  const planId = validatePlanId(record.plan_id);
  if ("error" in planId) return planId;
  const metric = validateMetric(record.metric);
  if ("error" in metric) return metric;
  const model = validateModel(record.model);
  if ("error" in model) return model;
  const quantity = validateQuantity(record.quantity);
  if ("error" in quantity) return quantity;
  const asOf = parseAsOf(record.as_of);
  if ("error" in asOf) return asOf;
  return {
    plan_id: planId.value,
    metric: metric.value,
    model: model.value,
    quantity: quantity.value,
    as_of: asOf.value,
  };
}

export function shapeOverrideRecord(row: OverrideQueryRow): RateOverrideRecord {
  return {
    id: row.id,
    customer_id: row.customer_id,
    metric: row.metric,
    model: row.model,
    rate: toNumber(row.rate),
    start_date: toIso(row.start_date),
    end_date: row.end_date === null ? null : toIso(row.end_date),
    created_by_user_id: row.created_by_user_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function shapePricedUsageLine(row: PricedUsageQueryRow): PricedUsageLine {
  return {
    id: row.id,
    customer_id: row.customer_id,
    plan_id: row.plan_id,
    metric: row.metric,
    model: row.model,
    quantity: toNumber(row.quantity),
    rate_applied: toNumber(row.rate_applied),
    amount: toNumber(row.amount),
    rate_override_id: row.rate_override_id,
    occurred_at: toIso(row.occurred_at),
    created_at: toIso(row.created_at),
  };
}

export async function checkOverlap(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  metric: string,
  model: string | null,
  startDate: Date,
  endDate: Date | null,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM customer_rate_overrides
       WHERE tenant_id = $1 AND customer_id = $2 AND metric = $3
         AND model IS NOT DISTINCT FROM $4
         AND start_date < COALESCE($6, 'infinity'::timestamptz)
         AND COALESCE(end_date, 'infinity'::timestamptz) > $5
     ) AS exists`,
    [tenantId, customerId, metric, model, startDate, endDate],
  );
  return rows[0]?.exists === true;
}

export async function insertOverride(
  client: PoolClient,
  tenantId: string,
  userId: string,
  input: CreateOverrideInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO customer_rate_overrides (
       tenant_id, customer_id, metric, model, rate, start_date, end_date, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      input.customer_id,
      input.metric,
      input.model,
      String(input.rate),
      input.start_date,
      input.end_date,
      userId,
    ],
  );
  return rows[0].id;
}

export async function readOverride(
  client: PoolClient,
  tenantId: string,
  overrideId: string,
): Promise<RateOverrideRecord | null> {
  const row = (await client.query<OverrideQueryRow>(
    `SELECT ${OVERRIDE_SELECT}
     FROM customer_rate_overrides
     WHERE id = $1 AND tenant_id = $2`,
    [overrideId, tenantId],
  )).rows[0];
  return row ? shapeOverrideRecord(row) : null;
}

export async function listOverrides(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  cursor: string | null,
  limit: number,
): Promise<RateOverrideRecord[]> {
  const values: unknown[] = [tenantId, customerId];
  let cursorClause = "";
  if (cursor) {
    values.push(cursor);
    cursorClause = `AND id > $${values.length}`;
  }
  values.push(limit);
  const rows = (await client.query<OverrideQueryRow>(
    `SELECT ${OVERRIDE_SELECT}
     FROM customer_rate_overrides
     WHERE tenant_id = $1 AND customer_id = $2 ${cursorClause}
     ORDER BY id
     LIMIT $${values.length}`,
    values,
  )).rows;
  return rows.map(shapeOverrideRecord);
}

export async function resolveEffectiveRate(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  planId: string,
  metric: string,
  model: string | null,
  asOf: Date,
): Promise<EffectiveRate | null> {
  const override = (await client.query<{ id: string; rate: string }>(
    `SELECT id, rate::text AS rate
     FROM customer_rate_overrides
     WHERE tenant_id = $1 AND customer_id = $2 AND metric = $3
       AND model IS NOT DISTINCT FROM $4
       AND $5::timestamptz >= start_date
       AND (end_date IS NULL OR $5::timestamptz < end_date)
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, customerId, metric, model, asOf],
  )).rows[0];
  if (override) return { rate: override.rate, overrideId: override.id };

  const planRate = (await client.query<{ rate: string }>(
    `SELECT rate::text AS rate
     FROM plan_rates
     WHERE plan_id = $1 AND metric = $2 AND model IS NOT DISTINCT FROM $3`,
    [planId, metric, model],
  )).rows[0];
  if (planRate) return { rate: planRate.rate, overrideId: null };
  return null;
}

export async function insertPricedUsageLine(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  planId: string,
  metric: string,
  model: string | null,
  quantity: number,
  rate: string,
  overrideId: string | null,
  occurredAt: Date,
): Promise<PricedUsageLine> {
  const row = (await client.query<PricedUsageQueryRow>(
    `INSERT INTO priced_usage_lines (
       tenant_id, customer_id, plan_id, metric, model, quantity, rate_applied, amount,
       rate_override_id, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $6::numeric * $7::numeric, $8, $9
     )
     RETURNING id, customer_id, plan_id, metric, model, quantity, rate_applied, amount,
               rate_override_id, occurred_at, created_at`,
    [tenantId, customerId, planId, metric, model, String(quantity), rate, overrideId, occurredAt],
  )).rows[0];
  return shapePricedUsageLine(row);
}

export async function planVisible(client: PoolClient, planId: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM plans WHERE id = $1) AS exists`,
    [planId],
  );
  return rows[0]?.exists === true;
}
