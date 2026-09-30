import type {
  ConnectorContract,
  ConnectorCredit,
  ConnectorCustomer,
  ConnectorInvoice,
  ConnectorPayment,
  ConnectorPrice,
  ConnectorRefund,
} from "./types.js";

export interface ConnectorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface Connector {
  readonly connectorType: string;
  listCustomers(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCustomer>>;
  listPrices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPrice>>;
  listContracts(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorContract>>;
  listInvoices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorInvoice>>;
  listCredits(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCredit>>;
  listPayments(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPayment>>;
  listRefunds(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorRefund>>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
