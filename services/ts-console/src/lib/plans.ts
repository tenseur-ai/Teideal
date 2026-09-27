import type { PoolClient } from "pg";

export type BillingInterval = "monthly" | "annual";
export type PlanStatus = "draft" | "published";

export interface PlanRate {
  metric: string;
  model: string | null;
  rate: number;
}

export interface PlanRecord {
  id: string;
  name: string;
  currency: string;
  billing_interval: BillingInterval;
  included_credits: number;
  hard_cap: number | null;
  soft_cap: number | null;
  status: PlanStatus;
  version: number | null;
  created_by_user_id: string | null;
  published_by_user_id: string | null;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  rates: PlanRate[];
}

export interface CreatePlanInput {
  name: string;
  currency: string;
  billing_interval: BillingInterval;
  included_credits: number;
  hard_cap: number | null;
  soft_cap: number | null;
  rates: PlanRate[];
}

export interface PatchPlanInput {
  name?: string;
  currency?: string;
  billing_interval?: BillingInterval;
  included_credits?: number;
  hard_cap?: number;
  soft_cap?: number;
  rates?: PlanRate[];
}

export type PlanValidationError = { error: string };

interface PlanQueryRow {
  id: string;
  name: string;
  currency: string;
  billing_interval: BillingInterval;
  included_credits: string | number;
  hard_cap: string | number | null;
  soft_cap: string | number | null;
  status: PlanStatus;
  version: number | null;
  created_by_user_id: string | null;
  published_by_user_id: string | null;
  published_by: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RateQueryRow {
  plan_id: string;
  metric: string;
  model: string | null;
  rate: string | number;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const PLAN_SELECT = `
  p.id, p.name, p.currency, p.billing_interval, p.included_credits, p.hard_cap, p.soft_cap,
  p.status, p.version, p.created_by_user_id, p.published_by_user_id,
  publisher.email AS published_by, p.published_at, p.created_at, p.updated_at`;

type Field<T> = { error: string } | { value: T | undefined };

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

function validateName(value: unknown, required: boolean): Field<string> {
  if (value === undefined) return required ? { error: "name is required" } : { value: undefined };
  if (typeof value !== "string" || value.trim() === "") return { error: "name is required" };
  return { value: value.trim() };
}

function validateCurrency(value: unknown, required: boolean): Field<string> {
  if (value === undefined) return required ? { error: "currency is required" } : { value: undefined };
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) return { error: "currency must be a 3-letter ISO code" };
  return { value };
}

function validateInterval(value: unknown, required: boolean): Field<BillingInterval> {
  if (value === undefined) return required ? { error: "billing_interval is required" } : { value: undefined };
  if (value !== "monthly" && value !== "annual") return { error: "billing_interval must be monthly or annual" };
  return { value };
}

function validateNonNegative(value: unknown, field: string): Field<number> {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: `${field} must be a non-negative number` };
  }
  return { value };
}

function validateRates(value: unknown): { error: string } | { rates: PlanRate[] } {
  if (!Array.isArray(value)) return { error: "rates must be an array" };
  const rates: PlanRate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { error: "metric is required" };
    const raw = entry as { metric?: unknown; model?: unknown; rate?: unknown };
    if (typeof raw.metric !== "string" || raw.metric.trim() === "") return { error: "metric is required" };
    const metric = raw.metric.trim();
    if (!Object.prototype.hasOwnProperty.call(raw, "rate") || typeof raw.rate !== "number" || !Number.isFinite(raw.rate) || raw.rate < 0) {
      return { error: `a rate is required for metric ${metric}` };
    }
    let model: string | null = null;
    if (raw.model !== undefined) {
      if (raw.model === null) model = null;
      else if (typeof raw.model === "string" && raw.model.trim() !== "") model = raw.model.trim();
      else return { error: "model must be a non-empty string or null" };
    }
    if (model !== null) {
      const key = `${metric}\0${model}`;
      if (seen.has(key)) return { error: `duplicate rate for metric ${metric} and model ${model}` };
      seen.add(key);
    }
    rates.push({ metric, model, rate: raw.rate });
  }
  return { rates };
}

