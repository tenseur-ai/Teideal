// TEID-66 cross-tenant regression: mapping billed Stripe lines stays inside
// the caller's tenant. Running the mapper as one tenant must never read,
// create, or touch another tenant's connector_records/verify_billed_lines.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, loadFixtures, TS_CONSOLE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
// teideal_app has no DELETE grant on stripe_customer_links (by design --
// production only ever updates it). A superuser connection is used only
// for this test's own teardown, never for the actual request-path
// assertions, which all go through the app-role pool above to accurately
// exercise RLS the same way every other cross-tenant test does.
const superPool = new pg.Pool({
  connectionString: process.env.SUPERUSER_DATABASE_URL
    ?? "postgres://postgres:postgres@127.0.0.1:5432/teideal",
});
const ATTACKER_OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
let fx: Fixtures;
let attackerToken: string;
let victimConnectorId: string;
let victimCustomerId: string;

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
  // Seed a victim (tenant2) invoice with a resolvable customer link, so a
  // leak would actually have something mappable to show up as. A dedicated
  // customer is created here rather than reusing the shared tenant2
  // fixture customer, since stripe_customer_links has a UNIQUE constraint
  // on customer_id alone and the shared fixture customer may already have
  // a link from other test files.
  victimConnectorId = randomUUID();
  victimCustomerId = randomUUID();
  await withTenant(fx.tenant2.id, async (client) => {
    await client.query(
      `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, 'Verify Isolation Victim', $3)`,
      [victimCustomerId, fx.tenant2.id, `${victimCustomerId}@verify-isolation.example.test`],
    );
    await client.query(
      `INSERT INTO connectors (id, tenant_id, connector_type, display_name) VALUES ($1, $2, 'stripe', 'verify-isolation-victim')`,
      [victimConnectorId, fx.tenant2.id],
    );
    await client.query(
      `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
       VALUES ($1, $2, 'cus_victim_verify', 'stripe_id')`,
      [fx.tenant2.id, victimCustomerId],
    );
    await client.query(
      `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
       VALUES ($1, $2, 'invoice', 'in_victim_verify', $3::jsonb)`,
      [fx.tenant2.id, victimConnectorId, JSON.stringify({
        id: "in_victim_verify",
        customer_id: "cus_victim_verify",
        amount: "0",
        currency: "USD",
        status: "open",
        issued_at: "2026-09-01T00:00:00.000Z",
        lines: [{
          id: "il_victim_verify",
          invoice_id: "in_victim_verify",
          price_id: "price_victim",
          period_start: "2026-08-01T00:00:00.000Z",
          period_end: "2026-09-01T00:00:00.000Z",
          quantity: "1",
          amount: "999.00",
          currency: "USD",
          passthrough: {},
        }],
        passthrough: {},
      })],
    );
  });
});

afterAll(async () => {
  await withTenant(fx.tenant2.id, async (client) => {
    await client.query("DELETE FROM connectors WHERE id = $1", [victimConnectorId]);
  });
  // FK order: the link references the customer, so it must go first.
  await superPool.query("DELETE FROM stripe_customer_links WHERE customer_id = $1", [victimCustomerId]);
  await superPool.query("DELETE FROM customers WHERE id = $1", [victimCustomerId]);
  await pool.end();
  await superPool.end();
});

describe("TEID-66 cross-tenant verify billed-line mapping isolation", () => {
  it("POST /verify/map-billed-lines never maps or reads another tenant's invoice lines", async () => {
    const response = await call<{ mapped_lines: number; unmapped_customers: number }>(
      `${TS_CONSOLE_URL}/verify/map-billed-lines`,
      { method: "POST", token: attackerToken, body: {} },
    );
    expect(response.status).toBe(200);

    const leaked = await withTenant(fx.tenant1.id, async (client) => (await client.query(
      `SELECT id FROM verify_billed_lines WHERE stripe_invoice_line_id = 'il_victim_verify'`,
    )).rowCount);
    expect(leaked).toBe(0);

    const victimRowIntact = await withTenant(fx.tenant2.id, async (client) => (await client.query(
      `SELECT id FROM verify_billed_lines WHERE stripe_invoice_line_id = 'il_victim_verify'`,
    )).rowCount);
    expect(victimRowIntact).toBe(0);
  });
});
