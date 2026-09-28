import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { parseAsOf } from "./grants.js";

export const CONSUMPTION_SOURCES = ["promotional", "paid", "commit", "goodwill"] as const;
export type ConsumptionSource = (typeof CONSUMPTION_SOURCES)[number];

// goodwill is last among real grant categories: the acceptance criteria name
// promotional, paid, commit, then overage, and do not place goodwill.
export const DEFAULT_CONSUMPTION_ORDER: readonly ConsumptionSource[] = [
  "promotional",
  "paid",
  "commit",
  "goodwill",
];

export const CONSUMPTION_ORDER_ERROR =
  "consumption_order must be a permutation of promotional, paid, commit, goodwill";

export interface CustomerConsumeInput {
  amount: number;
  unit: string;
  as_of: Date;
}

export interface ConsumptionLine {
  grant_id: string | null;
  source_category: string;
  amount: number;
  overage_amount_due?: number;
}

export interface ConsumptionRecord {
  id: string;
  customer_id: string;
  requested_amount: number;
  unit: string;
  occurred_at: string;
  lines: ConsumptionLine[];
}

export interface DrawableGrant {
  id: string;
  source: ConsumptionSource;
  expiry_date: Date | null;
  created_at: Date;
  remaining_amount: number;
  overage_rate: number | null;
}

interface LockedGrantRow {
  id: string;
  remaining_amount: string;
  source: ConsumptionSource;
  expiry_date: Date | string | null;
  created_at: Date | string;
  overage_rate: string | null;
}

interface ConsumptionRow {
  id: string;
  customer_id: string;
  requested_amount: string;
  unit: string;
  occurred_at: Date | string;
}

interface ConsumptionLineRow {
  consumption_id: string;
  grant_id: string | null;
  source_category: string;
  amount: string;
  overage_amount_due: string | null;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function isSource(value: string): value is ConsumptionSource {
  return (CONSUMPTION_SOURCES as readonly string[]).includes(value);
}

export function validateConsumptionOrder(value: unknown): { error: string } | { value: ConsumptionSource[] } {
  if (!Array.isArray(value) || value.length !== CONSUMPTION_SOURCES.length) {
    return { error: CONSUMPTION_ORDER_ERROR };
  }
  const seen = new Set<string>();
  const order: ConsumptionSource[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isSource(entry) || seen.has(entry)) {
      return { error: CONSUMPTION_ORDER_ERROR };
    }
    seen.add(entry);
    order.push(entry);
  }
  return { value: order };
}

export function validateCustomerConsumeInput(body: unknown): { error: string } | CustomerConsumeInput {
  const record = asRecord(body);
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount) || record.amount <= 0) {
    return { error: "amount must be a positive finite number" };
  }
  if (typeof record.unit !== "string" || record.unit.trim() === "") return { error: "unit is required" };
  const asOf = parseAsOf(record.as_of);
  if ("error" in asOf) return asOf;
  return { amount: record.amount, unit: record.unit.trim(), as_of: asOf.value };
}

function parseStoredOrder(value: string[] | null | undefined): ConsumptionSource[] | null {
  if (value == null) return null;
  const parsed = validateConsumptionOrder(value);
  return "error" in parsed ? null : parsed.value;
}

// Customer override, then the customer's plan order, then the default.
// An order applies only when every source it names currently has an eligible
// grant. Otherwise that candidate is skipped. T18-T9 is the override case.
export function resolveEffectiveOrder(
  override: readonly ConsumptionSource[] | null,
  planOrder: readonly ConsumptionSource[] | null,
  eligibleSources: ReadonlySet<string>,
): ConsumptionSource[] {
  if (override && override.every((source) => eligibleSources.has(source))) return [...override];
  if (planOrder && planOrder.every((source) => eligibleSources.has(source))) return [...planOrder];
  return [...DEFAULT_CONSUMPTION_ORDER];
}

function compareExpiry(left: Date | null, right: Date | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.getTime() - right.getTime();
}

