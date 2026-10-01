import type { Pool } from "pg";
import { withTenant } from "../db.js";
import { readUsableAccessToken } from "../stripeConnect.js";
import { ConnectorError, type Connector, type ConnectorPage } from "./connector.js";
import { createConnectorHttpClient, type ConnectorHttpClient } from "./httpClient.js";
import {
  mapConnectorContract,
  mapConnectorCredit,
  mapConnectorCustomer,
  mapConnectorInvoice,
  mapConnectorPayment,
  mapConnectorPrice,
  mapConnectorRefund,
  type StripeLikeContract,
  type StripeLikeCredit,
  type StripeLikeCustomer,
  type StripeLikeInvoice,
  type StripeLikeInvoiceLine,
  type StripeLikePayment,
  type StripeLikePrice,
  type StripeLikeRefund,
} from "./mockConnector.js";
import type {
  ConnectorContract,
  ConnectorCredit,
  ConnectorCustomer,
  ConnectorInvoice,
  ConnectorPayment,
  ConnectorPrice,
  ConnectorRefund,
} from "./types.js";

interface StripeListPage {
  data?: unknown;
  has_more?: unknown;
}

interface StripeLinesContainer {
  data?: unknown;
  has_more?: unknown;
}

export const STRIPE_INCREMENTAL_EVENT_TYPES = [
  "invoice.updated",
  "invoice.finalized",
  "invoice.paid",
  "invoice.voided",
  "charge.refunded",
  "credit_note.created",
] as const;

export type StripeIncrementalEventType = typeof STRIPE_INCREMENTAL_EVENT_TYPES[number];

export interface StripeIncrementalEvent {
  id: string;
  type: StripeIncrementalEventType;
  objectId: string;
}

export type StripeIncrementalRecord =
  | { entityType: "invoice"; record: ConnectorInvoice }
  | { entityType: "credit"; record: ConnectorCredit }
  | { entityType: "payment"; record: ConnectorPayment };

export interface StripeBillingConnectorOptions {
  baseUrl?: string;
  pageSize?: number;
  requestsPerMinute?: number;
  httpClient?: ConnectorHttpClient;
}

export const STRIPE_BILLING_ENTITY_TYPES = [
  "customer", "price", "contract", "invoice", "credit", "payment", "refund",
] as const;

export type StripeBillingEntityType = typeof STRIPE_BILLING_ENTITY_TYPES[number];

function unixSeconds(iso: string): string {
  const milliseconds = new Date(iso).getTime();
  if (Number.isNaN(milliseconds)) throw new ConnectorError("since must be an ISO timestamp", 400, false);
  return String(Math.floor(milliseconds / 1_000));
}

function invoiceWithEmbeddedLines(row: Record<string, unknown>): StripeLikeInvoice {
  const linesContainer = row.lines as { data?: unknown } | unknown[] | undefined;
  const rawLines = Array.isArray(linesContainer)
    ? linesContainer
    : linesContainer && Array.isArray(linesContainer.data) ? linesContainer.data : [];
  const lines = rawLines.map((value) => {
    const line = value as Record<string, unknown>;
    const price = line.price as Record<string, unknown> | string | null | undefined;
    const period = line.period as { start?: unknown; end?: unknown } | null | undefined;
    return {
      ...line,
      price: typeof price === "object" && price !== null
        ? (typeof price.id === "string" ? price.id : null)
        : price ?? null,
      quantity: line.quantity ?? "1",
      unit_amount: line.unit_amount
        ?? (typeof price === "object" && price !== null ? price.unit_amount : undefined)
        ?? line.amount
        ?? "0",
      // Stripe's actual invoice line shape nests the period as `period.start`/
      // `period.end`; the flat fields only exist in our own fixtures. Without
      // this fallback, every real Stripe line looks periodless and TEID-66
      // silently drops it. The flat fields still win if a caller sets them.
      period_start: line.period_start ?? period?.start ?? null,
      period_end: line.period_end ?? period?.end ?? null,
    } as unknown as StripeLikeInvoiceLine;
  });
  return { ...row, lines } as unknown as StripeLikeInvoice;
}

