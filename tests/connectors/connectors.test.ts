import { afterAll, describe, expect, it } from "vitest";
import type { Connector } from "../../services/ts-console/src/lib/connectors/connector.js";
import { ConnectorError } from "../../services/ts-console/src/lib/connectors/connector.js";
import {
  decodeConnectorCredentialEncryptionKey,
  decryptCredential,
  encryptCredential,
  loadConnectorCredentialEncryptionKey,
} from "../../services/ts-console/src/lib/connectors/credentials.js";
import { createConnectorHttpClient } from "../../services/ts-console/src/lib/connectors/httpClient.js";
import {
  currencyMinorDigits,
  MockConnector,
  type StripeLikeExport,
} from "../../services/ts-console/src/lib/connectors/mockConnector.js";
import { completeSync, startSync } from "../../services/ts-console/src/lib/connectors/syncHealth.js";
import { assessConnectorContract, runConnectorContractSuite } from "./contractSuite.js";
import { pool, withTenant } from "./db.js";
import { TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { startFakeConnectorTarget, type FakeConnectorTarget } from "./fake-connector-target.js";
import { call } from "./http.js";
import { billingSession, supportSession } from "./session.js";

const targets: FakeConnectorTarget[] = [];
const STREAMING_ACCEPTANCE_RECORD_COUNT = 500_000;

async function target(): Promise<FakeConnectorTarget> {
  const fake = await startFakeConnectorTarget();
  targets.push(fake);
  return fake;
}

function retryingMock(fake: FakeConnectorTarget, pageSize = 100): MockConnector {
  return new MockConnector({
    baseUrl: fake.baseUrl,
    pageSize,
    httpClient: createConnectorHttpClient({
      baseUrl: fake.baseUrl,
      maxAttempts: 5,
      baseDelayMs: 5,
      maxDelayMs: 20,
      timeoutMs: 2_000,
    }),
  });
}

class InterfaceOnlyConnector implements Connector {
  readonly connectorType = "interface_only";
  constructor(private readonly delegate: MockConnector) {}
  listCustomers(...args: Parameters<Connector["listCustomers"]>) { return this.delegate.listCustomers(...args); }
  listPrices(...args: Parameters<Connector["listPrices"]>) { return this.delegate.listPrices(...args); }
  listContracts(...args: Parameters<Connector["listContracts"]>) { return this.delegate.listContracts(...args); }
  listInvoices(...args: Parameters<Connector["listInvoices"]>) { return this.delegate.listInvoices(...args); }
  listCredits(...args: Parameters<Connector["listCredits"]>) { return this.delegate.listCredits(...args); }
  listPayments(...args: Parameters<Connector["listPayments"]>) { return this.delegate.listPayments(...args); }
  listRefunds(...args: Parameters<Connector["listRefunds"]>) { return this.delegate.listRefunds(...args); }
}

const newConnectorContract = runConnectorContractSuite(async () => {
  const fake = await target();
  return { connector: new InterfaceOnlyConnector(retryingMock(fake)), fakeTarget: fake };
});

afterAll(async () => {
  await Promise.all(targets.map((fake) => fake.stop()));
  await pool.end();
});

describe("TEID-98 connector framework", () => {
  it("TEID-98-T1 maps a realistic Stripe-shaped export into all seven common entity schemas", async () => {
    const fixtures: StripeLikeExport = {
      customers: [{ id: "cus_real", name: "Precision Labs", email: "billing@precision.test", created: 1_725_000_000 }],
      prices: [{ id: "price_real", product: { name: "API calls" }, unit_amount: 1001, currency: "usd", billing_scheme: "tiered", created: 1_725_000_010 }],
      contracts: [{ id: "sub_real", customer: { id: "cus_real" }, status: "active", start_date: 1_725_000_020, ended_at: null }],
      invoices: [{ id: "in_real", customer: "cus_real", amount_due: 9007199254740993n.toString(), currency: "usd", status: "open", created: 1_725_000_030, due_date: 1_727_592_030 }],
      credits: [{ id: "cn_real", customer: "cus_real", amount: 1, currency: "usd", reason: "adjustment", created: 1_725_000_040 }],
      payments: [{ id: "py_real", customer: "cus_real", invoice: "in_real", amount: 9007199254740992n.toString(), currency: "usd", status: "succeeded", created: 1_725_000_050 }],
      refunds: [{ id: "re_real", payment: "py_real", amount: 1, currency: "usd", reason: null, created: 1_725_000_060 }],
    };
    const connector = new MockConnector({ fixtures, pageSize: 10 });
    const [customers, prices, contracts, invoices, credits, payments, refunds] = await Promise.all([
      connector.listCustomers(null, null), connector.listPrices(null, null), connector.listContracts(null, null),
      connector.listInvoices(null, null), connector.listCredits(null, null), connector.listPayments(null, null),
      connector.listRefunds(null, null),
    ]);
    expect(customers.data[0]).toEqual({
      id: "cus_real", name: "Precision Labs", email: "billing@precision.test",
      created_at: "2024-08-30T06:40:00.000Z", external_updated_at: null, passthrough: {},
    });
    expect(prices.data[0]).toEqual({
      id: "price_real", product_name: "API calls", amount: "10.01", currency: "USD",
      billing_scheme: "tiered", interval: null, product_id: null, nickname: null,
      external_updated_at: null, passthrough: { created: 1_725_000_010 },
    });
    expect(contracts.data[0]).toEqual({
      id: "sub_real", customer_id: "cus_real", status: "active",
      started_at: "2024-08-30T06:40:20.000Z", ended_at: null,
      external_updated_at: null, passthrough: {},
    });
    expect(invoices.data[0]).toEqual({
      id: "in_real", customer_id: "cus_real", amount: "90071992547409.93", currency: "USD",
      status: "open", issued_at: "2024-08-30T06:40:30.000Z", due_at: "2024-09-29T06:40:30.000Z",
      number: null, period_start: null, period_end: null, subtotal: null, tax: null, lines: [],
      external_updated_at: null, passthrough: {},
    });
    expect(credits.data[0]).toEqual({
      id: "cn_real", customer_id: "cus_real", amount: "0.01", currency: "USD",
      reason: "adjustment", issued_at: "2024-08-30T06:40:40.000Z",
      external_updated_at: null, passthrough: {},
    });
    expect(payments.data[0]).toEqual({
      id: "py_real", customer_id: "cus_real", invoice_id: "in_real",
      amount: "90071992547409.92", currency: "USD", status: "succeeded",
      paid_at: "2024-08-30T06:40:50.000Z", processor_charge_id: null,
      external_updated_at: null, passthrough: {},
    });
    expect(refunds.data[0]).toEqual({
      id: "re_real", payment_id: "py_real", amount: "0.01", currency: "USD", reason: null,
      refunded_at: "2024-08-30T06:41:00.000Z", processor_refund_id: null,
      external_updated_at: null, passthrough: {},
    });
    for (const money of [prices.data[0].amount, invoices.data[0].amount, credits.data[0].amount, payments.data[0].amount, refunds.data[0].amount]) {
      expect(typeof money).toBe("string");
    }

    const key = Buffer.alloc(32, 17);
    const encrypted = encryptCredential("read-only-secret", key);
    expect(encrypted.ciphertext).not.toContain("read-only-secret");
    expect(decryptCredential(encrypted, key)).toBe("read-only-secret");
    expect(decodeConnectorCredentialEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => decodeConnectorCredentialEncryptionKey(Buffer.alloc(31).toString("base64")))
      .toThrow("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY must be base64 that decodes to 32 bytes");
    const previousKey = process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY;
    try {
      process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY = key.toString("base64");
      expect(loadConnectorCredentialEncryptionKey()).toEqual(key);
    } finally {
      if (previousKey === undefined) delete process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY = previousKey;
    }
  });

  it("TEID-98-T2 enforces 100 RPM and retries three 429s with computed exponential backoff", async () => {
    const fake = await target();
    await fake.configure({ failureMode: "rate_limited" });
    const client = createConnectorHttpClient({
      baseUrl: fake.baseUrl,
      requestsPerMinute: 100,
      maxAttempts: 5,
      baseDelayMs: 700,
      maxDelayMs: 5_000,
      timeoutMs: 2_000,
    });
    const recovered = await client.get("/v1/customers?limit=1");
    expect(recovered.status).toBe(200);
    const retryRequests = [...fake.requests];
    expect(retryRequests).toHaveLength(4);
    expect(retryRequests.map((request) => request.responseStatus)).toEqual([429, 429, 429, 200]);
    const retryGaps = retryRequests.slice(1).map((request, index) => request.receivedAt - retryRequests[index].receivedAt);
    expect(retryGaps[1]).toBeGreaterThan(retryGaps[0]);
    expect(retryGaps[2]).toBeGreaterThan(retryGaps[1]);

    await fake.configure({ failureMode: "none" });
    await Promise.all(Array.from({ length: 52 }, () => client.get("/v1/customers?limit=1")));
    const sustained = fake.requests;
    const elapsedMs = sustained.at(-1)!.receivedAt - sustained[0].receivedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
    const observedRpm = ((sustained.length - 1) * 60_000) / elapsedMs;
    expect(observedRpm).toBeLessThanOrEqual(101);
  }, 60_000);

  it("TEID-98-T3 marks a connector with hidden write traffic as not shippable", async () => {
    const fake = await target();
    const delegate = retryingMock(fake);
    class MisbehavingConnector extends InterfaceOnlyConnector {
      override async listCustomers(since: string | null, cursor: string | null) {
        await fetch(`${fake.baseUrl}/v1/customers/cus_001/close`, { method: "POST" });
        return super.listCustomers(since, cursor);
      }
    }
    const result = await assessConnectorContract(async () => ({
      connector: new MisbehavingConnector(delegate),
      fakeTarget: fake,
    }));
    expect(result.readOnly.passed).toBe(false);
    expect(result.readOnly.message).toContain("forbidden POST /v1/customers/cus_001/close");
    expect(result.shippable).toBe(false);
  });

  it("TEID-98-T4 returns Stripe and CSV connector sync health in one role-gated view", async () => {
    const ids = await withTenant(TENANT_ID, async (client) => {
      await client.query("DELETE FROM connectors WHERE display_name LIKE 'TEID-98 T4 %'");
      const { rows } = await client.query<{ id: string; connector_type: string }>(
        `INSERT INTO connectors (tenant_id, connector_type, display_name)
         VALUES ($1, 'stripe', 'TEID-98 T4 Stripe'), ($1, 'csv_mock', 'TEID-98 T4 CSV')
         RETURNING id, connector_type`,
        [TENANT_ID],
      );
      return Object.fromEntries(rows.map((row) => [row.connector_type, row.id])) as Record<string, string>;
    });
    const stripeSync = await startSync(pool, TENANT_ID, ids.stripe);
    await completeSync(pool, TENANT_ID, stripeSync, { status: "succeeded", recordsSynced: 42 });
    const csvSync = await startSync(pool, TENANT_ID, ids.csv_mock);
    await completeSync(pool, TENANT_ID, csvSync, { status: "failed", recordsSynced: 7, errorMessage: "bad row" });

    const token = await billingSession();
    const response = await call<{ data: Array<Record<string, unknown>> }>(`${TS_CONSOLE_URL}/connectors/sync-health`, { token });
    expect(response.status).toBe(200);
    const relevant = response.body.data.filter((row) => row.connector_id === ids.stripe || row.connector_id === ids.csv_mock);
    expect(relevant).toHaveLength(2);
    expect(relevant.find((row) => row.connector_id === ids.stripe)).toMatchObject({
      connector_type: "stripe", last_sync_status: "succeeded", consecutive_failures: 0,
      cursor_high_water: {},
    });
    expect(relevant.find((row) => row.connector_id === ids.csv_mock)).toMatchObject({
      connector_type: "csv_mock", last_sync_status: "failed", consecutive_failures: 1,
      cursor_high_water: {},
    });
    expect(relevant.every((row) => typeof row.last_sync_at === "string")).toBe(true);

    await withTenant(TENANT_ID, async (client) => {
      await client.query("DELETE FROM connectors WHERE id = ANY($1::uuid[])", [Object.values(ids)]);
    });
  });

  it("TEID-98-T5 streams 500,000 incrementally-synced records within 15 minutes and under 2GB RSS", async () => {
    const fake = await target();
    await fake.configure({ failureMode: "none", recordCount: STREAMING_ACCEPTANCE_RECORD_COUNT, pageSize: 5_000 });
    const connector = retryingMock(fake, 5_000);
    const startedAt = Date.now();
    let peakRss = process.memoryUsage().rss;
    let records = 0;
    let cursor: string | null = null;
    do {
      const page = await connector.listCustomers("2020-01-01T00:00:00.000Z", cursor);
      for (const row of page.data) {
        if (!row.id) throw new Error("streamed row is missing its id");
        records += 1;
      }
      cursor = page.nextCursor;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    } while (cursor !== null);
    expect(records).toBe(STREAMING_ACCEPTANCE_RECORD_COUNT);
    expect(Date.now() - startedAt).toBeLessThan(15 * 60_000);
    expect(peakRss).toBeLessThan(2 * 1024 * 1024 * 1024);
  }, 900_000);

  it("TEID-98-T6 runs the unchanged reusable suite against a base-interface-only connector", () => {
    expect(newConnectorContract.shippable).toBe(true);
    expect(newConnectorContract.readOnly.passed).toBe(true);
    expect(newConnectorContract.dataMapping.passed).toBe(true);
    expect(newConnectorContract.failureSurvival.passed).toBe(true);
  });

  it("TEID-98-T7 explicitly rejects an intermittent-500 target after retries exhaust", async () => {
    const fake = await target();
    await fake.configure({ failureMode: "none", recordCount: 25, pageSize: 1 });
    const result = await assessConnectorContract(
      async () => ({ connector: retryingMock(fake, 1), fakeTarget: fake }),
      { failureMode: "intermittent_5xx", failureRate: 0.1 },
    );
    expect(result.failureSurvival.passed).toBe(false);
    expect(result.failureSurvival.message).toContain("did not survive");
    expect(result.shippable).toBe(false);
    expect(fake.requests.filter((request) => request.responseStatus === 500).length).toBe(5);
  });

  it("TEID-98-T8 stops malformed-JSON retries at the configured ceiling with a clear error", async () => {
    const fake = await target();
    await fake.configure({ failureMode: "malformed_json" });
    const maxAttempts = 4;
    const client = createConnectorHttpClient({
      baseUrl: fake.baseUrl,
      maxAttempts,
      baseDelayMs: 1,
      maxDelayMs: 4,
      timeoutMs: 2_000,
    });
    const error = await client.get("/v1/customers?limit=1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).message).toContain(`failed after ${maxAttempts} attempts`);
    expect((error as ConnectorError).message).toContain("malformed JSON");
    expect((error as ConnectorError).retryable).toBe(false);
    expect(fake.requests).toHaveLength(maxAttempts);
  });
});

describe("TEID-98.1 connector landing-zone remediation", () => {
  it("TEID-98.1-T1 round-trips invoice lines and passthrough fields with decimal-string money", async () => {
    const fixtures: StripeLikeExport = {
      customers: [{
        id: "cus_rich", name: "Landing Zone Labs", email: null, created: 1_756_704_000,
        preferred_locale: "en-IN",
      }],
      prices: [],
      contracts: [],
      invoices: [{
        id: "in_rich",
        customer: "cus_rich",
        amount_due: 3850,
        currency: "usd",
        status: "open",
        created: 1_756_704_100,
        due_date: null,
        number: "INV-98.1",
        period_start: 1_756_704_000,
        period_end: 1_759_296_000,
        subtotal: 3500,
        tax: 350,
        billing_reason: "subscription_cycle",
        lines: [
          {
            id: "il_rich_1", price: "price_monthly", description: "Monthly platform",
            quantity: "2", unit_amount: 1500, amount: 3000, currency: "usd",
            period_start: 1_756_704_000, period_end: 1_759_296_000, discountable: true,
          },
          {
            id: "il_rich_2", price: null, description: "Usage overage",
            quantity: "5", unit_amount: 100, amount: 500, currency: "usd",
            period_start: 1_756_704_000, period_end: 1_759_296_000,
          },
        ],
      }],
      credits: [],
      payments: [],
      refunds: [],
    };
    const connector = new MockConnector({ fixtures });
    const [customers, invoices] = await Promise.all([
      connector.listCustomers(null, null),
      connector.listInvoices(null, null),
    ]);
    const invoice = invoices.data[0];

    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({
      invoice_id: "in_rich", price_id: "price_monthly", quantity: "2",
      unit_amount: "15.00", amount: "30.00", currency: "USD",
      passthrough: { discountable: true },
    });
    expect(invoice.lines[1]).toMatchObject({
      invoice_id: "in_rich", price_id: null, unit_amount: "1.00", amount: "5.00",
    });
    expect(invoice.passthrough.billing_reason).toBe("subscription_cycle");
    expect(customers.data[0].passthrough.preferred_locale).toBe("en-IN");
    for (const money of [
      invoice.amount, invoice.subtotal, invoice.tax,
      ...invoice.lines.flatMap((line) => [line.unit_amount, line.amount]),
    ]) {
      expect(typeof money).toBe("string");
    }
  });

  it("TEID-98.1-T2 converts 0-, 2-, and 3-decimal currencies using exact string arithmetic", async () => {
    const fixtures: StripeLikeExport = {
      customers: [],
      prices: [
        { id: "price_jpy", product: "prod_jpy", unit_amount: 100, currency: "jpy", billing_scheme: "per_unit" },
        { id: "price_usd", product: "prod_usd", unit_amount: 1001, currency: "usd", billing_scheme: "per_unit" },
        { id: "price_kwd", product: "prod_kwd", unit_amount: 1234, currency: "kwd", billing_scheme: "per_unit" },
      ],
      contracts: [], invoices: [], credits: [], payments: [], refunds: [],
    };
    const prices = (await new MockConnector({ fixtures, pageSize: 10 }).listPrices(null, null)).data;
    expect(prices.map(({ amount, currency }) => ({ amount, currency }))).toEqual([
      { amount: "100", currency: "JPY" },
      { amount: "10.01", currency: "USD" },
      { amount: "1.234", currency: "KWD" },
    ]);
    expect(currencyMinorDigits("jpy")).toBe(0);
    expect(currencyMinorDigits("usd")).toBe(2);
    expect(currencyMinorDigits("kwd")).toBe(3);
    expect(currencyMinorDigits("unknown")).toBe(2);
  });

  it("TEID-98.1-T3 advances watermarks only on success and caps stored failure text", async () => {
    const displayName = "TEID-98.1 T3 Watermark";
    const connectorId = await withTenant(TENANT_ID, async (client) => {
      await client.query("DELETE FROM connectors WHERE connector_type = 'csv_mock' AND display_name = $1", [displayName]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO connectors (tenant_id, connector_type, display_name)
         VALUES ($1, 'csv_mock', $2)
         RETURNING id`,
        [TENANT_ID, displayName],
      );
      return rows[0].id;
    });
    const successfulWatermark = {
      customers: { since: "2026-09-01T00:00:00Z", cursor: null },
      invoices: { since: "2026-09-01T00:00:00Z", cursor: "500" },
    };

    try {
      const successfulSync = await startSync(pool, TENANT_ID, connectorId);
      await completeSync(pool, TENANT_ID, successfulSync, {
        status: "succeeded", recordsSynced: 500, watermark: successfulWatermark,
      });
      const afterSuccess = await withTenant(TENANT_ID, async (client) => {
        const { rows } = await client.query<{ cursor_high_water: typeof successfulWatermark }>(
          "SELECT cursor_high_water FROM connectors WHERE id = $1",
          [connectorId],
        );
        return rows[0].cursor_high_water;
      });
      expect(afterSuccess).toEqual(successfulWatermark);

      const failedSync = await startSync(pool, TENANT_ID, connectorId);
      await completeSync(pool, TENANT_ID, failedSync, {
        status: "failed",
        recordsSynced: 7,
        errorMessage: "x".repeat(650),
        watermark: { customers: { since: "2026-09-30T00:00:00Z", cursor: "999" } },
      });
      const afterFailure = await withTenant(TENANT_ID, async (client) => {
        const { rows } = await client.query<{ cursor_high_water: typeof successfulWatermark; error_message: string }>(
          `SELECT c.cursor_high_water, s.error_message
           FROM connectors c
           JOIN connector_syncs s ON s.connector_id = c.id
           WHERE c.id = $1 AND s.id = $2`,
          [connectorId, failedSync],
        );
        return rows[0];
      });
      expect(afterFailure.cursor_high_water).toEqual(successfulWatermark);
      expect(afterFailure.error_message).toHaveLength(500);
    } finally {
      await withTenant(TENANT_ID, async (client) => {
        await client.query("DELETE FROM connectors WHERE id = $1", [connectorId]);
      });
    }
  });

  it("TEID-98.1-T4 keeps sync health forbidden to Support and available to Billing Admin", async () => {
    const [supportToken, billingToken] = await Promise.all([supportSession(), billingSession()]);
    const [denied, allowed] = await Promise.all([
      call(`${TS_CONSOLE_URL}/connectors/sync-health`, { token: supportToken }),
      call(`${TS_CONSOLE_URL}/connectors/sync-health`, { token: billingToken }),
    ]);
    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it("TEID-98.1-T5 preserves TEID-98's original suite and 500,000-record scale", () => {
    expect(STREAMING_ACCEPTANCE_RECORD_COUNT).toBe(500_000);
    expect(newConnectorContract.shippable).toBe(true);
  });

  it("TEID-98.1-T6 rejects duplicate tenant/type/display-name triples in the database", async () => {
    const displayName = "TEID-98.1 T6 Duplicate";
    await withTenant(TENANT_ID, async (client) => {
      await client.query("DELETE FROM connectors WHERE connector_type = 'stripe' AND display_name = $1", [displayName]);
      await client.query(
        `INSERT INTO connectors (tenant_id, connector_type, display_name)
         VALUES ($1, 'stripe', $2)`,
        [TENANT_ID, displayName],
      );
    });

    try {
      const duplicateError = await withTenant(TENANT_ID, async (client) => {
        await client.query(
          `INSERT INTO connectors (tenant_id, connector_type, display_name)
           VALUES ($1, 'stripe', $2)`,
          [TENANT_ID, displayName],
        );
      }).then(() => null).catch((error: unknown) => error as { code?: string });
      expect(duplicateError?.code).toBe("23505");
    } finally {
      await withTenant(TENANT_ID, async (client) => {
        await client.query("DELETE FROM connectors WHERE connector_type = 'stripe' AND display_name = $1", [displayName]);
      });
    }
  });
});
