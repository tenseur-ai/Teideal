import type { Pool, PoolClient } from "pg";
import { withTenant } from "./db.js";
import { sendEmail, sendSlackAlert } from "./notify.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 60 * 1000;
const INSERT_CHUNK = 2000;

export type ChannelStatus = "sent" | "failed" | "skipped";

export interface DeliveryStatus {
  operator_email: ChannelStatus;
  slack: ChannelStatus;
  customer_email: ChannelStatus;
}

export interface BalanceAlertEvaluation {
  recorded: number;
  uniqueConflicts: number;
}

interface CandidateRow {
  grant_id: string;
  customer_id: string;
  customer_name: string;
  amount: string;
  remaining_amount: string;
  start_date: Date | string;
  threshold_pct: number | string;
  operator_emails: string[] | null;
  slack_webhook_url: string | null;
  notify_customer: boolean;
  customer_email: string | null;
  using_default: boolean;
  billing_timezone: string;
  billing_anchor_day: number | string;
}

interface Candidate {
  grantId: string;
  customerId: string;
  customerName: string;
  amount: string;
  remainingAmount: string;
  startDate: Date;
  thresholdPct: number;
  operatorEmails: string[];
  slackWebhookUrl: string | null;
  notifyCustomer: boolean;
  customerEmail: string | null;
  usingDefault: boolean;
  periodStart: string;
}

interface SentInsert {
  tenantId: string;
  customerId: string;
  grantId: string;
  thresholdPct: number;
  periodStart: string;
  deliveryStatus: DeliveryStatus;
}

interface AlertContent {
  text: string;
  customer_name: string;
  customer_id: string;
  grant_id: string;
  threshold_pct: number;
  remaining_amount: number | string;
  amount: number | string;
  projected_run_out_date: string | null;
  projection_method: "linear_7d_average";
  period_start: string;
}

const SKIPPED: DeliveryStatus = {
  operator_email: "skipped",
  slack: "skipped",
  customer_email: "skipped",
};