export function validatePlanInput(body: unknown, mode: "create"): PlanValidationError | CreatePlanInput;
export function validatePlanInput(body: unknown, mode: "patch"): PlanValidationError | PatchPlanInput;
export function validatePlanInput(body: unknown, mode: "create" | "patch"): PlanValidationError | CreatePlanInput | PatchPlanInput {
  const record = asRecord(body);
  const required = mode === "create";
  const name = validateName(record.name, required);
  if ("error" in name) return name;
  const currency = validateCurrency(record.currency, required);
  if ("error" in currency) return currency;
  const billingInterval = validateInterval(record.billing_interval, required);
  if ("error" in billingInterval) return billingInterval;
  const includedCredits = validateNonNegative(record.included_credits, "included_credits");
  if ("error" in includedCredits) return includedCredits;
  const hardCap = validateNonNegative(record.hard_cap, "hard_cap");
  if ("error" in hardCap) return hardCap;
  const softCap = validateNonNegative(record.soft_cap, "soft_cap");
  if ("error" in softCap) return softCap;

  let rates: PlanRate[] | undefined;
  if (record.rates === undefined) rates = required ? [] : undefined;
  else {
    const parsedRates = validateRates(record.rates);
    if ("error" in parsedRates) return parsedRates;
    rates = parsedRates.rates;
  }

  if (required) {
    return {
      name: name.value as string,
      currency: currency.value as string,
      billing_interval: billingInterval.value as BillingInterval,
      included_credits: includedCredits.value ?? 0,
      hard_cap: hardCap.value ?? null,
      soft_cap: softCap.value ?? null,
      rates: rates ?? [],
    };
  }

  const patch: PatchPlanInput = {};
  if (name.value !== undefined) patch.name = name.value;
  if (currency.value !== undefined) patch.currency = currency.value;
  if (billingInterval.value !== undefined) patch.billing_interval = billingInterval.value;
  if (includedCredits.value !== undefined) patch.included_credits = includedCredits.value;
  if (hardCap.value !== undefined) patch.hard_cap = hardCap.value;
  if (softCap.value !== undefined) patch.soft_cap = softCap.value;
  if (rates !== undefined) patch.rates = rates;
  return patch;
}

export function shapePlanRecord(
  row: PlanQueryRow,
  rates: Array<{ metric: string; model: string | null; rate: string | number }>,
): PlanRecord {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    billing_interval: row.billing_interval,
    included_credits: toNumber(row.included_credits),
    hard_cap: row.hard_cap === null ? null : toNumber(row.hard_cap),
    soft_cap: row.soft_cap === null ? null : toNumber(row.soft_cap),
    status: row.status,
    version: row.version === null ? null : Number(row.version),
    created_by_user_id: row.created_by_user_id,
    published_by_user_id: row.published_by_user_id,
    published_by: row.published_by,
    published_at: row.published_at === null ? null : toIso(row.published_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    rates: rates.map((rate) => ({ metric: rate.metric, model: rate.model, rate: toNumber(rate.rate) })),
  };
}

async function ratesForPlans(client: PoolClient, planIds: string[]): Promise<Map<string, RateQueryRow[]>> {
  const grouped = new Map<string, RateQueryRow[]>();
  for (const id of planIds) grouped.set(id, []);
  if (planIds.length === 0) return grouped;
  const { rows } = await client.query<RateQueryRow>(
    `SELECT plan_id, metric, model, rate
     FROM plan_rates
     WHERE plan_id::text = ANY($1::text[])
     ORDER BY metric, model NULLS FIRST, id`,
    [planIds],
  );
  for (const row of rows) grouped.get(row.plan_id)?.push(row);
  return grouped;
}

async function shapeRows(client: PoolClient, rows: PlanQueryRow[]): Promise<PlanRecord[]> {
  const rates = await ratesForPlans(client, rows.map((row) => row.id));
  return rows.map((row) => shapePlanRecord(row, rates.get(row.id) ?? []));
}

