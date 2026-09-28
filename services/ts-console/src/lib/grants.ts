import type { PoolClient } from "pg";
import { computeNextTranche, type DrawdownSchedule } from "./commitSchedule.js";

export type GrantSource = "paid" | "promotional" | "commit" | "goodwill";
export type GrantStatus = "active" | "expired" | "void";
export type GrantEntryType = "issued" | "expired" | "voided" | "released" | "carried_over";
export type { DrawdownSchedule };

export interface GrantRecord {
  id: string;
  customer_id: string;
  amount: number;
  remaining_amount: number;
  unit: string;
  source: GrantSource;
  start_date: string;
  expiry_date: string | null;
  status: GrantStatus;
  created_by_user_id: string | null;
  created_by: string | null;
  recurring_template_id: string | null;
  period_key: string | null;
  drawdown_schedule: DrawdownSchedule | null;
  overage_rate: number | null;
  carries_over: boolean;
  next_release_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrantTemplateRecord {
  id: string;
  customer_id: string;
  amount: number;
  unit: string;
  source: GrantSource;
  interval: "monthly";
  created_by_user_id: string | null;
  created_by: string | null;
  active: boolean;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  grant_id: string;
  entry_type: GrantEntryType;
  amount: number;
  reason: string | null;
  occurred_at: string;
}

export interface CreateGrantInput {
  customer_id: string;
  amount: number;
  unit: string;
  source: GrantSource;
  start_date: Date;
  expiry_date: Date | null;
  drawdown_schedule: DrawdownSchedule | null;
  overage_rate: number | null;
  carries_over: boolean;
}

export interface AmendCommitInput {
  reason: string;
  overage_rate?: number;
  expiry_date?: Date;
  carries_over?: boolean;
}

export interface AmendCommitChanges {
  overage_rate?: number;
  expiry_date?: Date;
  carries_over?: boolean;
}

export interface CreateTemplateInput {
  customer_id: string;
  amount: number;
  unit: string;
  source: GrantSource;
  interval: "monthly";
}

export interface ConsumeInput {
  amount: number;
  as_of: Date;
}

export interface LedgerFilters {
  grantId?: string;
  customerId?: string;
  from?: string;
  to?: string;
  entryType?: GrantEntryType;
  source?: GrantSource;
}

export interface Eligibility {
  eligible: boolean;
  remaining_amount: string;
  reason?: string;
}

export type GrantValidationError = { error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES: readonly GrantSource[] = ["paid", "promotional", "commit", "goodwill"];
// Naive timestamps are rejected so the stored instant cannot depend on the
// server's local zone. Same rule the eligibility/consume as_of parameter uses.
const EXPLICIT_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ENTRY_TYPES: readonly GrantEntryType[] = ["issued", "expired", "voided", "released", "carried_over"];
const DRAWDOWN_SCHEDULES: readonly DrawdownSchedule[] = ["upfront", "monthly", "quarterly"];

const GRANT_SELECT = `
  g.id, g.customer_id, g.amount, g.remaining_amount, g.unit, g.source,
  g.start_date, g.expiry_date, g.status, g.created_by_user_id,
  creator.email AS created_by, g.recurring_template_id, g.period_key,
  g.drawdown_schedule, g.overage_rate, g.carries_over, g.next_release_at,
  g.created_at, g.updated_at`;

const TEMPLATE_SELECT = `
  t.id, t.customer_id, t.amount, t.unit, t.source, t.interval,
  t.created_by_user_id, creator.email AS created_by, t.active, t.created_at`;

interface GrantQueryRow {
  id: string;
  customer_id: string;
  amount: string | number;
  remaining_amount: string | number;
  unit: string;
  source: GrantSource;
  start_date: Date | string;
  expiry_date: Date | string | null;
  status: GrantStatus;
  created_by_user_id: string | null;
  created_by: string | null;
  recurring_template_id: string | null;
  period_key: string | null;
  drawdown_schedule: DrawdownSchedule | null;
  overage_rate: string | number | null;
  carries_over: boolean;
  next_release_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TemplateQueryRow {
  id: string;
  customer_id: string;
  amount: string | number;
  unit: string;
  source: GrantSource;
  interval: "monthly";
  created_by_user_id: string | null;
  created_by: string | null;
  active: boolean;
  created_at: Date | string;
}

interface LedgerQueryRow {
  id: string;
  grant_id: string;
  entry_type: GrantEntryType;
  amount: string | number;
  reason: string | null;
  occurred_at: Date | string;
}

interface EligibilityRow {
  eligible: boolean;
  remaining_amount: string;
  reason: string | null;
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

function timestampError(field: string): string {
  return `${field} must be an ISO 8601 timestamp with an explicit offset`;
}

export function parseExplicitTimestamp(value: unknown, field: string): GrantValidationError | { value: Date } {
  if (typeof value !== "string" || !EXPLICIT_OFFSET_RE.test(value)) return { error: timestampError(field) };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: timestampError(field) };
  return { value: parsed };
}

export function parseAsOf(value: unknown): GrantValidationError | { value: Date } {
  if (value === undefined) return { value: new Date() };
  return parseExplicitTimestamp(value, "as_of");
}

function validateCustomerId(value: unknown): GrantValidationError | { value: string } {
  if (value === undefined || value === null) return { error: "customer_id is required" };
  if (typeof value !== "string" || !UUID_RE.test(value)) return { error: "customer_id must be a UUID" };
  return { value: value };
}

function validateAmount(value: unknown): GrantValidationError | { value: number } {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { error: "amount must be a positive finite number" };
  }
  return { value };
}

function validateUnit(value: unknown): GrantValidationError | { value: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: "unit is required" };
  return { value: value.trim() };
}

function validateSource(value: unknown): GrantValidationError | { value: GrantSource } {
  if (typeof value !== "string" || !SOURCES.includes(value as GrantSource)) {
    return { error: "source must be paid, promotional, commit, or goodwill" };
  }
  return { value: value as GrantSource };
}

function validateOverageRate(value: unknown): GrantValidationError | { value: number } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: "overage_rate must be a finite number greater than or equal to 0" };
  }
  return { value };
}

