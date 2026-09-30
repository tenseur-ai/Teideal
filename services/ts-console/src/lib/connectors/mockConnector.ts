import { ConnectorError, type Connector, type ConnectorPage } from "./connector.js";
import { createConnectorHttpClient, type ConnectorHttpClient } from "./httpClient.js";
import type {
  ConnectorContract,
  ConnectorCredit,
  ConnectorCustomer,
  ConnectorInvoice,
  ConnectorPayment,
  ConnectorPrice,
  ConnectorRefund,
} from "./types.js";

type RawId = string | { id: string };
type RawTime = number | string;

export interface StripeLikeCustomer {
  id: string;
  name: string;
  email: string | null;
  created: RawTime;
}

export interface StripeLikePrice {
  id: string;
  product: string | { name: string };
  unit_amount: number | string;
  currency: string;
  billing_scheme: string;
  created?: RawTime;
}

export interface StripeLikeContract {
  id: string;
  customer: RawId;
  status: string;
  start_date: RawTime;
  ended_at: RawTime | null;
}

export interface StripeLikeInvoice {
  id: string;
  customer: RawId;
  amount_due: number | string;
  currency: string;
  status: string;
  created: RawTime;
  due_date: RawTime | null;
}

export interface StripeLikeCredit {
  id: string;
  customer: RawId;
  amount: number | string;
  currency: string;
  reason: string | null;
  created: RawTime;
}

export interface StripeLikePayment {
  id: string;
  customer: RawId;
  invoice: RawId | null;
  amount: number | string;
  currency: string;
  status: string;
  created: RawTime;
}

export interface StripeLikeRefund {
  id: string;
  payment: RawId;
  amount: number | string;
  currency: string;
  reason: string | null;
  created: RawTime;
}

export interface StripeLikeExport {
  customers: StripeLikeCustomer[];
  prices: StripeLikePrice[];
  contracts: StripeLikeContract[];
  invoices: StripeLikeInvoice[];
  credits: StripeLikeCredit[];
  payments: StripeLikePayment[];
  refunds: StripeLikeRefund[];
}

export interface MockConnectorOptions {
  fixtures?: StripeLikeExport;
  baseUrl?: string;
  pageSize?: number;
  httpClient?: ConnectorHttpClient;
}

const EMPTY_FIXTURES: StripeLikeExport = {
  customers: [], prices: [], contracts: [], invoices: [], credits: [], payments: [], refunds: [],
};

function idOf(value: RawId): string {
  return typeof value === "string" ? value : value.id;
}

function iso(value: RawTime): string {
  const date = typeof value === "number" ? new Date(value * 1_000) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ConnectorError(`invalid fixture timestamp: ${String(value)}`, 0, false);
  return date.toISOString();
}

// Stripe-shaped fixture amounts are integer minor units. Converting with
// string arithmetic keeps cent accuracy and never passes through a float.
function decimalAmount(value: number | string): string {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) {
    throw new ConnectorError(`invalid fixture money amount: ${raw}`, 0, false);
  }
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "").padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function mapConnectorCustomer(row: StripeLikeCustomer): ConnectorCustomer {
  return { id: row.id, name: row.name, email: row.email, created_at: iso(row.created) };
}

export function mapConnectorPrice(row: StripeLikePrice): ConnectorPrice {
  return {
    id: row.id,
    product_name: typeof row.product === "string" ? row.product : row.product.name,
    amount: decimalAmount(row.unit_amount),
    currency: row.currency.toUpperCase(),
    billing_scheme: row.billing_scheme,
  };
}

export function mapConnectorContract(row: StripeLikeContract): ConnectorContract {
  return {
    id: row.id,
    customer_id: idOf(row.customer),
    status: row.status,
    started_at: iso(row.start_date),
    ended_at: row.ended_at === null ? null : iso(row.ended_at),
  };
}

export function mapConnectorInvoice(row: StripeLikeInvoice): ConnectorInvoice {
  return {
    id: row.id,
    customer_id: idOf(row.customer),
    amount: decimalAmount(row.amount_due),
    currency: row.currency.toUpperCase(),
    status: row.status,
    issued_at: iso(row.created),
    due_at: row.due_date === null ? null : iso(row.due_date),
  };
}

export function mapConnectorCredit(row: StripeLikeCredit): ConnectorCredit {
  return {
    id: row.id,
    customer_id: idOf(row.customer),
    amount: decimalAmount(row.amount),
    currency: row.currency.toUpperCase(),
    reason: row.reason,
    issued_at: iso(row.created),
  };
}

