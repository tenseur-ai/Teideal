// TEID-74. Invoice and payment tables do not exist. A ledger_transactions row
// stands in for an invoice, and a ledger_lines row with account_code = 'cash'
// stands in for a payment. Stripe ids live only on stripe_customer_links.
// Reuses tests/stripe-connect's session fixture and the running fake Stripe.
import "../stripe-connect/env.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { pool, superPool, withTenant } from "./db.js";
import { FAKE_STRIPE_URL, TENANT_ID, TS_CONSOLE_URL } from "../stripe-connect/env.js";
import { call } from "../stripe-connect/http.js";
import { billingSession } from "../stripe-connect/session.js";

const GO_USAGE_URL = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
// Plaintext admin key seeded for acct_1001 by db/seed-test-fixtures.sh.
const ADMIN_API_KEY = "devkey_1001";
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const MONTH_AMOUNTS = ["10.00", "20.00", "30.00", "40.00", "50.00", "60.00"];

interface BulkMarker {
  namePrefix: string;
  stripePrefix: string;
}

const bulkMarkers: BulkMarker[] = [];
let token: string;

function requestWithoutRedirect(target: string): Promise<{ status: number; location: string | null }> {
  const url = new URL(target);
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(url, { method: "GET" }, (res) => {
      res.resume();
      const location = res.headers.location;
      resolve({
        status: res.statusCode ?? 0,
        location: Array.isArray(location) ? location[0] ?? null : location ?? null,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function redeem(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const redirected = await requestWithoutRedirect(authorizeUrl);
  expect(redirected.status).toBe(302);
  expect(redirected.location).toBeTruthy();
  const location = new URL(redirected.location!, authorizeUrl);
  const code = location.searchParams.get("code");
  const state = location.searchParams.get("state");
  expect(code).toBeTruthy();
  expect(state).toBeTruthy();
  return { code: code!, state: state! };
}

async function connectReadOnly(sessionToken: string): Promise<{ id: string }> {
  const started = await call(`${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=read_only`, { token: sessionToken });
  expect(started.status).toBe(200);
  const redeemed = await redeem(started.body.url);
  const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
    method: "POST",
    token: sessionToken,
    body: { code: redeemed.code, state: redeemed.state },
  });
  expect(created.status).toBe(201);
  expect(created.body.status).toBe("connected");
  return { id: created.body.id as string };
}

async function disconnect(sessionToken: string, connectionId: string) {
  return call(`${TS_CONSOLE_URL}/stripe/connections/${connectionId}/disconnect`, {
    method: "POST",
    token: sessionToken,
    body: {},
  });
}

async function insertCustomer(name: string, email: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) => {
    const row = (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, name, email],
    )).rows[0];
    if (!row) throw new Error("customer insert returned no row");
    return row.id;
  });
}

async function insertLink(customerId: string, stripeCustomerId: string): Promise<void> {
  await withTenant(TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
       VALUES ($1, $2, $3, 'stripe_id')`,
      [TENANT_ID, customerId, stripeCustomerId],
    );
  });
}

async function postLedger(
  customerId: string,
  description: string,
  lines: Array<{ account_code: string; direction: "debit" | "credit"; amount: string }>,
): Promise<{ id: string; lines: Array<{ id: string; account_code: string }> }> {
  const response = await fetch(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: customerId, description, lines }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as { id?: string; lines?: Array<{ id: string; account_code: string }>; error?: string } : {};
  if (response.status !== 201 || !body.id || !body.lines) {
    throw new Error(`PostTransaction failed: ${response.status} ${text}`);
  }
  return { id: body.id, lines: body.lines };
}

async function seedSixMonths(customerId: string, label: string): Promise<string[]> {
  const descriptions: string[] = [];
  for (let i = 0; i < MONTHS.length; i++) {
    const description = `${label} invoice ${MONTHS[i]}`;
    descriptions.push(description);
    await postLedger(customerId, description, [
      { account_code: "receivable", direction: "debit", amount: MONTH_AMOUNTS[i] },
      { account_code: "revenue", direction: "credit", amount: MONTH_AMOUNTS[i] },
    ]);
  }
  return descriptions;
}

async function disconnectCheck(sessionToken: string, customerId: string): Promise<{ status: number; text: string; body: any }> {
  const response = await fetch(
    `${TS_CONSOLE_URL}/processor-neutrality/disconnect-check?customerId=${encodeURIComponent(customerId)}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } },
  );
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, text, body };
}

