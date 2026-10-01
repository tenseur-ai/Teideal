import type { Pool, PoolClient } from "pg";
import { ConnectorError } from "./connectors/connector.js";
import {
  connectorBackoffDelayMs,
  createConnectorHttpClient,
  type ConnectorHttpClient,
} from "./connectors/httpClient.js";
import { withTenant } from "./db.js";
import {
  compareDecimalStrings,
  decimalToMinorUnits,
  isZeroDecimal,
  loadPeriodCloseConsumption,
  buildPeriodCloseInvoiceTotals,
  type InvoiceSyncCategory,
  type PeriodCloseInvoiceTotals,
} from "./periodCloseSummary.js";
import { stripeApiBaseUrl } from "./stripeCustomers.js";
import {
  assertWriteScope,
  requireConnectedAccessToken,
  StripeConnectionClosedError,
  StripeScopeError,
  type StripeConnectionSecrets,
} from "./stripeConnect.js";
import { emitWebhookEvent } from "./webhooks.js";

export const PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS = 5;
export const PERIOD_CLOSE_STRIPE_BASE_DELAY_MS = 1_000;
export const PERIOD_CLOSE_STRIPE_MAX_DELAY_MS = 60_000;
export const PERIOD_CLOSE_STRIPE_REQUESTS_PER_MINUTE = 6_000;
export const PERIOD_CLOSE_SYNC_STALL_MS = 60 * 60 * 1000;
export const LEDGER_TOTAL_CHANGED = "ledger total changed during sync";

const CATEGORIES: InvoiceSyncCategory[] = ["usage", "overage"];

export class PeriodCloseInvoiceSyncError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "PeriodCloseInvoiceSyncError";
  }
}

export interface PeriodCloseInvoiceLineItem {
  id: string;
  customer_id: string;
  period_start: string;
  period_end: string;
  category: InvoiceSyncCategory;
  stripe_invoice_item_id: string;
  amount: string;
  ledger_reference: string;
  created_at: string;
}

export interface PeriodCloseInvoiceSyncResult {
  alreadySynced: boolean;
  attemptId: string | null;
  status: "running" | "succeeded" | "failed" | "already_synced";
  errorMessage: string | null;
  lineItems: PeriodCloseInvoiceLineItem[];
}

export interface SyncPeriodCloseInvoiceInput {
  pool: Pool;
  tenantId: string;
  customerId: string;
  periodStart: string;
  periodEnd: string;
  httpClient?: ConnectorHttpClient;
  beforeStripeWrite?: () => Promise<void>;
}

interface LineItemRow {
  id: string;
  customer_id: string;
  period_start: Date | string;
  period_end: Date | string;
  category: InvoiceSyncCategory;
  stripe_invoice_item_id: string;
  amount: string;
  ledger_reference: string;
  created_at: Date | string;
}

interface ConnectionRow extends StripeConnectionSecrets {
  id: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export function periodCloseInvoiceSyncIntervalMs(): number {
  const raw = process.env.PERIOD_CLOSE_INVOICE_SYNC_INTERVAL_MS;
  if (raw === undefined || raw === "") return PERIOD_CLOSE_SYNC_STALL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`invalid PERIOD_CLOSE_INVOICE_SYNC_INTERVAL_MS ${JSON.stringify(raw)}; using ${PERIOD_CLOSE_SYNC_STALL_MS}`);
    return PERIOD_CLOSE_SYNC_STALL_MS;
  }
  return parsed;
}

export function previousUtcCalendarMonthBounds(now: Date): { periodStart: string; periodEnd: string } {
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() };
}

export function buildLedgerReference(
  tenantId: string,
  customerId: string,
  periodStart: string,
  category: InvoiceSyncCategory,
): string {
  return `period-close:${tenantId}:${customerId}:${periodStart}:${category}`;
}