function validateDrawdownSchedule(value: unknown): GrantValidationError | { value: DrawdownSchedule } {
  if (typeof value !== "string" || !DRAWDOWN_SCHEDULES.includes(value as DrawdownSchedule)) {
    return { error: "drawdown_schedule must be upfront, monthly, or quarterly" };
  }
  return { value: value as DrawdownSchedule };
}

export function validateGrantInput(body: unknown): GrantValidationError | CreateGrantInput {
  const record = asRecord(body);
  const customerId = validateCustomerId(record.customer_id);
  if ("error" in customerId) return customerId;
  const amount = validateAmount(record.amount);
  if ("error" in amount) return amount;
  const unit = validateUnit(record.unit);
  if ("error" in unit) return unit;
  const source = validateSource(record.source);
  if ("error" in source) return source;
  for (const field of ["drawdown_schedule", "overage_rate", "carries_over"] as const) {
    if (source.value !== "commit" && record[field] !== undefined) {
      return { error: `${field} is only valid for a commit` };
    }
  }
  if (record.start_date === undefined || record.start_date === null) return { error: "start_date is required" };
  const start = parseExplicitTimestamp(record.start_date, "start_date");
  if ("error" in start) return start;

  let expiry: Date | null = null;
  if (record.expiry_date !== undefined && record.expiry_date !== null) {
    const parsed = parseExplicitTimestamp(record.expiry_date, "expiry_date");
    if ("error" in parsed) return parsed;
    if (parsed.value.getTime() <= start.value.getTime()) return { error: "expiry_date must be after start_date" };
    expiry = parsed.value;
  }

  let drawdownSchedule: DrawdownSchedule | null = null;
  let overageRate: number | null = null;
  let carriesOver = false;
  if (source.value === "commit") {
    if (record.drawdown_schedule === undefined || record.drawdown_schedule === null) {
      return { error: "drawdown_schedule is required for a commit" };
    }
    const schedule = validateDrawdownSchedule(record.drawdown_schedule);
    if ("error" in schedule) return schedule;
    if (record.overage_rate === undefined || record.overage_rate === null) {
      return { error: "overage_rate is required for a commit" };
    }
    const rate = validateOverageRate(record.overage_rate);
    if ("error" in rate) return rate;
    if (record.carries_over !== undefined && record.carries_over !== null) {
      if (typeof record.carries_over !== "boolean") return { error: "carries_over must be a boolean" };
      carriesOver = record.carries_over;
    }
    if (schedule.value !== "upfront" && expiry === null) {
      return { error: "expiry_date is required for a monthly or quarterly commit" };
    }
    drawdownSchedule = schedule.value;
    overageRate = rate.value;
  }

  return {
    customer_id: customerId.value,
    amount: amount.value,
    unit: unit.value,
    source: source.value,
    start_date: start.value,
    expiry_date: expiry,
    drawdown_schedule: drawdownSchedule,
    overage_rate: overageRate,
    carries_over: carriesOver,
  };
}

