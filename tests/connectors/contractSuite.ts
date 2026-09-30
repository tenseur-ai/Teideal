import { beforeAll, describe, expect, it } from "vitest";
import type { Connector, ConnectorPage } from "../../services/ts-console/src/lib/connectors/connector.js";
import type { FailureMode, FakeConnectorTarget } from "./fake-connector-target.js";

export interface ConnectorContractSetup {
  connector: Connector;
  fakeTarget: FakeConnectorTarget;
}

export interface ContractCheckResult {
  passed: boolean;
  message: string;
}

export interface ConnectorContractResult {
  shippable: boolean;
  readOnly: ContractCheckResult;
  dataMapping: ContractCheckResult;
  failureSurvival: ContractCheckResult;
}

export interface ContractAssessmentOptions {
  failureMode?: FailureMode;
  failureRate?: number;
}

const pendingResult = (): ConnectorContractResult => ({
  shippable: false,
  readOnly: { passed: false, message: "not run" },
  dataMapping: { passed: false, message: "not run" },
  failureSurvival: { passed: false, message: "not run" },
});

type FieldCheck = (value: unknown) => boolean;

const stringValue: FieldCheck = (value) => typeof value === "string";
const nullableString: FieldCheck = (value) => value === null || typeof value === "string";
const timestamp: FieldCheck = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const nullableTimestamp: FieldCheck = (value) => value === null || timestamp(value);
const decimal: FieldCheck = (value) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
const nonNullObject: FieldCheck = (value) => typeof value === "object" && value !== null;
const nonEmptyArray: FieldCheck = (value) => Array.isArray(value) && value.length >= 1;

function validFields(value: unknown, fields: Record<string, FieldCheck>): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Object.entries(fields).every(([field, check]) => Object.hasOwn(row, field) && check(row[field]));
}

async function firstPages(connector: Connector): Promise<ConnectorPage<unknown>[]> {
  return Promise.all([
    connector.listCustomers(null, null),
    connector.listPrices(null, null),
    connector.listContracts(null, null),
    connector.listInvoices(null, null),
    connector.listCredits(null, null),
    connector.listPayments(null, null),
    connector.listRefunds(null, null),
  ]);
}

function mappingResult(pages: ConnectorPage<unknown>[]): ContractCheckResult {
  const [customers, prices, contracts, invoices, credits, payments, refunds] = pages;
  const checks = [
    validFields(customers.data[0], { id: stringValue, name: stringValue, email: nullableString, created_at: timestamp, passthrough: nonNullObject }),
    validFields(prices.data[0], { id: stringValue, product_name: stringValue, amount: decimal, currency: stringValue, billing_scheme: stringValue, passthrough: nonNullObject }),
    validFields(contracts.data[0], { id: stringValue, customer_id: stringValue, status: stringValue, started_at: timestamp, ended_at: nullableTimestamp, passthrough: nonNullObject }),
    validFields(invoices.data[0], { id: stringValue, customer_id: stringValue, amount: decimal, currency: stringValue, status: stringValue, issued_at: timestamp, due_at: nullableTimestamp, lines: nonEmptyArray, passthrough: nonNullObject }),
    validFields(credits.data[0], { id: stringValue, customer_id: stringValue, amount: decimal, currency: stringValue, reason: nullableString, issued_at: timestamp, passthrough: nonNullObject }),
    validFields(payments.data[0], { id: stringValue, customer_id: stringValue, invoice_id: nullableString, amount: decimal, currency: stringValue, status: stringValue, paid_at: timestamp, passthrough: nonNullObject }),
    validFields(refunds.data[0], { id: stringValue, payment_id: stringValue, amount: decimal, currency: stringValue, reason: nullableString, refunded_at: timestamp, passthrough: nonNullObject }),
  ];
  return checks.every(Boolean)
    ? { passed: true, message: "all seven entity types map every common field with decimal-string money" }
    : { passed: false, message: "one or more entity pages were empty, incomplete, or used non-string money" };
}

async function consumeCustomers(connector: Connector): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  let pages = 0;
  do {
    const page = await connector.listCustomers(null, cursor);
    count += page.data.length;
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 100_000) throw new Error("pagination did not terminate");
  } while (cursor !== null);
  return count;
}

export async function assessConnectorContract(
  setup: () => Promise<ConnectorContractSetup>,
  options: ContractAssessmentOptions = {},
): Promise<ConnectorContractResult> {
  const result = pendingResult();
  const { connector, fakeTarget } = await setup();

  await fakeTarget.configure({ failureMode: "none" });
  let pages: ConnectorPage<unknown>[] = [];
  try {
    pages = await firstPages(connector);
    result.dataMapping = mappingResult(pages);
  } catch (error) {
    result.dataMapping = {
      passed: false,
      message: `data mapping failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const writes = fakeTarget.requests.filter((request) => request.method !== "GET");
  result.readOnly = writes.length === 0
    ? { passed: true, message: "all observed connector traffic used GET" }
    : { passed: false, message: `observed forbidden ${writes[0].method} ${writes[0].path}` };

  await fakeTarget.configure({
    failureMode: options.failureMode ?? "rate_limited",
    failureRate: options.failureRate,
  });
  try {
    const count = await consumeCustomers(connector);
    result.failureSurvival = count > 0
      ? { passed: true, message: `completed paginated sync after injected failures (${count} records)` }
      : { passed: false, message: "paginated sync completed without returning records" };
  } catch (error) {
    result.failureSurvival = {
      passed: false,
      message: `paginated sync did not survive injected failures: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  result.shippable = result.readOnly.passed && result.dataMapping.passed && result.failureSurvival.passed;
  return result;
}

export function runConnectorContractSuite(
  setup: () => Promise<ConnectorContractSetup>,
): ConnectorContractResult {
  const result = pendingResult();
  describe("connector contract", () => {
    beforeAll(async () => Object.assign(result, await assessConnectorContract(setup)));

    it("is read-only at the network boundary", () => {
      expect(result.readOnly, result.readOnly.message).toMatchObject({ passed: true });
    });

    it("maps all common entity fields without losing decimal money precision", () => {
      expect(result.dataMapping, result.dataMapping.message).toMatchObject({ passed: true });
    });

    it("survives bounded upstream API failures", () => {
      expect(result.failureSurvival, result.failureSurvival.message).toMatchObject({ passed: true });
      expect(result.shippable).toBe(true);
    });
  });
  return result;
}