export function periodCloseStripeBackoffMs(attemptNumber: number): number {
  return connectorBackoffDelayMs(
    attemptNumber,
    PERIOD_CLOSE_STRIPE_BASE_DELAY_MS,
    PERIOD_CLOSE_STRIPE_MAX_DELAY_MS,
  );
}

function shapeLineItem(row: LineItemRow): PeriodCloseInvoiceLineItem {
  return {
    id: row.id,
    customer_id: row.customer_id,
    period_start: toIso(row.period_start),
    period_end: toIso(row.period_end),
    category: row.category,
    stripe_invoice_item_id: row.stripe_invoice_item_id,
    amount: row.amount,
    ledger_reference: row.ledger_reference,
    created_at: toIso(row.created_at),
  };
}

function totalsChanged(left: PeriodCloseInvoiceTotals, right: PeriodCloseInvoiceTotals): boolean {
  return compareDecimalStrings(left.usage.amount, right.usage.amount) !== 0
    || compareDecimalStrings(left.overage.amount, right.overage.amount) !== 0;
}

function createStripeWriteClient(): ConnectorHttpClient {
  return createConnectorHttpClient({
    baseUrl: stripeApiBaseUrl(),
    requestsPerMinute: PERIOD_CLOSE_STRIPE_REQUESTS_PER_MINUTE,
    maxAttempts: PERIOD_CLOSE_STRIPE_MAX_ATTEMPTS,
    baseDelayMs: PERIOD_CLOSE_STRIPE_BASE_DELAY_MS,
    maxDelayMs: PERIOD_CLOSE_STRIPE_MAX_DELAY_MS,
  });
}

async function loadLineItems(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  periodStart: string,
  periodEnd: string,
): Promise<PeriodCloseInvoiceLineItem[]> {
  const { rows } = await client.query<LineItemRow>(
    `SELECT id, customer_id, period_start, period_end, category,
            stripe_invoice_item_id, amount::text AS amount, ledger_reference, created_at
     FROM period_close_invoice_line_items
     WHERE tenant_id = $1 AND customer_id = $2 AND period_start = $3 AND period_end = $4
     ORDER BY category`,
    [tenantId, customerId, periodStart, periodEnd],
  );
  return rows.map(shapeLineItem);
}

async function loadTotals(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  periodStart: string,
  periodEnd: string,
): Promise<PeriodCloseInvoiceTotals> {
  const aggregates = await loadPeriodCloseConsumption(client, tenantId, periodStart, periodEnd, customerId);
  return buildPeriodCloseInvoiceTotals(aggregates);
}

async function completeAttempt(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
  status: "succeeded" | "failed",
  errorMessage: string | null,
): Promise<void> {
  await client.query(
    `UPDATE period_close_invoice_sync_attempts
     SET status = $1, completed_at = now(), error_message = $2
     WHERE id = $3 AND tenant_id = $4 AND status = 'running'`,
    [status, errorMessage, attemptId, tenantId],
  );
}

