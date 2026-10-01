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
    map: (row: Raw) => Mapped,
  ): Promise<ConnectorPage<Mapped>> {
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (since !== null) query.set("created[gte]", unixSeconds(since));
    if (cursor !== null) query.set("starting_after", cursor);
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
      data: rows.map(map),
      nextCursor: body.has_more ? last!.id as string : null,
    };
  }

  listCustomers(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCustomer>> {
    return this.page<Record<string, unknown>, ConnectorCustomer>("/v1/customers", since, cursor, (row) =>
      mapConnectorCustomer({ ...row, name: row.name ?? row.email ?? row.id } as unknown as StripeLikeCustomer));
  }

  listPrices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPrice>> {
    return this.page<StripeLikePrice, ConnectorPrice>("/v1/prices", since, cursor, mapConnectorPrice);
  }

  listContracts(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorContract>> {
    return this.page<StripeLikeContract, ConnectorContract>("/v1/subscriptions", since, cursor, mapConnectorContract);
  }

  listInvoices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorInvoice>> {
    return this.page<Record<string, unknown>, ConnectorInvoice>(
      "/v1/invoices", since, cursor, (row) => mapConnectorInvoice(invoiceWithEmbeddedLines(row)),
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
}