export function mapConnectorPayment(row: StripeLikePayment): ConnectorPayment {
  return {
    id: row.id,
    customer_id: idOf(row.customer),
    invoice_id: row.invoice === null ? null : idOf(row.invoice),
    amount: decimalAmount(row.amount),
    currency: row.currency.toUpperCase(),
    status: row.status,
    paid_at: iso(row.created),
  };
}

export function mapConnectorRefund(row: StripeLikeRefund): ConnectorRefund {
  return {
    id: row.id,
    payment_id: idOf(row.payment),
    amount: decimalAmount(row.amount),
    currency: row.currency.toUpperCase(),
    reason: row.reason,
    refunded_at: iso(row.created),
  };
}

function rawTimestamp(entity: keyof StripeLikeExport, row: StripeLikeExport[keyof StripeLikeExport][number]): RawTime | null {
  if (entity === "prices") return (row as StripeLikePrice).created ?? null;
  if (entity === "contracts") return (row as StripeLikeContract).start_date;
  return (row as { created: RawTime }).created;
}

function cursorOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new ConnectorError("invalid pagination cursor", 400, false);
  return offset;
}

export class MockConnector implements Connector {
  readonly connectorType = "csv_mock";
  private readonly fixtures: StripeLikeExport;
  private readonly client: ConnectorHttpClient | null;
  private readonly pageSize: number;

  constructor(options: MockConnectorOptions = {}) {
    if (options.fixtures && options.baseUrl) throw new Error("provide fixtures or baseUrl, not both");
    this.fixtures = options.fixtures ?? EMPTY_FIXTURES;
    this.pageSize = options.pageSize ?? 1_000;
    if (!Number.isInteger(this.pageSize) || this.pageSize <= 0) throw new Error("pageSize must be a positive integer");
    this.client = options.httpClient
      ?? (options.baseUrl ? createConnectorHttpClient({ baseUrl: options.baseUrl }) : null);
  }

  private async page<Raw, Mapped>(
    entity: keyof StripeLikeExport,
    since: string | null,
    cursor: string | null,
    map: (row: Raw) => Mapped,
  ): Promise<ConnectorPage<Mapped>> {
    if (this.client) {
      const query = new URLSearchParams({ limit: String(this.pageSize) });
      if (since !== null) query.set("since", since);
      if (cursor !== null) query.set("cursor", cursor);
      const response = await this.client.get(`/v1/${entity}?${query}`);
      const body = response.body as { data?: unknown; next_cursor?: unknown } | null;
      if (!body || !Array.isArray(body.data) || (body.next_cursor !== null && typeof body.next_cursor !== "string")) {
        throw new ConnectorError(`connector returned an invalid ${entity} page`, response.status, false);
      }
      return { data: (body.data as Raw[]).map(map), nextCursor: body.next_cursor };
    }

    let rows = this.fixtures[entity] as unknown as Raw[];
    if (since !== null) {
      const sinceMs = new Date(since).getTime();
      if (Number.isNaN(sinceMs)) throw new ConnectorError("since must be an ISO timestamp", 400, false);
      rows = rows.filter((row) => {
        const timestamp = rawTimestamp(
          entity,
          row as unknown as StripeLikeExport[keyof StripeLikeExport][number],
        );
        return timestamp === null || new Date(iso(timestamp)).getTime() >= sinceMs;
      });
    }
    const offset = cursorOffset(cursor);
    const data = rows.slice(offset, offset + this.pageSize).map(map);
    const nextOffset = offset + data.length;
    return { data, nextCursor: nextOffset < rows.length ? String(nextOffset) : null };
  }

  listCustomers(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCustomer>> {
    return this.page("customers", since, cursor, mapConnectorCustomer);
  }

  listPrices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPrice>> {
    return this.page("prices", since, cursor, mapConnectorPrice);
  }

  listContracts(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorContract>> {
    return this.page("contracts", since, cursor, mapConnectorContract);
  }

  listInvoices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorInvoice>> {
    return this.page("invoices", since, cursor, mapConnectorInvoice);
  }

  listCredits(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCredit>> {
    return this.page("credits", since, cursor, mapConnectorCredit);
  }

  listPayments(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPayment>> {
    return this.page("payments", since, cursor, mapConnectorPayment);
  }

  listRefunds(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorRefund>> {
    return this.page("refunds", since, cursor, mapConnectorRefund);
  }
}
