// Outbound HTTP client for go-usage's customer-timeline read endpoints.
// ts-console never queries go-usage-owned tables directly (ADR 0001).

export function goUsageBaseUrl(): string {
  return (process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082").replace(/\/+$/, "");
}

export class GoUsageError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  constructor(statusCode: number, body: unknown, message: string) {
    super(message);
    this.name = "GoUsageError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export interface UsageBucket {
  hour: string;
  event_type: string;
  count: number;
  total_quantity: number | string;
}

export interface UsageEvent {
  id: string;
  customer_id: string;
  event_type: string;
  quantity: number | string;
  idempotency_key: string;
  occurred_at: string;
  is_prior_period_adjustment?: boolean;
}

export interface ReservationRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  usage_event_id: string | null;
  created_at: string;
}

export interface LedgerTransactionRow {
  id: string;
  customer_id: string;
  usage_event_id: string | null;
  grant_id: string | null;
  reservation_id: string | null;
  pricing_rule_id: string | null;
  plan_version: number | null;
  reverses_transaction_id: string | null;
  description: string | null;
  created_at: string;
}

export interface LedgerLine {
  id: string;
  transaction_id: string;
  account_code: string;
  direction: "debit" | "credit";
  amount: number | string;
  created_at: string;
}

export interface LedgerTransactionDetail extends LedgerTransactionRow {
  lines: LedgerLine[];
  usage_event: UsageEvent | null;
}

export interface AdjustmentRow {
  id: string;
  customer_id: string;
  event_type: string;
  quantity: number | string;
  idempotency_key: string;
  occurred_at: string;
  period_start: string;
  period_end: string;
  status: string;
  auto_approved: boolean;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  resulting_usage_event_id: string | null;
  created_at: string;
}

export interface ListQuery {
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string | null;
  metric?: string;
  eventType?: string;
}

interface ListResponse<T> {
  data: T[];
  cursor: string | null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const url = new URL(path, "http://go-usage.invalid");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

async function goUsageGet(path: string, authorization: string, timeoutMs = 20_000): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${goUsageBaseUrl()}${path}`, {
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);
  return { status: response.status, body };
}

function asList<T>(body: unknown): ListResponse<T> {
  if (typeof body !== "object" || body === null) return { data: [], cursor: null };
  const row = body as { data?: unknown; cursor?: unknown };
  return {
    data: Array.isArray(row.data) ? (row.data as T[]) : [],
    cursor: typeof row.cursor === "string" ? row.cursor : null,
  };
}

function requireOk<T>(status: number, body: unknown, message: string): T {
  if (status >= 200 && status < 300) return body as T;
  throw new GoUsageError(status, body, message);
}

export async function listUsageBuckets(
  authorization: string,
  customerId: string,
  query: ListQuery,
): Promise<ListResponse<UsageBucket>> {
  const path = withQuery("/usage", {
    customer_id: customerId,
    group_by: "hour",
    since: query.since,
    until: query.until,
    metric: query.metric,
    limit: query.limit !== undefined ? String(query.limit) : "10000",
    cursor: query.cursor ?? undefined,
  });
  const { status, body } = await goUsageGet(path, authorization, 120_000);
  requireOk(status, body, "list usage buckets failed");
  return asList<UsageBucket>(body);
}

export async function listUsageEvents(
  authorization: string,
  customerId: string,
  query: ListQuery,
): Promise<ListResponse<UsageEvent>> {
  const path = withQuery("/usage", {
    customer_id: customerId,
    since: query.since,
    until: query.until,
    event_type: query.eventType ?? query.metric,
    limit: query.limit !== undefined ? String(query.limit) : undefined,
    cursor: query.cursor ?? undefined,
  });
  const { status, body } = await goUsageGet(path, authorization);
  requireOk(status, body, "list usage events failed");
  return asList<UsageEvent>(body);
}

export async function listReservations(
  authorization: string,
  customerId: string,
  query: ListQuery,
): Promise<ListResponse<ReservationRow>> {
  const path = withQuery(`/customers/${customerId}/reservations`, {
    since: query.since,
    until: query.until,
    limit: query.limit !== undefined ? String(query.limit) : "500",
    cursor: query.cursor ?? undefined,
  });
  const { status, body } = await goUsageGet(path, authorization);
  requireOk(status, body, "list reservations failed");
  return asList<ReservationRow>(body);
}

export async function listLedgerTransactions(
  authorization: string,
  customerId: string,
  query: ListQuery,
): Promise<ListResponse<LedgerTransactionRow>> {
  const path = withQuery(`/customers/${customerId}/ledger-transactions`, {
    since: query.since,
    until: query.until,
    limit: query.limit !== undefined ? String(query.limit) : "500",
    cursor: query.cursor ?? undefined,
  });
  const { status, body } = await goUsageGet(path, authorization);
  requireOk(status, body, "list ledger transactions failed");
  return asList<LedgerTransactionRow>(body);
}

export async function getLedgerTransactionDetail(
  authorization: string,
  transactionId: string,
): Promise<{ status: number; body: unknown }> {
  return goUsageGet(`/ledger/transactions/${transactionId}/detail`, authorization);
}

export async function listAdjustments(
  authorization: string,
  customerId: string,
  query: ListQuery,
): Promise<ListResponse<AdjustmentRow>> {
  const path = withQuery("/adjustments", {
    customer_id: customerId,
    since: query.since,
    until: query.until,
    metric: query.metric,
    limit: query.limit !== undefined ? String(query.limit) : "500",
    cursor: query.cursor ?? undefined,
  });
  const { status, body } = await goUsageGet(path, authorization);
  requireOk(status, body, "list adjustments failed");
  return asList<AdjustmentRow>(body);
}