async function lookupByStripeId(sessionToken: string, stripeCustomerId: string) {
  const started = performance.now();
  const response = await call(
    `${TS_CONSOLE_URL}/stripe/customers/by-stripe-id/${encodeURIComponent(stripeCustomerId)}`,
    { token: sessionToken },
  );
  return { response, elapsedMs: performance.now() - started };
}

async function connectedIds(): Promise<string[]> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `SELECT id FROM stripe_connections WHERE status = 'connected' ORDER BY id`,
    )).rows.map((row) => row.id),
  );
}

async function cleanupMarker(marker: BulkMarker): Promise<void> {
  // A plain DELETE of 100,000 customers checks every foreign key that
  // references customers, which is too slow for this hook. The superuser
  // session skips those triggers only while removing this fixture. Child
  // rows created by the fixture are deleted in the same transaction.
  const client = await superPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM stripe_customer_links
       WHERE starts_with(stripe_customer_id, $1)
          OR customer_id IN (SELECT id FROM customers WHERE starts_with(name, $2))`,
      [marker.stripePrefix, marker.namePrefix],
    );
    await client.query(
      `DELETE FROM customer_balance_cache
       WHERE customer_id IN (SELECT id FROM customers WHERE starts_with(name, $1))`,
      [marker.namePrefix],
    );
    await client.query(
      `DELETE FROM customers WHERE starts_with(name, $1)`,
      [marker.namePrefix],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  token = await billingSession();
});

afterAll(async () => {
  try {
    for (const marker of bulkMarkers) await cleanupMarker(marker);
  } finally {
    await superPool.end();
    await pool.end();
  }
});

describe("TEID-74 processor-neutral ledger", () => {
  it("TEID-74-T1 stores Teideal ids on the customer, invoice, and payment, and the Stripe id only as a reference", async () => {
    const tag = randomUUID();
    const stripeCustomerId = `cus_teid74_t1_${tag}`;
    const customerId = await insertCustomer(`TEID-74-T1-${tag}`, `teid74-t1-${tag}@example.test`);
    await insertLink(customerId, stripeCustomerId);
    const invoice = await postLedger(customerId, `teid74-t1-invoice-${tag}`, [
      { account_code: "receivable", direction: "debit", amount: "80.00" },
      { account_code: "revenue", direction: "credit", amount: "80.00" },
    ]);
    const payment = await postLedger(customerId, `teid74-t1-payment-${tag}`, [
      { account_code: "cash", direction: "debit", amount: "30.00" },
      { account_code: "receivable", direction: "credit", amount: "30.00" },
    ]);

    const stored = await withTenant(TENANT_ID, async (client) => {
      const customer = (await client.query<{ id: string }>(
        `SELECT id FROM customers WHERE id = $1`,
        [customerId],
      )).rows[0];
      const link = (await client.query<{ customer_id: string; stripe_customer_id: string }>(
        `SELECT customer_id, stripe_customer_id FROM stripe_customer_links WHERE customer_id = $1`,
        [customerId],
      )).rows[0];
      const cash = (await client.query<{ id: string; transaction_id: string; customer_id: string }>(
        `SELECT l.id, l.transaction_id, t.customer_id
         FROM ledger_lines l
         JOIN ledger_transactions t ON t.id = l.transaction_id
         WHERE t.customer_id = $1 AND l.account_code = 'cash'`,
        [customerId],
      )).rows;
      const docs = (await client.query<{ doc: unknown }>(
        `SELECT row_to_json(c) AS doc FROM customers c WHERE c.id = $1
         UNION ALL
         SELECT row_to_json(t) FROM ledger_transactions t WHERE t.customer_id = $1
         UNION ALL
         SELECT row_to_json(l) FROM ledger_lines l
           JOIN ledger_transactions t ON t.id = l.transaction_id
          WHERE t.customer_id = $1`,
        [customerId],
      )).rows;
      return { customer, link, cash, docs };
    });

    expect(stored.customer?.id).toBe(customerId);
    expect(customerId).toMatch(UUID_TEXT);
    expect(invoice.id).toMatch(UUID_TEXT);
    expect(payment.id).toMatch(UUID_TEXT);
    expect(stored.link?.customer_id).toBe(customerId);
    expect(stored.link?.stripe_customer_id).toBe(stripeCustomerId);
    expect(stripeCustomerId).not.toMatch(UUID_TEXT);
    expect(stored.cash).toHaveLength(1);
    expect(stored.cash[0].id).toMatch(UUID_TEXT);
    expect(stored.cash[0].transaction_id).toBe(payment.id);
    expect(stored.cash[0].customer_id).toBe(customerId);
    for (const row of stored.docs) {
      expect(JSON.stringify(row.doc)).not.toContain(stripeCustomerId);
    }

    const stripeOnFinancial = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('customers', 'ledger_transactions', 'ledger_lines', 'usage_events')
         AND column_name ILIKE '%stripe%'`,
    );
    expect(stripeOnFinancial.rows).toEqual([]);

    const referenceTables = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT c1.table_name
       FROM information_schema.columns c1
       JOIN information_schema.columns c2
         ON c2.table_schema = c1.table_schema AND c2.table_name = c1.table_name
       WHERE c1.table_schema = 'public'
         AND c1.column_name = 'customer_id'
         AND c2.column_name ILIKE '%stripe%'
       ORDER BY c1.table_name`,
    );
    // period_close_invoice_line_items (TEID-39) stores stripe_invoice_item_id
    // the same way stripe_customer_links stores stripe_customer_id -- a
    // non-primary-key reference column, never the row's own identity. This
    // allowlist is of known-safe reference tables, not a rule against a
    // second one existing.
    expect(referenceTables.rows.map((row) => row.table_name)).toEqual(
      ["period_close_invoice_line_items", "stripe_customer_links"],
    );

    // information_schema.constraint_column_usage is empty for teideal_app
    // (it only lists constraints owned by the current user). pg_catalog is
    // visible and is the real foreign-key definition.
    const joins = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT src.relname AS table_name, att.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
       JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = ANY (con.conkey)
       WHERE con.contype = 'f'
         AND n.nspname = 'public'
         AND dst.relname = 'customers'
         AND att.attname = 'customer_id'`,
    );
    const joinKeys = new Set(joins.rows.map((row) => `${row.table_name}.${row.column_name}`));
    expect(joinKeys.has("ledger_transactions.customer_id")).toBe(true);
    expect(joinKeys.has("usage_events.customer_id")).toBe(true);
  });

  it("TEID-74-T2 keeps six months of ledger history byte-identical after Stripe disconnect", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer(`TEID-74-T2-${tag}`, `teid74-t2-${tag}@example.test`);
    const descriptions = await seedSixMonths(customerId, `teid74-t2-${tag}`);
    const connection = await connectReadOnly(token);

    const before = await disconnectCheck(token, customerId);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.ledger_transactions).toHaveLength(6);
    expect(before.body.ledger_transactions.map((row: { description: string }) => row.description).sort())
      .toEqual([...descriptions].sort());

    const disconnected = await disconnect(token, connection.id);
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.status).toBe("disconnected");

    const after = await disconnectCheck(token, customerId);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(JSON.stringify(after.body.ledger_transactions)).toBe(JSON.stringify(before.body.ledger_transactions));
    expect(after.body.ledger_transactions).toHaveLength(6);
    for (const description of descriptions) {
      const invoice = after.body.ledger_transactions.find((row: { description: string }) => row.description === description);
      expect(invoice?.id).toMatch(UUID_TEXT);
      expect(invoice?.lines).toHaveLength(2);
    }
  });

  it("TEID-74-T3 keeps the recalculated balance byte-identical after Stripe disconnect", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer(`TEID-74-T3-${tag}`, `teid74-t3-${tag}@example.test`);
    await seedSixMonths(customerId, `teid74-t3-${tag}`);
    const connection = await connectReadOnly(token);

    const before = await disconnectCheck(token, customerId);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.balance.account_code).toBe("receivable");
    expect(before.body.balance.customer_id).toBe(customerId);
    expect(Number(before.body.balance.balance)).toBe(210);

    const disconnected = await disconnect(token, connection.id);
    expect(disconnected.status).toBe(200);

    const after = await disconnectCheck(token, customerId);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(JSON.stringify(after.body.balance)).toBe(JSON.stringify(before.body.balance));
    expect(after.text).toBe(before.text);
  });

  it("TEID-74-T4 runs this suite from the test job on every pull request", () => {
    const workflowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml");
    const workflow = YAML.parse(readFileSync(workflowPath, "utf8")) as {
      on?: { pull_request?: { paths?: unknown; "paths-ignore"?: unknown } | null; push?: { paths?: unknown } | null };
      jobs?: Record<string, {
        if?: unknown;
        "continue-on-error"?: unknown;
        needs?: string | string[];
        steps?: Array<{
          if?: unknown;
          "continue-on-error"?: unknown;
          "working-directory"?: string;
          run?: string;
        }>;
      }>;
    };
    const pullRequest = workflow.on?.pull_request;
    expect(pullRequest == null || pullRequest.paths == null).toBe(true);
    expect(pullRequest == null || pullRequest["paths-ignore"] == null).toBe(true);
    expect(workflow.on?.push == null || workflow.on.push.paths == null).toBe(true);

    const testJob = workflow.jobs?.test;
    expect(testJob).toBeTruthy();
    expect(testJob?.if).toBeUndefined();
    expect(testJob?.["continue-on-error"]).not.toBe(true);
    const step = testJob?.steps?.find((candidate) =>
      candidate["working-directory"] === "tests/processor-neutrality" && (candidate.run ?? "").includes("vitest run"),
    );
    expect(step, "expected an unconditional vitest step for tests/processor-neutrality").toBeTruthy();
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).not.toBe(true);
    expect(step?.run).not.toMatch(/testPathIgnorePatterns|paths-ignore|--exclude/);

    const needs = workflow.jobs?.deploy?.needs;
    const needed = Array.isArray(needs) ? needs : [needs];
    expect(needed).toContain("test");
  });

  it("TEID-74-T5 resolves Stripe ids in under 200ms for a connected and a disconnected processor", async () => {
    const tag = randomUUID();
    const marker: BulkMarker = {
      namePrefix: `TEID-74-T5-${tag}-`,
      stripePrefix: `cus_teid74_${tag}_`,
    };
    bulkMarkers.push(marker);
    const connectedStripeId = `${marker.stripePrefix}connected`;
    const disconnectedStripeId = `${marker.stripePrefix}disconnected`;
    const connectedCustomerId = await insertCustomer(`${marker.namePrefix}connected`, `teid74-t5-connected-${tag}@example.test`);
    const disconnectedCustomerId = await insertCustomer(`${marker.namePrefix}disconnected`, `teid74-t5-disconnected-${tag}@example.test`);
    await insertLink(connectedCustomerId, connectedStripeId);
    await insertLink(disconnectedCustomerId, disconnectedStripeId);

    await withTenant(TENANT_ID, async (client) => {
      await client.query(
        `WITH new_customers AS (
           INSERT INTO customers (tenant_id, name, email)
           SELECT $1::uuid,
                  $2::text || g::text,
                  'teid74-t5-' || $3::text || '-' || g::text || '@example.test'
           FROM generate_series(1, $4::int) AS g
           RETURNING id
         )
         INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
         SELECT $1::uuid, id, $5::text || id::text, 'stripe_id'
         FROM new_customers`,
        [TENANT_ID, marker.namePrefix, tag, 99_998, `${marker.stripePrefix}bulk_`],
      );
    });

    const seeded = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stripe_customer_links WHERE starts_with(stripe_customer_id, $1)`,
        [marker.stripePrefix],
      )).rows[0].n,
    );
    expect(seeded).toBe(100_000);

    await superPool.query("ANALYZE stripe_customer_links");
    const plan = await withTenant(TENANT_ID, async (client) => {
      const explained = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT customer_id
         FROM stripe_customer_links
         WHERE stripe_customer_id = $1
         ORDER BY created_at, id
         LIMIT 1`,
        [connectedStripeId],
      );
      return JSON.stringify(explained.rows);
    });
    expect(plan).toContain("stripe_customer_links_stripe_customer_id_idx");

    const connection = await connectReadOnly(token);
    expect(await connectedIds()).toContain(connection.id);
    const connectedLookup = await lookupByStripeId(token, connectedStripeId);
    expect(connectedLookup.response.status, JSON.stringify(connectedLookup.response.body)).toBe(200);
    expect(connectedLookup.response.body.customer_id).toBe(connectedCustomerId);
    expect(connectedLookup.response.body.stripe_customer_id).toBe(connectedStripeId);
    expect(connectedLookup.response.body.customer.id).toBe(connectedCustomerId);
    expect(connectedLookup.elapsedMs, `connected lookup took ${connectedLookup.elapsedMs}ms`).toBeLessThan(200);

    for (const id of await connectedIds()) {
      const disconnected = await disconnect(token, id);
      expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
    }
    expect(await connectedIds()).toEqual([]);

    const disconnectedLookup = await lookupByStripeId(token, disconnectedStripeId);
    expect(disconnectedLookup.response.status, JSON.stringify(disconnectedLookup.response.body)).toBe(200);
    expect(disconnectedLookup.response.body.customer_id).toBe(disconnectedCustomerId);
    expect(disconnectedLookup.response.body.stripe_customer_id).toBe(disconnectedStripeId);
    expect(disconnectedLookup.response.body.customer.id).toBe(disconnectedCustomerId);
    expect(disconnectedLookup.response.body.customer.name).toBe(`${marker.namePrefix}disconnected`);
    expect(disconnectedLookup.elapsedMs, `disconnected lookup took ${disconnectedLookup.elapsedMs}ms`).toBeLessThan(200);
  });

  it("TEID-74-T6 does not lose or partially write a payment posted while Stripe disconnects", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer(`TEID-74-T6-${tag}`, `teid74-t6-${tag}@example.test`);
    const connection = await connectReadOnly(token);
    const description = `teid74-t6-payment-${tag}`;

    const [posted, disconnected] = await Promise.all([
      fetch(`${GO_USAGE_URL}/ledger/transactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId,
          description,
          lines: [
            { account_code: "cash", direction: "debit", amount: "15.00" },
            { account_code: "receivable", direction: "credit", amount: "15.00" },
          ],
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() as { id?: string; error?: string } })),
      disconnect(token, connection.id),
    ]);

    const rows = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ id: string; line_count: number; net: string; accounts: string[] }>(
        `SELECT t.id,
                count(l.id)::int AS line_count,
                COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END), 0)::text AS net,
                COALESCE(array_agg(l.account_code ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '{}') AS accounts
         FROM ledger_transactions t
         LEFT JOIN ledger_lines l ON l.transaction_id = t.id
         WHERE t.customer_id = $1 AND t.description = $2
         GROUP BY t.id`,
        [customerId, description],
      )).rows,
    );

    expect([200, 400]).toContain(disconnected.status);
    if (posted.status === 201) {
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(posted.body.id);
      expect(rows[0].line_count).toBe(2);
      expect(Number(rows[0].net)).toBe(0);
      expect([...rows[0].accounts].sort()).toEqual(["cash", "receivable"]);
    } else {
      expect(rows).toEqual([]);
    }
    expect(rows.every((row) => row.line_count === 2 && Number(row.net) === 0)).toBe(true);
  });

  it("TEID-74-T7 resolves a disconnected processor id to the same Teideal customer", async () => {
    const tag = randomUUID();
    const stripeCustomerId = `cus_teid74_t7_${tag}`;
    const customerId = await insertCustomer(`TEID-74-T7-${tag}`, `teid74-t7-${tag}@example.test`);
    await insertLink(customerId, stripeCustomerId);
    const before = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{
        id: string;
        tenant_id: string;
        name: string;
        email: string;
        parent_customer_id: string | null;
        balance_mode: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, tenant_id, name, email, parent_customer_id, balance_mode, created_at, updated_at
         FROM customers WHERE id = $1`,
        [customerId],
      )).rows[0],
    );
    const connection = await connectReadOnly(token);
    const disconnected = await disconnect(token, connection.id);
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.status).toBe("disconnected");

    const resolved = await lookupByStripeId(token, stripeCustomerId);
    expect(resolved.response.status, JSON.stringify(resolved.response.body)).toBe(200);
    expect(resolved.response.body.customer_id).toBe(customerId);
    expect(resolved.response.body.stripe_customer_id).toBe(stripeCustomerId);
    expect(resolved.response.body.customer).toEqual({
      id: before.id,
      tenant_id: before.tenant_id,
      name: before.name,
      email: before.email,
      parent_customer_id: before.parent_customer_id,
      balance_mode: before.balance_mode,
      created_at: before.created_at.toISOString(),
      updated_at: before.updated_at.toISOString(),
    });

    const linkCount = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stripe_customer_links WHERE customer_id = $1 AND stripe_customer_id = $2`,
        [customerId, stripeCustomerId],
      )).rows[0].n,
    );
    expect(linkCount).toBe(1);
    const status = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ status: string }>(
        `SELECT status FROM stripe_connections WHERE id = $1`,
        [connection.id],
      )).rows[0].status,
    );
    expect(status).toBe("disconnected");
  });
});