export async function readPlan(client: PoolClient, tenantId: string, planId: string): Promise<PlanRecord | null> {
  const row = (await client.query<PlanQueryRow>(
    `SELECT ${PLAN_SELECT}
     FROM plans p
     LEFT JOIN users publisher ON publisher.id = p.published_by_user_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [planId, tenantId],
  )).rows[0];
  if (!row) return null;
  const [shaped] = await shapeRows(client, [row]);
  return shaped;
}

export async function listPlans(
  client: PoolClient,
  tenantId: string,
  cursor: string | null,
  limit: number,
): Promise<PlanRecord[]> {
  const values: unknown[] = [tenantId];
  let cursorClause = "";
  if (cursor) {
    values.push(cursor);
    cursorClause = `AND p.id > $${values.length}`;
  }
  values.push(limit);
  const rows = (await client.query<PlanQueryRow>(
    `SELECT ${PLAN_SELECT}
     FROM plans p
     LEFT JOIN users publisher ON publisher.id = p.published_by_user_id
     WHERE p.tenant_id = $1 ${cursorClause}
     ORDER BY p.id
     LIMIT $${values.length}`,
    values,
  )).rows;
  return shapeRows(client, rows);
}

export async function insertPlan(
  client: PoolClient,
  tenantId: string,
  createdByUserId: string,
  input: CreatePlanInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO plans (
       tenant_id, name, currency, billing_interval, included_credits,
       hard_cap, soft_cap, status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.currency,
      input.billing_interval,
      input.included_credits,
      input.hard_cap,
      input.soft_cap,
      createdByUserId,
    ],
  );
  return rows[0].id;
}

export async function insertPlanRates(
  client: PoolClient,
  tenantId: string,
  planId: string,
  rates: PlanRate[],
): Promise<void> {
  if (rates.length === 0) return;
  await client.query(
    `INSERT INTO plan_rates (tenant_id, plan_id, metric, model, rate)
     SELECT $1, $2, r.metric, r.model, r.rate
     FROM jsonb_to_recordset($3::jsonb) AS r(metric text, model text, rate numeric)`,
    [tenantId, planId, JSON.stringify(rates)],
  );
}

export async function replacePlanRates(
  client: PoolClient,
  tenantId: string,
  planId: string,
  rates: PlanRate[],
): Promise<void> {
  await client.query(`DELETE FROM plan_rates WHERE plan_id = $1 AND tenant_id = $2`, [planId, tenantId]);
  await insertPlanRates(client, tenantId, planId, rates);
}

export type DraftUpdate =
  | { status: "not_found" }
  | { status: "published" }
  | { status: "ok"; before: PlanRecord; after: PlanRecord; changed: boolean };

export async function updateDraftPlan(
  client: PoolClient,
  tenantId: string,
  planId: string,
  patch: PatchPlanInput,
): Promise<DraftUpdate> {
  const locked = (await client.query<{ status: PlanStatus }>(
    `SELECT status FROM plans WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [planId, tenantId],
  )).rows[0];
  if (!locked) return { status: "not_found" };
  if (locked.status !== "draft") return { status: "published" };

  const before = await readPlan(client, tenantId, planId);
  if (!before) return { status: "not_found" };

  const changed = patch.name !== undefined
    || patch.currency !== undefined
    || patch.billing_interval !== undefined
    || patch.included_credits !== undefined
    || patch.hard_cap !== undefined
    || patch.soft_cap !== undefined
    || patch.rates !== undefined;
  if (!changed) return { status: "ok", before, after: before, changed: false };

  await client.query(
    `UPDATE plans SET
       name = COALESCE($3::text, name),
       currency = COALESCE($4::text, currency),
       billing_interval = COALESCE($5::text, billing_interval),
       included_credits = COALESCE($6::numeric, included_credits),
       hard_cap = COALESCE($7::numeric, hard_cap),
       soft_cap = COALESCE($8::numeric, soft_cap),
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [
      planId,
      tenantId,
      patch.name ?? null,
      patch.currency ?? null,
      patch.billing_interval ?? null,
      patch.included_credits ?? null,
      patch.hard_cap ?? null,
      patch.soft_cap ?? null,
    ],
  );
  if (patch.rates !== undefined) await replacePlanRates(client, tenantId, planId, patch.rates);
  const after = await readPlan(client, tenantId, planId);
  if (!after) throw new Error("updated plan was not readable");
  return { status: "ok", before, after, changed: true };
}

// Conditional on status = 'draft' so two concurrent publishes cannot both
// observe a draft row: the loser matches zero rows after the winner commits.
export async function publishDraftPlan(
  client: PoolClient,
  tenantId: string,
  planId: string,
  publishedByUserId: string,
): Promise<PlanRecord | null> {
  const updated = await client.query(
    `UPDATE plans
     SET status = 'published', version = 1, published_by_user_id = $3,
         published_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
     RETURNING id`,
    [planId, tenantId, publishedByUserId],
  );
  if ((updated.rowCount ?? 0) === 0) return null;
  const plan = await readPlan(client, tenantId, planId);
  if (!plan) throw new Error("published plan was not readable");
  return plan;
}
