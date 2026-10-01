import { ConnectorError, type Connector, type ConnectorPage } from "./connector.js";
import { createConnectorHttpClient, type ConnectorHttpClient } from "./httpClient.js";
import type {
  ConnectorContract,
  ConnectorCredit,
  ConnectorCustomer,
  ConnectorInvoice,
  ConnectorInvoiceLine,
  ConnectorPayment,
  ConnectorPrice,
  ConnectorRefund,
} from "./types.js";

type RawId = string | { id: string };
type RawTime = number | string;

export interface StripeLikeCustomer {
  [key: string]: unknown;
  id: string;
  name: string;
  email: string | null;
  created: RawTime;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikePrice {
  [key: string]: unknown;
  id: string;
  product: string | { id?: string; name: string };
  unit_amount: number | string;
  currency: string;
  billing_scheme: string;
  created?: RawTime;
  interval?: string | null;
  recurring?: { interval?: string | null } | null;
  nickname?: string | null;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikeContract {
  [key: string]: unknown;
  id: string;
  customer: RawId;
  status: string;
  start_date: RawTime;
  ended_at: RawTime | null;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikeInvoiceLine {
  [key: string]: unknown;
  id: string;
  price?: RawId | null;
  description?: string | null;
  quantity: number | string;
  unit_amount: number | string;
  amount: number | string;
  currency?: string;
  period_start?: RawTime | null;
  period_end?: RawTime | null;
}

export interface StripeLikeInvoice {
  [key: string]: unknown;
  id: string;
  customer: RawId;
  amount_due: number | string;
  currency: string;
  status: string;
  created: RawTime;
  due_date: RawTime | null;
  number?: string | null;
  period_start?: RawTime | null;
  period_end?: RawTime | null;
  subtotal?: number | string | null;
  tax?: number | string | null;
  lines?: StripeLikeInvoiceLine[];
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikeCredit {
  [key: string]: unknown;
  id: string;
  customer: RawId;
  amount: number | string;
  currency: string;
  reason: string | null;
  created: RawTime;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikePayment {
  [key: string]: unknown;
  id: string;
  customer: RawId;
  invoice: RawId | null;
  amount: number | string;
  currency: string;
  status: string;
  created: RawTime;
  processor_charge_id?: RawId | null;
  charge?: RawId | null;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
}

export interface StripeLikeRefund {
  [key: string]: unknown;
  id: string;
  payment: RawId;
  amount: number | string;
  currency: string;
  reason: string | null;
  created: RawTime;
  processor_refund_id?: RawId | null;
  external_updated_at?: RawTime | null;
  updated?: RawTime | null;
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

function nullableIso(value: RawTime | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function externalUpdatedAt(
  normalized: RawTime | null | undefined,
  stripeLike: RawTime | null | undefined,
): string | null {
  return nullableIso(normalized ?? stripeLike);
}

function nullableId(value: RawId | null | undefined): string | null {
  return value === null || value === undefined ? null : idOf(value);
}

// Stripe-shaped fixture amounts are integer minor units. Converting with
// string arithmetic keeps exact decimal accuracy and never passes through a float.
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND"]);
const THREE_DECIMAL_CURRENCIES = new Set(["KWD", "BHD", "OMR", "JOD"]);

export function currencyMinorDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Accepts integer minor units only. Callers must convert values to the platform's own integer
 * minor units before calling; this function intentionally has no major-unit mode and none should be added.
 */
export function decimalAmount(value: number | string, currency: string): string {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) {
    throw new ConnectorError(`invalid fixture money amount: ${raw}`, 0, false);
  }
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  const scale = currencyMinorDigits(currency);
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function nullableDecimalAmount(value: number | string | null | undefined, currency: string): string | null {
  return value === null || value === undefined ? null : decimalAmount(value, currency);
}

function decimalQuantity(value: number | string): string {
  const raw = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new ConnectorError(`invalid fixture quantity: ${raw}`, 0, false);
  }
  return raw;
}

export function mapConnectorCustomer(row: StripeLikeCustomer): ConnectorCustomer {
  const { id, name, email, created, external_updated_at, updated, ...passthrough } = row;
  return {
    id,
    name,
    email,
    created_at: iso(created),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

// This narrow id-recognition convention is only for fixture/mock data; real connectors map distinct API id/name fields directly.
const PRODUCT_ID_PREFIX = /^prod_/;

function resolveProduct(product: string | { id?: string; name: string }): {
  productId: string | null;
  productName: string;
} {
  if (typeof product !== "string") {
    return { productId: product.id ?? null, productName: product.name };
  }
  if (PRODUCT_ID_PREFIX.test(product)) {
    return { productId: product, productName: product };
  }
  return { productId: null, productName: product };
}

export function mapConnectorPrice(row: StripeLikePrice): ConnectorPrice {
  const {
    id, product, unit_amount, currency, billing_scheme, interval, recurring, nickname,
    external_updated_at, updated, ...passthrough
  } = row;
  const { productId, productName } = resolveProduct(product);
  return {
    id,
    product_name: productName,
    amount: decimalAmount(unit_amount, currency),
    currency: currency.toUpperCase(),
    billing_scheme,
    interval: interval ?? recurring?.interval ?? null,
    product_id: productId,
    nickname: nickname ?? null,
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

export function mapConnectorContract(row: StripeLikeContract): ConnectorContract {
  const { id, customer, status, start_date, ended_at, external_updated_at, updated, ...passthrough } = row;
  return {
    id,
    customer_id: idOf(customer),
    status,
    started_at: iso(start_date),
    ended_at: nullableIso(ended_at),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

export function mapConnectorInvoiceLine(
  row: StripeLikeInvoiceLine,
  invoiceId: string,
  invoiceCurrency: string,
): ConnectorInvoiceLine {
  const {
    id, price, description, quantity, unit_amount, amount, currency = invoiceCurrency,
    period_start, period_end, ...passthrough
  } = row;
  return {
    id,
    invoice_id: invoiceId,
    price_id: nullableId(price),
    description: description ?? null,
    quantity: decimalQuantity(quantity),
    unit_amount: decimalAmount(unit_amount, currency),
    amount: decimalAmount(amount, currency),
    currency: currency.toUpperCase(),
    period_start: nullableIso(period_start),
    period_end: nullableIso(period_end),
    passthrough,
  };
}

export function mapConnectorInvoice(row: StripeLikeInvoice): ConnectorInvoice {
  const {
    id, customer, amount_due, currency, status, created, due_date, number: invoiceNumber,
    period_start, period_end, subtotal, tax, lines = [], external_updated_at, updated,
    ...passthrough
  } = row;
  return {
    id,
    customer_id: idOf(customer),
    amount: decimalAmount(amount_due, currency),
    currency: currency.toUpperCase(),
    status,
    issued_at: iso(created),
    due_at: nullableIso(due_date),
    number: invoiceNumber ?? null,
    period_start: nullableIso(period_start),
    period_end: nullableIso(period_end),
    subtotal: nullableDecimalAmount(subtotal, currency),
    tax: nullableDecimalAmount(tax, currency),
    lines: lines.map((line) => mapConnectorInvoiceLine(line, id, currency)),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

export function mapConnectorCredit(row: StripeLikeCredit): ConnectorCredit {
  const { id, customer, amount, currency, reason, created, external_updated_at, updated, ...passthrough } = row;
  return {
    id,
    customer_id: idOf(customer),
    amount: decimalAmount(amount, currency),
    currency: currency.toUpperCase(),
    reason,
    issued_at: iso(created),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

export function mapConnectorPayment(row: StripeLikePayment): ConnectorPayment {
  const {
    id, customer, invoice, amount, currency, status, created, processor_charge_id, charge,
    external_updated_at, updated, ...passthrough
  } = row;
  return {
    id,
    customer_id: idOf(customer),
    invoice_id: nullableId(invoice),
    amount: decimalAmount(amount, currency),
    currency: currency.toUpperCase(),
    status,
    paid_at: iso(created),
    processor_charge_id: nullableId(processor_charge_id ?? charge),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
  };
}

export function mapConnectorRefund(row: StripeLikeRefund): ConnectorRefund {
  const {
    id, payment, amount, currency, reason, created, processor_refund_id,
    external_updated_at, updated, ...passthrough
  } = row;
  return {
    id,
    payment_id: idOf(payment),
    amount: decimalAmount(amount, currency),
    currency: currency.toUpperCase(),
    reason,
    refunded_at: iso(created),
    processor_refund_id: nullableId(processor_refund_id),
    external_updated_at: externalUpdatedAt(external_updated_at, updated),
    passthrough,
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