export function validateTemplateInput(body: unknown): GrantValidationError | CreateTemplateInput {
  const record = asRecord(body);
  const customerId = validateCustomerId(record.customer_id);
  if ("error" in customerId) return customerId;
  const amount = validateAmount(record.amount);
  if ("error" in amount) return amount;
  const unit = validateUnit(record.unit);
  if ("error" in unit) return unit;
  const source = validateSource(record.source);
  if ("error" in source) return source;
  if (record.interval === undefined || record.interval === null) return { error: "interval is required" };
  if (record.interval !== "monthly") return { error: "interval must be monthly" };
  return {
    customer_id: customerId.value,
    amount: amount.value,
    unit: unit.value,
    source: source.value,
    interval: "monthly",
  };
}

export function validateConsumeInput(body: unknown): GrantValidationError | ConsumeInput {
  const record = asRecord(body);
  const amount = validateAmount(record.amount);
  if ("error" in amount) return amount;
  const asOf = parseAsOf(record.as_of);
  if ("error" in asOf) return asOf;
  return { amount: amount.value, as_of: asOf.value };
}

export function validateReason(value: unknown): GrantValidationError | { reason: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: "reason is required" };
  return { reason: value };
}

export function validateVoidInput(body: unknown): GrantValidationError | { reason: string } {
  return validateReason(asRecord(body).reason);
}

export function validateAmendCommitInput(body: unknown): GrantValidationError | AmendCommitInput {
  const record = asRecord(body);
  const reason = validateReason(record.reason);
  if ("error" in reason) return reason;
  const changes: AmendCommitInput = { reason: reason.reason };
  let any = false;
  if (record.overage_rate !== undefined) {
    const rate = validateOverageRate(record.overage_rate);
    if ("error" in rate) return rate;
    changes.overage_rate = rate.value;
    any = true;
  }
  if (record.expiry_date !== undefined) {
    const parsed = parseExplicitTimestamp(record.expiry_date, "expiry_date");
    if ("error" in parsed) return parsed;
    changes.expiry_date = parsed.value;
    any = true;
  }
  if (record.carries_over !== undefined) {
    if (typeof record.carries_over !== "boolean") return { error: "carries_over must be a boolean" };
    changes.carries_over = record.carries_over;
    any = true;
  }
  if (!any) return { error: "at least one field must change" };
  return changes;
}