function stripeItemId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function syncPeriodCloseInvoice(
  input: SyncPeriodCloseInvoiceInput,
): Promise<PeriodCloseInvoiceSyncResult> {
  const client = await input.pool.connect();
  let attemptId: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`period-close-invoice:${input.tenantId}:${input.customerId}:${input.periodStart}:${input.periodEnd}`],
    );

    const customer = (await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`,
      [input.customerId, input.tenantId],
    )).rows[0];
    if (!customer) throw new PeriodCloseInvoiceSyncError("customer not found", 404);

    const existing = await loadLineItems(
      client,
      input.tenantId,
      input.customerId,
      input.periodStart,
      input.periodEnd,
    );
    const snapshot = await loadTotals(
      client,
      input.tenantId,
      input.customerId,
      input.periodStart,
      input.periodEnd,
    );
    const needed = CATEGORIES.filter((category) =>
      !isZeroDecimal(snapshot[category].amount) && !existing.some((row) => row.category === category),
    );
    if (needed.length === 0) {
      await client.query("COMMIT");
      return {
        alreadySynced: true,
        attemptId: null,
        status: "already_synced",
        errorMessage: null,
        lineItems: existing,
      };
    }

    const connection = (await client.query<ConnectionRow>(
      `SELECT id, status, scope, access_token_ciphertext, access_token_iv, access_token_auth_tag
       FROM stripe_connections
       WHERE status = 'connected'
       ORDER BY connected_at DESC
       LIMIT 1`,
    )).rows[0];
    if (!connection) throw new PeriodCloseInvoiceSyncError("stripe connection is not connected", 400);
    assertWriteScope(connection);
    const accessToken = requireConnectedAccessToken(connection);

    const link = (await client.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM stripe_customer_links WHERE customer_id = $1`,
      [input.customerId],
    )).rows[0];
    if (!link) throw new PeriodCloseInvoiceSyncError("customer is not linked to a Stripe customer", 400);

    const started = await client.query<{ id: string }>(
      `INSERT INTO period_close_invoice_sync_attempts (
         tenant_id, customer_id, period_start, period_end, status
       ) VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [input.tenantId, input.customerId, input.periodStart, input.periodEnd],
    );
    attemptId = started.rows[0].id;

    if (input.beforeStripeWrite) await input.beforeStripeWrite();

    const fresh = await loadTotals(
      client,
      input.tenantId,
      input.customerId,
      input.periodStart,
      input.periodEnd,
    );
    if (totalsChanged(snapshot, fresh)) {
      await completeAttempt(client, input.tenantId, attemptId, "failed", LEDGER_TOTAL_CHANGED);
      await client.query("COMMIT");
      return {
        alreadySynced: false,
        attemptId,
        status: "failed",
        errorMessage: LEDGER_TOTAL_CHANGED,
        lineItems: existing,
      };
    }

    const http = input.httpClient ?? createStripeWriteClient();
    try {
      for (const category of needed) {
        assertWriteScope(connection);
        const amount = snapshot[category].amount;
        const reference = buildLedgerReference(input.tenantId, input.customerId, input.periodStart, category);
        const body = new URLSearchParams({
          customer: link.stripe_customer_id,
          amount: decimalToMinorUnits(amount),
          currency: "usd",
          description: `${category} charges (${reference})`,
          "metadata[ledger_reference]": reference,
        });
        const response = await http.post("/v1/invoiceitems", body, {
          Authorization: `Bearer ${accessToken}`,
        });
        const stripeId = stripeItemId(response.body);
        if (!stripeId) throw new PeriodCloseInvoiceSyncError("stripe invoice item create returned no id", 502);
        try {
          await client.query(
            `INSERT INTO period_close_invoice_line_items (
               tenant_id, customer_id, period_start, period_end, category,
               stripe_invoice_item_id, amount, ledger_reference
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              input.tenantId,
              input.customerId,
              input.periodStart,
              input.periodEnd,
              category,
              stripeId,
              amount,
              reference,
            ],
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await completeAttempt(client, input.tenantId, attemptId, "failed", message);
      await client.query("COMMIT");
      if (
        error instanceof PeriodCloseInvoiceSyncError
        || error instanceof StripeScopeError
        || error instanceof StripeConnectionClosedError
      ) {
        throw error;
      }
      if (error instanceof ConnectorError) {
        return {
          alreadySynced: false,
          attemptId,
          status: "failed",
          errorMessage: message,
          lineItems: existing,
        };
      }
      throw error;
    }

    await completeAttempt(client, input.tenantId, attemptId, "succeeded", null);
    const lineItems = await loadLineItems(
      client,
      input.tenantId,
      input.customerId,
      input.periodStart,
      input.periodEnd,
    );
    await client.query("COMMIT");
    return {
      alreadySynced: false,
      attemptId,
      status: "succeeded",
      errorMessage: null,
      lineItems,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function evaluateStalledPeriodCloseInvoiceSyncs(pool: Pool, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PERIOD_CLOSE_SYNC_STALL_MS);
  const tenants = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
  let alerted = 0;
  for (const tenant of tenants.rows) {
    const stalled = await withTenant(pool, tenant.id, async (client) =>
      (await client.query<{
        id: string;
        customer_id: string;
        customer_name: string;
        period_start: Date | string;
        period_end: Date | string;
      }>(
        `SELECT a.id, a.customer_id, c.name AS customer_name, a.period_start, a.period_end
         FROM period_close_invoice_sync_attempts a
         JOIN customers c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
         WHERE a.tenant_id = $1
           AND a.status IN ('running', 'failed')
           AND a.started_at <= $2
           AND NOT EXISTS (
             SELECT 1 FROM period_close_invoice_line_items i
             WHERE i.tenant_id = a.tenant_id
               AND i.customer_id = a.customer_id
               AND i.period_start = a.period_start
               AND i.period_end = a.period_end
           )
         ORDER BY a.started_at, a.id`,
        [tenant.id, cutoff],
      )).rows,
    );
    for (const attempt of stalled) {
      const periodStart = toIso(attempt.period_start);
      const periodEnd = toIso(attempt.period_end);
      await emitWebhookEvent(
        pool,
        tenant.id,
        "period_close_sync.stalled",
        `period_close_sync.stalled:${attempt.id}`,
        {
          customer_id: attempt.customer_id,
          customer_name: attempt.customer_name,
          period_start: periodStart,
          period_end: periodEnd,
          attempt_id: attempt.id,
          message: `Period-close Stripe invoice sync for customer ${attempt.customer_name} (${attempt.customer_id}) period ${periodStart} has not succeeded within 1 hour.`,
        },
      );
      alerted += 1;
    }
  }
  return alerted;
}