// Category rank follows the resolved order. Within a category, soonest expiry
// is first and a null expiry is last. created_at then id make the order total
// when expiry ties, including inside promotional.
export function sortGrantsForDraw<T extends DrawableGrant>(grants: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((source, index) => [source, index]));
  return [...grants].sort((left, right) => {
    const leftRank = rank.get(left.source) ?? order.length;
    const rightRank = rank.get(right.source) ?? order.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const expiry = compareExpiry(left.expiry_date, right.expiry_date);
    if (expiry !== 0) return expiry;
    const created = left.created_at.getTime() - right.created_at.getTime();
    if (created !== 0) return created;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

// The usage line table has no position column. UUIDv7 ids increase with
// insert order, so a later read can ORDER BY id and get draw order back.
let lineSequence = 0;
export function orderedUuid(): string {
  const ms = BigInt(Date.now());
  const seq = lineSequence++ & 0xfff;
  const bytes = randomBytes(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readCustomerOverride(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<ConsumptionSource[] | null> {
  const { rows } = await client.query<{ consumption_order: string[] | null }>(
    `SELECT consumption_order
     FROM customer_consumption_overrides
     WHERE customer_id = $1 AND tenant_id = $2`,
    [customerId, tenantId],
  );
  return parseStoredOrder(rows[0]?.consumption_order ?? null);
}

// No customer-to-plan assignment exists. The subquery is the missing plan id:
// it references the customer and yields NULL, so this read of
// plans.consumption_order matches nothing. A later story replaces the NULL
// with the assignment column; the plans read itself is already the real query.
export async function readPlanOrderForCustomer(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<ConsumptionSource[] | null> {
  const { rows } = await client.query<{ consumption_order: string[] | null }>(
    `SELECT p.consumption_order
     FROM plans p
     WHERE p.tenant_id = $1
       AND p.id = (
         SELECT NULL::uuid
         FROM customers c
         WHERE c.id = $2 AND c.tenant_id = p.tenant_id
       )`,
    [tenantId, customerId],
  );
  return parseStoredOrder(rows[0]?.consumption_order ?? null);
}

export async function upsertCustomerOverride(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  userId: string,
  order: ConsumptionSource[],
): Promise<{ id: string; consumption_order: ConsumptionSource[]; previous: ConsumptionSource[] | null }> {
  const previous = await readCustomerOverride(client, tenantId, customerId);
  const { rows } = await client.query<{ id: string; consumption_order: string[] }>(
    `INSERT INTO customer_consumption_overrides (
       tenant_id, customer_id, consumption_order, created_by_user_id
     ) VALUES ($1, $2, $3::text[], $4)
     ON CONFLICT (customer_id) DO UPDATE
       SET consumption_order = EXCLUDED.consumption_order,
           updated_at = now()
     RETURNING id, consumption_order`,
    [tenantId, customerId, order, userId],
  );
  const stored = parseStoredOrder(rows[0].consumption_order);
  if (!stored) throw new Error("stored consumption_order was not readable");
  return { id: rows[0].id, consumption_order: stored, previous };
}

async function lockEligibleGrants(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  asOf: Date,
): Promise<DrawableGrant[]> {
  // ORDER BY id makes every concurrent consume lock this customer's rows in
  // the same order. created_at is selected because the draw sort needs it.
  const { rows } = await client.query<LockedGrantRow>(
    `SELECT id, remaining_amount::text AS remaining_amount, source, expiry_date, created_at,
            overage_rate::text AS overage_rate
     FROM grants
     WHERE customer_id = $1
       AND tenant_id = $2
       AND status = 'active'
       AND start_date <= $3::timestamptz
       AND (expiry_date IS NULL OR expiry_date > $3::timestamptz)
       AND remaining_amount > 0
     ORDER BY id
     FOR UPDATE`,
    [customerId, tenantId, asOf],
  );
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    expiry_date: asDate(row.expiry_date),
    created_at: asDate(row.created_at) as Date,
    remaining_amount: Number(row.remaining_amount),
    overage_rate: row.overage_rate === null ? null : Number(row.overage_rate),
  }));
}

export async function consumeAcrossGrants(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  input: CustomerConsumeInput,
): Promise<ConsumptionRecord> {
  const locked = await lockEligibleGrants(client, tenantId, customerId, input.as_of);
  const eligible = new Set(locked.map((grant) => grant.source));
  const override = await readCustomerOverride(client, tenantId, customerId);
  const planOrder = await readPlanOrderForCustomer(client, tenantId, customerId);
  const order = resolveEffectiveOrder(override, planOrder, eligible);
  const sorted = sortGrantsForDraw(locked, order);

  const parent = (await client.query<ConsumptionRow>(
    `INSERT INTO usage_consumptions (id, tenant_id, customer_id, requested_amount, unit)
     VALUES ($1, $2, $3, $4::numeric, $5)
     RETURNING id, customer_id, requested_amount::text AS requested_amount, unit, occurred_at`,
    [orderedUuid(), tenantId, customerId, String(input.amount), input.unit],
  )).rows[0];

  let needed = input.amount;
  let lastCommitOverageRate: number | null = null;
  const lines: ConsumptionLine[] = [];
  for (const grant of sorted) {
    if (needed <= 0) break;
    const take = Math.min(needed, grant.remaining_amount);
    if (!(take > 0)) continue;
    const updated = await client.query(
      `UPDATE grants
       SET remaining_amount = remaining_amount - $3::numeric
       WHERE id = $1 AND tenant_id = $2 AND remaining_amount >= $3::numeric`,
      [grant.id, tenantId, String(take)],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error(`grant ${grant.id} draw of ${take} did not apply`);
    needed -= take;
    if (grant.source === "commit") lastCommitOverageRate = grant.overage_rate;
    lines.push({ grant_id: grant.id, source_category: grant.source, amount: take });
    await client.query(
      `INSERT INTO usage_consumption_lines (
         id, tenant_id, consumption_id, grant_id, source_category, amount
       ) VALUES ($1, $2, $3, $4, $5, $6::numeric)`,
      [orderedUuid(), tenantId, parent.id, grant.id, grant.source, String(take)],
    );
  }
  if (needed > 0) {
    const overage: ConsumptionLine = { grant_id: null, source_category: "overage", amount: needed };
    const overageAmountDue = lastCommitOverageRate === null ? null : needed * lastCommitOverageRate;
    if (overageAmountDue !== null) overage.overage_amount_due = overageAmountDue;
    lines.push(overage);
    await client.query(
      `INSERT INTO usage_consumption_lines (
         id, tenant_id, consumption_id, grant_id, source_category, amount, overage_amount_due
       ) VALUES ($1, $2, $3, NULL, 'overage', $4::numeric, $5::numeric)`,
      [orderedUuid(), tenantId, parent.id, String(needed), overageAmountDue === null ? null : String(overageAmountDue)],
    );
  }

  return {
    id: parent.id,
    customer_id: parent.customer_id,
    requested_amount: Number(parent.requested_amount),
    unit: parent.unit,
    occurred_at: toIso(parent.occurred_at),
    lines,
  };
}

export async function listConsumptionTimeline(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  cursor: string | null,
  limit: number,
): Promise<ConsumptionRecord[]> {
  const values: unknown[] = [tenantId, customerId];
  let cursorClause = "";
  if (cursor) {
    values.push(cursor);
    cursorClause = `AND c.id > $${values.length}`;
  }
  values.push(limit);
  const parents = (await client.query<ConsumptionRow>(
    `SELECT c.id, c.customer_id, c.requested_amount::text AS requested_amount, c.unit, c.occurred_at
     FROM usage_consumptions c
     WHERE c.tenant_id = $1 AND c.customer_id = $2 ${cursorClause}
     ORDER BY c.id
     LIMIT $${values.length}`,
    values,
  )).rows;
  if (parents.length === 0) return [];

  const ids = parents.map((row) => row.id);
  const lineRows = (await client.query<ConsumptionLineRow>(
    `SELECT consumption_id, grant_id, source_category, amount::text AS amount,
            overage_amount_due::text AS overage_amount_due
     FROM usage_consumption_lines
     WHERE tenant_id = $1 AND consumption_id = ANY($2::uuid[])
     ORDER BY id`,
    [tenantId, ids],
  )).rows;
  const grouped = new Map<string, ConsumptionLine[]>();
  for (const id of ids) grouped.set(id, []);
  for (const line of lineRows) {
    const shaped: ConsumptionLine = {
      grant_id: line.grant_id,
      source_category: line.source_category,
      amount: Number(line.amount),
    };
    if (line.overage_amount_due !== null) shaped.overage_amount_due = Number(line.overage_amount_due);
    grouped.get(line.consumption_id)?.push(shaped);
  }
  return parents.map((row) => ({
    id: row.id,
    customer_id: row.customer_id,
    requested_amount: Number(row.requested_amount),
    unit: row.unit,
    occurred_at: toIso(row.occurred_at),
    lines: grouped.get(row.id) ?? [],
  }));
}