export function validateLedgerFilters(query: {
  grant_id?: unknown;
  customer_id?: unknown;
  from?: unknown;
  to?: unknown;
  entry_type?: unknown;
  source?: unknown;
}): GrantValidationError | LedgerFilters {
  for (const key of ["grant_id", "customer_id", "from", "to", "entry_type", "source"] as const) {
    if (query[key] !== undefined && typeof query[key] !== "string") return { error: `${key} must be a string` };
  }
  if (typeof query.grant_id === "string" && !UUID_RE.test(query.grant_id)) return { error: "grant_id must be a UUID" };
  if (typeof query.customer_id === "string" && !UUID_RE.test(query.customer_id)) return { error: "customer_id must be a UUID" };
  if (typeof query.entry_type === "string" && !ENTRY_TYPES.includes(query.entry_type as GrantEntryType)) {
    return { error: "entry_type must be issued, expired, voided, released, or carried_over" };
  }
  if (typeof query.source === "string" && !SOURCES.includes(query.source as GrantSource)) {
    return { error: "source must be paid, promotional, commit, or goodwill" };
  }

  const parseDate = (name: "from" | "to", value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    const timestamp = Date.parse(value as string);
    if (Number.isNaN(timestamp)) return undefined;
    return new Date(timestamp).toISOString();
  };
  const from = parseDate("from", query.from);
  const to = parseDate("to", query.to);
  if (query.from !== undefined && from === undefined) return { error: "from must be a parseable ISO date" };
  if (query.to !== undefined && to === undefined) return { error: "to must be a parseable ISO date" };
  if (from && to && from > to) return { error: "from must not be later than to" };

  return {
    grantId: typeof query.grant_id === "string" ? query.grant_id : undefined,
    customerId: typeof query.customer_id === "string" ? query.customer_id : undefined,
    from,
    to,
    entryType: typeof query.entry_type === "string" ? query.entry_type as GrantEntryType : undefined,
    source: typeof query.source === "string" ? query.source as GrantSource : undefined,
  };
}