export async function evaluatePeriodCloseInvoiceSyncs(pool: Pool, now = new Date()): Promise<number> {
  const bounds = previousUtcCalendarMonthBounds(now);
  const tenants = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
  let synced = 0;
  for (const tenant of tenants.rows) {
    const writable = await withTenant(pool, tenant.id, async (client) =>
      (await client.query<{ id: string }>(
        `SELECT id FROM stripe_connections
         WHERE status = 'connected' AND scope = 'read_write'
         ORDER BY connected_at DESC
         LIMIT 1`,
      )).rows[0] ?? null,
    );
    if (!writable) continue;
    const customers = await withTenant(pool, tenant.id, async (client) =>
      (await client.query<{ customer_id: string }>(
        `SELECT DISTINCT c.customer_id
         FROM usage_consumptions c
         JOIN stripe_customer_links l ON l.customer_id = c.customer_id AND l.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1
           AND c.occurred_at >= $2
           AND c.occurred_at < $3
           AND NOT EXISTS (
             SELECT 1 FROM period_close_invoice_line_items i
             WHERE i.tenant_id = c.tenant_id
               AND i.customer_id = c.customer_id
               AND i.period_start = $2
               AND i.period_end = $3
           )
         ORDER BY c.customer_id`,
        [tenant.id, bounds.periodStart, bounds.periodEnd],
      )).rows,
    );
    for (const row of customers) {
      try {
        const result = await syncPeriodCloseInvoice({
          pool,
          tenantId: tenant.id,
          customerId: row.customer_id,
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
        });
        if (result.status === "succeeded" || result.status === "already_synced") synced += 1;
      } catch (error) {
        console.error("period-close invoice sync failed:", error);
      }
    }
  }
  return synced;
}

export async function runPeriodCloseInvoiceSyncTick(pool: Pool, now = new Date()): Promise<void> {
  await evaluatePeriodCloseInvoiceSyncs(pool, now);
  await evaluateStalledPeriodCloseInvoiceSyncs(pool, now);
}