export class StripeBillingConnector implements Connector {
  readonly connectorType = "stripe";
  private readonly client: ConnectorHttpClient;
  private readonly pageSize: number;

  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    private readonly stripeConnectionId: string,
    options: StripeBillingConnectorOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) {
      throw new Error("Stripe pageSize must be an integer between 1 and 100");
    }
    this.client = options.httpClient ?? createConnectorHttpClient({
      baseUrl: options.baseUrl ?? process.env.STRIPE_API_BASE_URL ?? "https://api.stripe.com",
      requestsPerMinute: options.requestsPerMinute ?? 100,
    });
  }

  private async token(): Promise<string> {
    // Resolve on every API call: disconnecting/revoking a connection during a
    // long backfill must stop the next page, not remain hidden by a token cache.
    return withTenant(this.pool, this.tenantId, (client) =>
      readUsableAccessToken(client, this.stripeConnectionId));
  }

  private async page<Raw, Mapped>(
    path: string,
    since: string | null,
    cursor: string | null,
    map: (row: Raw) => Mapped | Promise<Mapped>,
    extendQuery?: (query: URLSearchParams) => void,
  ): Promise<ConnectorPage<Mapped>> {
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (since !== null) query.set("created[gte]", unixSeconds(since));
    if (cursor !== null) query.set("starting_after", cursor);
    extendQuery?.(query);
    const token = await this.token();
    const response = await this.client.get(`${path}?${query.toString()}`, {
      Authorization: `Bearer ${token}`,
    });
    const body = response.body as StripeListPage | null;
    if (!body || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
      throw new ConnectorError(`Stripe returned an invalid ${path} page`, response.status, false);
    }
    const rows = body.data as Raw[];
    const last = rows.at(-1) as { id?: unknown } | undefined;
    if (body.has_more && (!last || typeof last.id !== "string" || last.id.length === 0)) {
      throw new ConnectorError(`Stripe returned an invalid ${path} pagination cursor`, response.status, false);
    }
    return {
      data: await Promise.all(rows.map(map)),
      nextCursor: body.has_more ? last!.id as string : null,
    };
  }

  private async object(path: string): Promise<Record<string, unknown>> {
    const token = await this.token();
    const response = await this.client.get(path, { Authorization: `Bearer ${token}` });
    const body = response.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof (body as { id?: unknown }).id !== "string") {
      throw new ConnectorError(`Stripe returned an invalid ${path} object`, response.status, false);
    }
    return body as Record<string, unknown>;
  }

  private async invoiceWithAllLines(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const invoiceId = row.id;
    if (typeof invoiceId !== "string" || invoiceId.length === 0) {
      throw new ConnectorError("Stripe returned an invoice without an id", 0, false);
    }
    const container = row.lines as StripeLinesContainer | unknown[] | undefined;
    if (Array.isArray(container) || container?.has_more !== true) return row;
    if (!Array.isArray(container.data)) {
      throw new ConnectorError(`Stripe returned invalid lines for invoice ${invoiceId}`, 0, false);
    }

    const lines = [...container.data];
    const embeddedLast = lines.at(-1) as { id?: unknown } | undefined;
    if (!embeddedLast || typeof embeddedLast.id !== "string" || embeddedLast.id.length === 0) {
      throw new ConnectorError(`Stripe returned an invalid line cursor for invoice ${invoiceId}`, 0, false);
    }

    let cursor = embeddedLast.id;
    while (true) {
      const query = new URLSearchParams({ limit: String(this.pageSize), starting_after: cursor });
      const token = await this.token();
      const response = await this.client.get(
        `/v1/invoices/${encodeURIComponent(invoiceId)}/lines?${query.toString()}`,
        { Authorization: `Bearer ${token}` },
      );
      const page = response.body as StripeListPage | null;
      if (!page || !Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        throw new ConnectorError(`Stripe returned invalid lines for invoice ${invoiceId}`, response.status, false);
      }
      lines.push(...page.data);
      if (!page.has_more) break;
      const last = page.data.at(-1) as { id?: unknown } | undefined;
      if (!last || typeof last.id !== "string" || last.id.length === 0) {
        throw new ConnectorError(`Stripe returned an invalid line cursor for invoice ${invoiceId}`, response.status, false);
      }
      cursor = last.id;
    }

    return { ...row, lines: { ...container, data: lines, has_more: false } };
  }

  private async mappedInvoice(row: Record<string, unknown>): Promise<ConnectorInvoice> {
    return mapConnectorInvoice(invoiceWithEmbeddedLines(await this.invoiceWithAllLines(row)));
  }

  listCustomers(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCustomer>> {
    return this.page<Record<string, unknown>, ConnectorCustomer>("/v1/customers", since, cursor, (row) =>
      mapConnectorCustomer({ ...row, name: row.name ?? row.email ?? row.id } as unknown as StripeLikeCustomer));
  }

  listPrices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPrice>> {
    return this.page<Record<string, unknown>, ConnectorPrice>("/v1/prices", since, cursor, (row) => {
      if (row.unit_amount !== null) return mapConnectorPrice(row as unknown as StripeLikePrice);
      const mapped = mapConnectorPrice({ ...row, unit_amount: "0" } as unknown as StripeLikePrice);
      return {
        ...mapped,
        amount: "0",
        // Keep Stripe's null sentinel alongside the untouched tier fields in passthrough.
        passthrough: { ...mapped.passthrough, unit_amount: null },
      };
    });
  }

  listContracts(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorContract>> {
    return this.page<StripeLikeContract, ConnectorContract>("/v1/subscriptions", since, cursor, mapConnectorContract);
  }

  listInvoices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorInvoice>> {
    return this.page<Record<string, unknown>, ConnectorInvoice>(
      "/v1/invoices", since, cursor, (row) => this.mappedInvoice(row),
      (query) => query.append("expand[]", "data.lines"),
    );
  }

  listCredits(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCredit>> {
    return this.page<StripeLikeCredit, ConnectorCredit>("/v1/credit_notes", since, cursor, mapConnectorCredit);
  }

  listPayments(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPayment>> {
    return this.page<Record<string, unknown>, ConnectorPayment>("/v1/charges", since, cursor, (row) =>
      mapConnectorPayment({ ...row, processor_charge_id: row.id } as unknown as StripeLikePayment));
  }

  listRefunds(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorRefund>> {
    return this.page<Record<string, unknown>, ConnectorRefund>("/v1/refunds", since, cursor, (row) =>
      mapConnectorRefund({
        ...row,
        payment: row.payment ?? row.payment_intent ?? row.charge,
        processor_refund_id: row.id,
      } as unknown as StripeLikeRefund));
  }

  listEvents(since: string, cursor: string | null): Promise<ConnectorPage<StripeIncrementalEvent>> {
    return this.page<Record<string, unknown>, StripeIncrementalEvent>(
      "/v1/events",
      since,
      cursor,
      (row) => {
        const type = row.type;
        const data = row.data as { object?: unknown } | undefined;
        const object = data?.object as { id?: unknown } | undefined;
        if (typeof row.id !== "string"
          || !STRIPE_INCREMENTAL_EVENT_TYPES.includes(type as StripeIncrementalEventType)
          || !object || typeof object.id !== "string" || object.id.length === 0) {
          throw new ConnectorError("Stripe returned an invalid /v1/events event", 0, false);
        }
        return { id: row.id, type: type as StripeIncrementalEventType, objectId: object.id };
      },
      (query) => {
        for (const type of STRIPE_INCREMENTAL_EVENT_TYPES) query.append("type[]", type);
      },
    );
  }

  async retrieveEventRecord(event: StripeIncrementalEvent): Promise<StripeIncrementalRecord> {
    if (event.type.startsWith("invoice.")) {
      const row = await this.object(`/v1/invoices/${encodeURIComponent(event.objectId)}?expand%5B%5D=lines`);
      return { entityType: "invoice", record: await this.mappedInvoice(row) };
    }
    if (event.type === "credit_note.created") {
      const row = await this.object(`/v1/credit_notes/${encodeURIComponent(event.objectId)}`);
      return { entityType: "credit", record: mapConnectorCredit(row as unknown as StripeLikeCredit) };
    }
    const row = await this.object(`/v1/charges/${encodeURIComponent(event.objectId)}`);
    return {
      entityType: "payment",
      record: mapConnectorPayment({ ...row, processor_charge_id: row.id } as unknown as StripeLikePayment),
    };
  }
}