export function balanceAlertIntervalMs(): number {
  const raw = process.env.BALANCE_ALERT_INTERVAL_MS;
  if (raw === undefined || raw === "") return 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`invalid BALANCE_ALERT_INTERVAL_MS ${JSON.stringify(raw)}; using 60000`);
    return 60_000;
  }
  return parsed;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localYmd(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

// Customer's current billing-period start as a DATE. Anchor and zone come
// from customer_billing_config; missing config is UTC, day 1. The hot path
// stays in this process instead of calling go-usage's period resolver.
export function billingPeriodStart(now: Date, timeZone: string, anchorDay: number): string {
  const anchor = anchorDay >= 1 && anchorDay <= 31 ? anchorDay : 1;
  let year: number;
  let month: number;
  let day: number;
  try {
    ({ year, month, day } = localYmd(now, timeZone || "UTC"));
  } catch {
    console.error(JSON.stringify({ event: "balance_alert_invalid_timezone", timeZone }));
    ({ year, month, day } = localYmd(now, "UTC"));
  }
  const boundaryDay = (y: number, m: number) => Math.min(anchor, lastDayOfMonth(y, m));
  let startYear = year;
  let startMonth = month;
  if (day < boundaryDay(year, month)) {
    startMonth -= 1;
    if (startMonth < 1) {
      startMonth = 12;
      startYear -= 1;
    }
  }
  const startDay = boundaryDay(startYear, startMonth);
  return `${startYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
}

function numericToJson(value: string): number | string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return value;
  // Numeric columns often come back with a scale ("2000.000"). Whole numbers
  // are the amounts the alert contract shows.
  if (Number.isInteger(parsed)) return parsed;
  return String(parsed) === trimmed ? parsed : value;
}

function dedupKey(grantId: string, thresholdPct: number, periodStart: string): string {
  return `${grantId}:${thresholdPct}:${periodStart}`;
}

function hasChannels(candidate: Candidate): boolean {
  return candidate.operatorEmails.length > 0 || candidate.slackWebhookUrl !== null || candidate.notifyCustomer;
}

async function tenantIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
  return rows.map((row) => row.id);
}

async function loadCandidates(client: PoolClient, tenantId: string): Promise<CandidateRow[]> {
  const { rows } = await client.query<CandidateRow>(
    `SELECT g.id AS grant_id,
            g.customer_id,
            c.name AS customer_name,
            g.amount::text AS amount,
            g.remaining_amount::text AS remaining_amount,
            g.start_date,
            pct::int AS threshold_pct,
            CASE WHEN cust.id IS NOT NULL THEN cust.operator_emails
                 WHEN plan_cfg.id IS NOT NULL THEN plan_cfg.operator_emails
                 ELSE ARRAY[]::text[] END AS operator_emails,
            CASE WHEN cust.id IS NOT NULL THEN cust.slack_webhook_url
                 WHEN plan_cfg.id IS NOT NULL THEN plan_cfg.slack_webhook_url
                 ELSE NULL END AS slack_webhook_url,
            CASE WHEN cust.id IS NOT NULL THEN cust.notify_customer
                 WHEN plan_cfg.id IS NOT NULL THEN plan_cfg.notify_customer
                 ELSE false END AS notify_customer,
            CASE WHEN cust.id IS NOT NULL THEN cust.customer_email
                 WHEN plan_cfg.id IS NOT NULL THEN plan_cfg.customer_email
                 ELSE NULL END AS customer_email,
            (cust.id IS NULL AND plan_cfg.id IS NULL) AS using_default,
            COALESCE(cfg.billing_timezone, 'UTC') AS billing_timezone,
            COALESCE(cfg.billing_anchor_day, 1) AS billing_anchor_day
     FROM grants g
     JOIN customers c ON c.id = g.customer_id AND c.tenant_id = g.tenant_id
     LEFT JOIN customer_plan_subscriptions sub
       ON sub.customer_id = g.customer_id AND sub.tenant_id = g.tenant_id
     LEFT JOIN customer_billing_config cfg
       ON cfg.customer_id = g.customer_id AND cfg.tenant_id = g.tenant_id
     LEFT JOIN billing_alert_thresholds cust
       ON cust.tenant_id = g.tenant_id AND cust.scope = 'customer' AND cust.scope_id = g.customer_id
     LEFT JOIN billing_alert_thresholds plan_cfg
       ON plan_cfg.tenant_id = g.tenant_id AND plan_cfg.scope = 'plan' AND plan_cfg.scope_id = sub.current_plan_id
     CROSS JOIN LATERAL unnest(
       CASE WHEN cust.id IS NOT NULL THEN cust.threshold_pcts
            WHEN plan_cfg.id IS NOT NULL THEN plan_cfg.threshold_pcts
            ELSE ARRAY[50, 80, 100]::smallint[] END
     ) AS pct
     WHERE g.tenant_id = $1
       AND g.status = 'active'
       AND (g.amount - g.remaining_amount) * 100 >= pct::numeric * g.amount`,
    [tenantId],
  );
  return rows;
}

async function loadExistingKeys(client: PoolClient, tenantId: string, periods: string[]): Promise<Set<string>> {
  if (periods.length === 0) return new Set();
  const { rows } = await client.query<{ grant_id: string; threshold_pct: number; period_start: string }>(
    `SELECT grant_id::text AS grant_id, threshold_pct::int AS threshold_pct, period_start::text AS period_start
     FROM billing_alert_sent
     WHERE tenant_id = $1 AND period_start = ANY($2::date[])`,
    [tenantId, periods],
  );
  return new Set(rows.map((row) => dedupKey(row.grant_id, Number(row.threshold_pct), row.period_start)));
}

function shapeCandidates(rows: CandidateRow[], now: Date): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const thresholdPct = Number(row.threshold_pct);
    const periodStart = billingPeriodStart(now, row.billing_timezone, Number(row.billing_anchor_day));
    const key = dedupKey(row.grant_id, thresholdPct, periodStart);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      grantId: row.grant_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      amount: row.amount,
      remainingAmount: row.remaining_amount,
      startDate: asDate(row.start_date),
      thresholdPct,
      operatorEmails: row.operator_emails ?? [],
      slackWebhookUrl: row.slack_webhook_url,
      notifyCustomer: row.notify_customer,
      customerEmail: row.customer_email,
      usingDefault: row.using_default,
      periodStart,
    });
  }
  return candidates;
}

// Draw rate for the run-out estimate. Consumption is recorded on
// usage_consumption_lines; grant_ledger_entries has no consumption entry
// type (issued/released add credit, expired/voided/carried_over close the
// grant). Negative non-closure ledger rows are included so a future draw
// entry type participates. A grant younger than 7 days with no dated draws
// falls back to amount - remaining over its own lifetime, which is what
// POST /grants/:id/consume leaves behind.
async function projectRunOut(client: PoolClient, candidate: Candidate, now: Date): Promise<{
  projected_run_out_date: string | null;
  projection_method: "linear_7d_average";
}> {
  const ageMs = now.getTime() - candidate.startDate.getTime();
  const young = ageMs < SEVEN_DAYS_MS;
  const windowStart = young ? candidate.startDate : new Date(now.getTime() - SEVEN_DAYS_MS);
  const drawnRow = await client.query<{ drawn: string }>(
    `SELECT (
       COALESCE((
         SELECT SUM(l.amount)
         FROM usage_consumption_lines l
         JOIN usage_consumptions u ON u.id = l.consumption_id
         WHERE l.grant_id = $1 AND u.occurred_at >= $2 AND u.occurred_at <= $3
       ), 0)
       +
       COALESCE((
         SELECT SUM(-e.amount)
         FROM grant_ledger_entries e
         WHERE e.grant_id = $1
           AND e.amount < 0
           AND e.entry_type NOT IN ('expired', 'voided', 'carried_over')
           AND e.occurred_at >= $2 AND e.occurred_at <= $3
       ), 0)
     )::text AS drawn`,
    [candidate.grantId, windowStart, now],
  );
  let drawn = Number(drawnRow.rows[0]?.drawn ?? "0");
  let windowMs = Math.max(now.getTime() - windowStart.getTime(), MIN_WINDOW_MS);
  if (!(drawn > 0) && young) {
    const implied = Number(candidate.amount) - Number(candidate.remainingAmount);
    if (implied > 0) {
      drawn = implied;
      windowMs = Math.max(ageMs, MIN_WINDOW_MS);
    }
  }
  const remaining = Number(candidate.remainingAmount);
  if (!(drawn > 0) || !Number.isFinite(remaining)) {
    return { projected_run_out_date: null, projection_method: "linear_7d_average" };
  }
  const runOut = new Date(now.getTime() + remaining / (drawn / windowMs));
  return { projected_run_out_date: runOut.toISOString(), projection_method: "linear_7d_average" };
}

function alertContent(candidate: Candidate, projection: {
  projected_run_out_date: string | null;
  projection_method: "linear_7d_average";
}): AlertContent {
  const remaining = numericToJson(candidate.remainingAmount);
  const amount = numericToJson(candidate.amount);
  const dateText = projection.projected_run_out_date ?? "null";
  return {
    text: `Customer ${candidate.customerName} reached threshold_pct ${candidate.thresholdPct}. remaining_amount ${remaining}. projected_run_out_date ${dateText}. projection_method ${projection.projection_method}.`,
    customer_name: candidate.customerName,
    customer_id: candidate.customerId,
    grant_id: candidate.grantId,
    threshold_pct: candidate.thresholdPct,
    remaining_amount: remaining,
    amount,
    projected_run_out_date: projection.projected_run_out_date,
    projection_method: projection.projection_method,
    period_start: candidate.periodStart,
  };
}

function logDeliveryFailure(tenantId: string, candidate: Candidate, channel: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    event: "balance_alert_delivery_failed",
    tenant_id: tenantId,
    customer_id: candidate.customerId,
    customer_name: candidate.customerName,
    grant_id: candidate.grantId,
    threshold_pct: candidate.thresholdPct,
    period_start: candidate.periodStart,
    channel,
    error: message,
  }));
}

async function deliver(pool: Pool, tenantId: string, candidate: Candidate, now: Date): Promise<DeliveryStatus> {
  const projection = await withTenant(pool, tenantId, (client) => projectRunOut(client, candidate, now));
  const content = alertContent(candidate, projection);
  const body = JSON.stringify(content);
  const subject = `Balance alert: ${candidate.customerName} reached ${candidate.thresholdPct}%`;
  const status: DeliveryStatus = {
    operator_email: candidate.operatorEmails.length > 0 ? "sent" : "skipped",
    slack: candidate.slackWebhookUrl !== null ? "sent" : "skipped",
    customer_email: candidate.notifyCustomer ? "sent" : "skipped",
  };

  if (candidate.operatorEmails.length > 0) {
    try {
      for (const email of candidate.operatorEmails) {
        await sendEmail(pool, tenantId, email, subject, body);
      }
    } catch (error) {
      status.operator_email = "failed";
      logDeliveryFailure(tenantId, candidate, "operator_email", error);
    }
  }

  if (candidate.slackWebhookUrl !== null) {
    try {
      await sendSlackAlert(candidate.slackWebhookUrl, content);
    } catch (error) {
      status.slack = "failed";
      logDeliveryFailure(tenantId, candidate, "slack", error);
    }
  }

  if (candidate.notifyCustomer) {
    if (!candidate.customerEmail) {
      status.customer_email = "failed";
      logDeliveryFailure(tenantId, candidate, "customer_email", new Error("customer_email is not configured"));
    } else {
      try {
        await sendEmail(pool, tenantId, candidate.customerEmail, subject, body);
      } catch (error) {
        status.customer_email = "failed";
        logDeliveryFailure(tenantId, candidate, "customer_email", error);
      }
    }
  }

  return status;
}

// Claims each candidate's dedup slot atomically via INSERT ... ON CONFLICT
// DO NOTHING, BEFORE any delivery is attempted -- this is what actually
// prevents two overlapping evaluation ticks (a slow tick overlapping the
// next scheduled one, or multiple ts-console replicas with no distributed
// lock) from both sending the same real alert. The UNIQUE constraint alone
// only dedupes the *recorded row*; if delivery happened first and the claim
// second (as an earlier version of this function did), two ticks that both
// read "not yet sent" before either commits its insert both independently
// deliver, and only one row survives -- correct bookkeeping, duplicate
// alerts. Every claimed row starts with a placeholder SKIPPED status;
// updateDeliveryStatus overwrites it with the real outcome once (and only
// once) the winning tick actually attempts delivery.
async function claimSlots(client: PoolClient, rows: SentInsert[]): Promise<Set<string>> {
  const won = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK);
    const { rows: returned } = await client.query<{ grant_id: string; threshold_pct: number; period_start: string }>(
      `INSERT INTO billing_alert_sent
         (tenant_id, customer_id, grant_id, threshold_pct, period_start, delivery_status)
       SELECT t, c, g, p, d, s::jsonb
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::smallint[], $5::date[], $6::text[])
         AS x(t, c, g, p, d, s)
       ON CONFLICT (tenant_id, grant_id, threshold_pct, period_start) DO NOTHING
       RETURNING grant_id::text AS grant_id, threshold_pct::int AS threshold_pct, period_start::text AS period_start`,
      [
        chunk.map((row) => row.tenantId),
        chunk.map((row) => row.customerId),
        chunk.map((row) => row.grantId),
        chunk.map((row) => row.thresholdPct),
        chunk.map((row) => row.periodStart),
        chunk.map((row) => JSON.stringify(row.deliveryStatus)),
      ],
    );
    for (const row of returned) won.add(dedupKey(row.grant_id, row.threshold_pct, row.period_start));
  }
  return won;
}

async function updateDeliveryStatus(
  client: PoolClient,
  tenantId: string,
  key: { grantId: string; thresholdPct: number; periodStart: string },
  status: DeliveryStatus,
): Promise<void> {
  await client.query(
    `UPDATE billing_alert_sent SET delivery_status = $1::jsonb
     WHERE tenant_id = $2 AND grant_id = $3 AND threshold_pct = $4 AND period_start = $5`,
    [JSON.stringify(status), tenantId, key.grantId, key.thresholdPct, key.periodStart],
  );
}

async function evaluateTenant(pool: Pool, tenantId: string, now: Date): Promise<BalanceAlertEvaluation> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const rows = shapeCandidates(await loadCandidates(client, tenantId), now);
    const periods = [...new Set(rows.map((row) => row.periodStart))];
    const existing = await loadExistingKeys(client, tenantId, periods);
    return { rows, existing };
  });

  // This is a fast-path filter only, not the dedup authority -- a
  // concurrent tick can still see the same key as "fresh" here. claimSlots
  // below is what actually decides, atomically, which tick (if any) gets to
  // deliver.
  const fresh = loaded.rows.filter((row) => !loaded.existing.has(dedupKey(row.grantId, row.thresholdPct, row.periodStart)));
  const preexistingDuplicates = loaded.rows.length - fresh.length;

  const placeholders: SentInsert[] = fresh.map((row) => ({
    tenantId,
    customerId: row.customerId,
    grantId: row.grantId,
    thresholdPct: row.thresholdPct,
    periodStart: row.periodStart,
    deliveryStatus: SKIPPED,
  }));
  const wonKeys = await withTenant(pool, tenantId, (client) => claimSlots(client, placeholders));
  const won = fresh.filter((row) => wonKeys.has(dedupKey(row.grantId, row.thresholdPct, row.periodStart)));
  const lostClaim = fresh.length - won.length;

  const toDeliver = won.filter(hasChannels);
  const noChannel = won.filter((row) => !hasChannels(row));

  if (noChannel.length > 0) {
    console.info(JSON.stringify({
      event: "balance_alerts_recorded_without_delivery_channels",
      tenant_id: tenantId,
      count: noChannel.length,
      sample: noChannel.slice(0, 5).map((row) => ({
        customer_id: row.customerId,
        customer_name: row.customerName,
        grant_id: row.grantId,
        threshold_pct: row.thresholdPct,
        period_start: row.periodStart,
        using_default: row.usingDefault,
      })),
    }));
  }

  // noChannel rows already carry their final (SKIPPED) status from the
  // claim insert -- only toDeliver's rows need a follow-up UPDATE once
  // delivery actually completes.
  for (const candidate of toDeliver) {
    const deliveryStatus = await deliver(pool, tenantId, candidate, now);
    await withTenant(pool, tenantId, (client) => updateDeliveryStatus(client, tenantId, candidate, deliveryStatus));
  }

  return {
    recorded: won.length,
    uniqueConflicts: preexistingDuplicates + lostClaim,
  };
}

export async function evaluateBalanceAlerts(pool: Pool, now = new Date()): Promise<BalanceAlertEvaluation> {
  let recorded = 0;
  let uniqueConflicts = 0;
  for (const tenantId of await tenantIds(pool)) {
    try {
      const stats = await evaluateTenant(pool, tenantId, now);
      recorded += stats.recorded;
      uniqueConflicts += stats.uniqueConflicts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`balance alerts for tenant ${tenantId} failed: ${message}`, { cause: error });
    }
  }
  return { recorded, uniqueConflicts };
}
