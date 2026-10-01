// TEID-68 cross-tenant regression: the discrepancy report stays inside the
// caller's tenant. Running it as one tenant must never read, list, or total
// another tenant's verify_billed_lines, connector_records, or ledger/usage
// activity -- whether that activity is mapped or still unmapped.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const superPool = new pg.Pool({
  connectionString: process.env.SUPERUSER_DATABASE_URL
    ?? "postgres://postgres:postgres@127.0.0.1:5432/teideal",
});
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
let victimConnectorId: string;
let victimMappedCustomerId: string;
let victimUnmappedInvoiceId: string;

async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = loadFixtures();
  attackerToken = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant1.id, ATTACKER_OWNER_ID, createHash("sha256").update(attackerToken).digest("hex")],
  );

  victimConnectorId = randomUUID();
  victimMappedCustomerId = randomUUID();
  victimUnmappedInvoiceId = `in_victim_disc_unmapped_${randomUUID()}`;

  await withTenant(fx.tenant2.id, async (client) => {
    await client.query(
      `INSERT INTO connectors (id, tenant_id, connector_type, display_name) VALUES ($1, $2, 'stripe', 'verify-disc-isolation-victim')`,
      [victimConnectorId, fx.tenant2.id],
    );
    // A mapped line with a large billed total: if this leaked into the
    // attacker's report it would show up as a huge, hard-to-miss delta.
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, 'Verify Discrepancy Victim', $3)`,
      [victimMappedCustomerId, fx.tenant2.id, `${victimMappedCustomerId}@verify-disc-isolation.example.test`],
    );
    await client.query(
      `INSERT INTO verify_billed_lines (
         tenant_id, customer_id, connector_id, stripe_invoice_line_id,
         price_id, period_start, period_end, quantity, amount, currency
       ) VALUES ($1, $2, $3, 'il_victim_disc_mapped', 'price_victim_disc',
                 '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 999999.00, 'USD')`,
      [fx.tenant2.id, victimMappedCustomerId, victimConnectorId],
    );
    // An unmapped Stripe customer with its own invoice -- the path that
    // would otherwise surface in `excluded`/`totals.excluded_billed`.
    await client.query(
      `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
       VALUES ($1, $2, 'invoice', $3, $4::jsonb)`,
      [fx.tenant2.id, victimConnectorId, victimUnmappedInvoiceId, JSON.stringify({
        id: victimUnmappedInvoiceId,
        customer_id: "cus_victim_disc_unmapped",
        amount: "888888.00",
        currency: "USD",
        status: "open",
        issued_at: "2026-09-01T00:00:00.000Z",
        lines: [{
          id: "il_victim_disc_unmapped",
          invoice_id: victimUnmappedInvoiceId,
          price_id: "price_victim_disc",
          period_start: "2026-08-01T00:00:00.000Z",
          period_end: "2026-09-01T00:00:00.000Z",
          quantity: "1",
          amount: "888888.00",
          currency: "USD",
          passthrough: {},
        }],
        passthrough: {},
      })],
    );
  });
});

afterAll(async () => {
  // teideal_app has no DELETE grant on verify_billed_lines (TEID-66 only
  // ever inserts/updates it); the superuser pool handles teardown there,
  // same as stripe_customer_links in the sibling isolation test.
  await superPool.query("DELETE FROM verify_billed_lines WHERE customer_id = $1", [victimMappedCustomerId]);
  await withTenant(fx.tenant2.id, async (client) => {
    await client.query("DELETE FROM connectors WHERE id = $1", [victimConnectorId]);
  });
  await superPool.query("DELETE FROM customers WHERE id = $1", [victimMappedCustomerId]);
  await pool.end();
  await superPool.end();
});

describe("TEID-68 cross-tenant discrepancy report isolation", () => {
  it("GET /verify/discrepancy-report never lists or totals another tenant's billed or unmapped data", async () => {
    const response = await call<{
      data: Array<{ customer_id: string; expected_total: string; billed_total: string }>;
      excluded: Array<{ customer_id: string }>;
      totals: { expected: string; billed: string; excluded_billed: string };
    }>(`${TS_CONSOLE_URL}/verify/discrepancy-report?period=2026-08`, { token: attackerToken });
    expect(response.status).toBe(200);

    expect(response.body.data.some((row) => row.customer_id === victimMappedCustomerId)).toBe(false);
    expect(response.body.excluded.some((row) => row.customer_id === "cus_victim_disc_unmapped")).toBe(false);
    expect(response.body.totals.billed).not.toContain("999999");
    expect(response.body.totals.excluded_billed).not.toContain("888888");
  });
});