export function shapeGrantRecord(row: GrantQueryRow): GrantRecord {
  return {
    id: row.id,
    customer_id: row.customer_id,
    amount: toNumber(row.amount),
    remaining_amount: toNumber(row.remaining_amount),
    unit: row.unit,
    source: row.source,
    start_date: toIso(row.start_date),
    expiry_date: row.expiry_date === null ? null : toIso(row.expiry_date),
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_by: row.created_by,
    recurring_template_id: row.recurring_template_id,
    period_key: row.period_key,
    drawdown_schedule: row.drawdown_schedule,
    overage_rate: row.overage_rate === null ? null : toNumber(row.overage_rate),
    carries_over: row.carries_over,
    next_release_at: row.next_release_at === null ? null : toIso(row.next_release_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function shapeTemplateRecord(row: TemplateQueryRow): GrantTemplateRecord {
  return {
    id: row.id,
    customer_id: row.customer_id,
    amount: toNumber(row.amount),
    unit: row.unit,
    source: row.source,
    interval: row.interval,
    created_by_user_id: row.created_by_user_id,
    created_by: row.created_by,
    active: row.active,
    created_at: toIso(row.created_at),
  };
}

function shapeLedgerEntry(row: LedgerQueryRow): LedgerEntry {
  return {
    id: row.id,
    grant_id: row.grant_id,
    entry_type: row.entry_type,
    amount: toNumber(row.amount),
    reason: row.reason,
    occurred_at: toIso(row.occurred_at),
  };
}

export async function customerVisible(client: PoolClient, customerId: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1) AS exists`,
    [customerId],
  );
  return rows[0]?.exists === true;
}

export async function readGrant(client: PoolClient, tenantId: string, grantId: string): Promise<GrantRecord | null> {
  const row = (await client.query<GrantQueryRow>(
    `SELECT ${GRANT_SELECT}
     FROM grants g
     LEFT JOIN users creator ON creator.id = g.created_by_user_id
     WHERE g.id = $1 AND g.tenant_id = $2`,
    [grantId, tenantId],
  )).rows[0];
  return row ? shapeGrantRecord(row) : null;
}

export async function listGrants(
  client: PoolClient,
  tenantId: string,
  cursor: string | null,
  limit: number,
): Promise<GrantRecord[]> {
  const values: unknown[] = [tenantId];
  let cursorClause = "";
  if (cursor) {
    values.push(cursor);
    cursorClause = `AND g.id > $${values.length}`;
  }
  values.push(limit);
  const rows = (await client.query<GrantQueryRow>(
    `SELECT ${GRANT_SELECT}
     FROM grants g
     LEFT JOIN users creator ON creator.id = g.created_by_user_id
     WHERE g.tenant_id = $1 ${cursorClause}
     ORDER BY g.id
     LIMIT $${values.length}`,
    values,
  )).rows;
  return rows.map(shapeGrantRecord);
}

export async function insertGrant(
  client: PoolClient,
  tenantId: string,
  createdByUserId: string,
  input: CreateGrantInput,
): Promise<{ id: string; issuedAmount: string }> {
  const fullAmount = String(input.amount);
  let remainingAmount = fullAmount;
  let issuedAmount = fullAmount;
  let nextReleaseAt: Date | null = null;
  if (
    input.source === "commit"
    && input.drawdown_schedule !== null
    && input.drawdown_schedule !== "upfront"
  ) {
    const first = computeNextTranche({
      amount: fullAmount,
      startDate: input.start_date,
      expiryDate: input.expiry_date,
      drawdownSchedule: input.drawdown_schedule,
      trancheIndex: 0,
    });
    remainingAmount = first.trancheAmount;
    issuedAmount = first.trancheAmount;
    nextReleaseAt = first.nextReleaseAt;
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO grants (
       tenant_id, customer_id, amount, remaining_amount, unit, source,
       start_date, expiry_date, status, created_by_user_id,
       drawdown_schedule, overage_rate, carries_over, next_release_at
     ) VALUES (
       $1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8, 'active', $9, $10, $11::numeric, $12, $13
     )
     RETURNING id`,
    [
      tenantId,
      input.customer_id,
      fullAmount,
      remainingAmount,
      input.unit,
      input.source,
      input.start_date,
      input.expiry_date,
      createdByUserId,
      input.drawdown_schedule,
      input.overage_rate === null ? null : String(input.overage_rate),
      input.carries_over,
      nextReleaseAt,
    ],
  );
  return { id: rows[0].id, issuedAmount };
}

export async function insertIssuedLedger(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  amount: number | string,
): Promise<void> {
  await client.query(
    `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
     VALUES ($1, $2, 'issued', $3::numeric)`,
    [tenantId, grantId, String(amount)],
  );
}

export async function readEligibility(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  asOf: Date,
): Promise<Eligibility | null> {
  const row = (await client.query<EligibilityRow>(
    `SELECT remaining_amount::text AS remaining_amount,
            (status = 'active'
              AND $3::timestamptz >= start_date
              AND (expiry_date IS NULL OR $3::timestamptz < expiry_date)) AS eligible,
            CASE
              WHEN status <> 'active' THEN 'grant is not active'
              WHEN $3::timestamptz < start_date THEN 'grant has not started'
              WHEN expiry_date IS NOT NULL AND $3::timestamptz >= expiry_date THEN 'grant has expired'
              ELSE NULL
            END AS reason
     FROM grants
     WHERE id = $1 AND tenant_id = $2`,
    [grantId, tenantId, asOf],
  )).rows[0];
  if (!row) return null;
  return {
    eligible: row.eligible,
    remaining_amount: row.remaining_amount,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

// The eligibility predicate lives in the WHERE clause so a concurrent consume
// cannot pass the check and then decrement a row that is no longer eligible.
export async function consumeGrant(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  amount: number,
  asOf: Date,
): Promise<GrantRecord | null> {
  const updated = await client.query(
    `UPDATE grants
     SET remaining_amount = remaining_amount - $3::numeric
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
       AND $4::timestamptz >= start_date
       AND (expiry_date IS NULL OR $4::timestamptz < expiry_date)
       AND remaining_amount >= $3::numeric
     RETURNING id`,
    [grantId, tenantId, String(amount), asOf],
  );
  if ((updated.rowCount ?? 0) === 0) return null;
  const grant = await readGrant(client, tenantId, grantId);
  if (!grant) throw new Error("consumed grant was not readable");
  return grant;
}

export async function amendCommit(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  changes: AmendCommitChanges,
): Promise<{ before: GrantRecord; after: GrantRecord } | null> {
  const before = await readGrant(client, tenantId, grantId);
  if (!before || before.status !== "active" || before.source !== "commit") return null;
  const sets: string[] = [];
  const values: unknown[] = [grantId, tenantId];
  if (changes.overage_rate !== undefined) {
    values.push(String(changes.overage_rate));
    sets.push(`overage_rate = $${values.length}::numeric`);
  }
  if (changes.expiry_date !== undefined) {
    values.push(changes.expiry_date);
    sets.push(`expiry_date = $${values.length}`);
  }
  if (changes.carries_over !== undefined) {
    values.push(changes.carries_over);
    sets.push(`carries_over = $${values.length}`);
  }
  if (sets.length === 0) return null;
  const updated = await client.query(
    `UPDATE grants SET ${sets.join(", ")}
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
     RETURNING id`,
    values,
  );
  if ((updated.rowCount ?? 0) === 0) return null;
  const after = await readGrant(client, tenantId, grantId);
  if (!after) throw new Error("amended commit was not readable");
  return { before, after };
}

export async function voidGrant(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  reason: string,
): Promise<GrantRecord | null> {
  const updated = await client.query<{ amount: string }>(
    `UPDATE grants
     SET status = 'void'
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
     RETURNING amount::text AS amount`,
    [grantId, tenantId],
  );
  if ((updated.rowCount ?? 0) === 0) return null;
  await client.query(
    `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount, reason)
     VALUES ($1, $2, 'voided', -$3::numeric, $4)`,
    [tenantId, grantId, updated.rows[0].amount, reason],
  );
  const grant = await readGrant(client, tenantId, grantId);
  if (!grant) throw new Error("voided grant was not readable");
  return grant;
}

export async function insertGrantTemplate(
  client: PoolClient,
  tenantId: string,
  createdByUserId: string,
  input: CreateTemplateInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO recurring_grant_templates (
       tenant_id, customer_id, amount, unit, source, interval, created_by_user_id
     ) VALUES ($1, $2, $3::numeric, $4, $5, $6, $7)
     RETURNING id`,
    [tenantId, input.customer_id, String(input.amount), input.unit, input.source, input.interval, createdByUserId],
  );
  return rows[0].id;
}

export async function readGrantTemplate(
  client: PoolClient,
  tenantId: string,
  templateId: string,
): Promise<GrantTemplateRecord | null> {
  const row = (await client.query<TemplateQueryRow>(
    `SELECT ${TEMPLATE_SELECT}
     FROM recurring_grant_templates t
     LEFT JOIN users creator ON creator.id = t.created_by_user_id
     WHERE t.id = $1 AND t.tenant_id = $2`,
    [templateId, tenantId],
  )).rows[0];
  return row ? shapeTemplateRecord(row) : null;
}

export async function listLedgerEntries(
  client: PoolClient,
  tenantId: string,
  filters: LedgerFilters,
  cursor: string | null,
  limit: number,
): Promise<LedgerEntry[]> {
  const values: unknown[] = [tenantId];
  const where = ["e.tenant_id = $1"];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };
  if (filters.grantId) add("e.grant_id = ?", filters.grantId);
  if (filters.customerId) add("g.customer_id = ?", filters.customerId);
  if (filters.from) add("e.occurred_at >= ?", filters.from);
  if (filters.to) add("e.occurred_at <= ?", filters.to);
  if (filters.entryType) add("e.entry_type = ?", filters.entryType);
  if (filters.source) add("g.source = ?", filters.source);
  if (cursor) add("e.id > ?", cursor);
  values.push(limit);
  const rows = (await client.query<LedgerQueryRow>(
    `SELECT e.id, e.grant_id, e.entry_type, e.amount, e.reason, e.occurred_at
     FROM grant_ledger_entries e
     JOIN grants g ON g.id = e.grant_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.id
     LIMIT $${values.length}`,
    values,
  )).rows;
  return rows.map(shapeLedgerEntry);
}
