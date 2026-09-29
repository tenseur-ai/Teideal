// TEID-74: Teideal identifiers stay the join keys. A Stripe customer id is
// only a reference on stripe_customer_links, and it still resolves after
// stripe_connections.status flips to disconnected.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const ROLES = ["Owner", "Billing Admin"] as const;

interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  parent_customer_id: string | null;
  balance_mode: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TransactionRow {
  id: string;
  customer_id: string;
  usage_event_id: string | null;
  grant_id: string | null;
  reservation_id: string | null;
  pricing_rule_id: string | null;
  plan_version: number | null;
  reverses_transaction_id: string | null;
  description: string | null;
  created_at: Date | string;
}

interface LineRow {
  id: string;
  transaction_id: string;
  account_code: string;
  direction: string;
  amount: string;
  created_at: Date | string;
}

interface LedgerSnapshot {
  ledger_transactions: Record<string, unknown>[];
}

function goUsageUrl(): string {
  return (process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082").replace(/\/+$/, "");
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function integerOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// go-usage encodes decimal.Decimal as a JSON number (shopspring's MarshalJSON
// writes the decimal text unquoted). Keep whichever form comes back, as text,
// so two calls over the same ledger compare the same way.
function balanceText(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  return null;
}

function publicCustomer(row: CustomerRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    email: row.email,
    parent_customer_id: row.parent_customer_id,
    balance_mode: row.balance_mode,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function publicLine(row: LineRow): Record<string, unknown> {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    account_code: row.account_code,
    direction: row.direction,
    amount: row.amount,
    created_at: iso(row.created_at),
  };
}

function publicTransaction(row: TransactionRow, lines: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: row.id,
    customer_id: row.customer_id,
    usage_event_id: row.usage_event_id,
    grant_id: row.grant_id,
    reservation_id: row.reservation_id,
    pricing_rule_id: row.pricing_rule_id,
    plan_version: integerOrNull(row.plan_version),
    reverses_transaction_id: row.reverses_transaction_id,
    description: row.description,
    created_at: iso(row.created_at),
    lines,
  };
}

// go-usage only accepts a tenant API key, and api_keys stores the hash.
// Mint one for this call and revoke it before returning. The plaintext
// stays in memory and expires within two minutes if revocation is interrupted.
async function withEphemeralAdminKey<T>(
  pool: Pool,
  tenantId: string,
  fn: (apiKey: string) => Promise<T>,
): Promise<T> {
  const plaintext = `sk_test_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (
       issued_to_tenant_id, key_hash, label, scope, environment, display_hint, expires_at
     ) VALUES (
       $1, $2, 'processor-neutrality-internal', 'admin', 'sandbox', 'sk_test_****neut',
       now() + interval '2 minutes'
     )
     RETURNING id`,
    [tenantId, hash],
  );
  const keyId = inserted.rows[0]?.id;
  if (!keyId) throw new Error("failed to mint internal api key");
  try {
    return await fn(plaintext);
  } finally {
    await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [keyId]);
  }
}

async function readLedgerSnapshot(pool: Pool, tenantId: string, customerId: string): Promise<LedgerSnapshot | null> {
  return withTenant(pool, tenantId, async (client) => {
    const visible = (await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE id = $1`,
      [customerId],
    )).rows[0];
    if (!visible) return null;

    const transactions = (await client.query<TransactionRow>(
      `SELECT id, customer_id, usage_event_id, grant_id, reservation_id,
              pricing_rule_id, plan_version, reverses_transaction_id,
              description, created_at
       FROM ledger_transactions
       WHERE customer_id = $1
       ORDER BY id`,
      [customerId],
    )).rows;
    const lines = (await client.query<LineRow>(
      `SELECT ll.id, ll.transaction_id, ll.account_code, ll.direction, ll.amount::text AS amount, ll.created_at
       FROM ledger_lines ll
       JOIN ledger_transactions lt ON lt.id = ll.transaction_id
       WHERE lt.customer_id = $1
       ORDER BY ll.id`,
      [customerId],
    )).rows;

    const linesByTransaction = new Map<string, Record<string, unknown>[]>();
    for (const line of lines) {
      const group = linesByTransaction.get(line.transaction_id) ?? [];
      group.push(publicLine(line));
      linesByTransaction.set(line.transaction_id, group);
    }
    return {
      ledger_transactions: transactions.map((row) => publicTransaction(row, linesByTransaction.get(row.id) ?? [])),
    };
  });
}

// RecalculateCustomerBalance returns a fresh recalculated_at, and Go encodes
// map key order randomly. Keep the financial fields so an unchanged ledger
// produces a byte-stable snapshot. The cache write stays inside go-usage;
// the ledger read above has already committed.
async function recalculateReceivable(
  pool: Pool,
  tenantId: string,
  customerId: string,
): Promise<{ ok: true; balance: Record<string, string> } | { ok: false; status: number; error: string }> {
  return withEphemeralAdminKey(pool, tenantId, async (apiKey) => {
    let response: Response;
    try {
      response = await fetch(
        `${goUsageUrl()}/customers/${customerId}/recalculate-balance?account_code=receivable`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (err) {
      console.error("processor lookup: recalculate-balance request failed:", err instanceof Error ? err.message : err);
      return { ok: false, status: 502, error: "balance recalculation failed" };
    }
    const text = await response.text();
    let body: { customer_id?: unknown; account_code?: unknown; balance?: unknown; error?: unknown } | null = null;
    try {
      body = text ? JSON.parse(text) as { customer_id?: unknown; account_code?: unknown; balance?: unknown; error?: unknown } : null;
    } catch {
      body = null;
    }
    if (response.status === 404) return { ok: false, status: 404, error: "customer not found" };
    const balance = balanceText(body?.balance);
    if (!response.ok || !body || body.customer_id !== customerId || body.account_code !== "receivable" || balance === null) {
      console.error(`processor lookup: recalculate-balance returned ${response.status}`);
      return { ok: false, status: 502, error: "balance recalculation failed" };
    }
    return {
      ok: true,
      balance: { customer_id: customerId, account_code: "receivable", balance },
    };
  });
}

export function registerProcessorLookupRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "get", "/stripe/customers/by-stripe-id/:stripeCustomerId", { role: [...ROLES] }, async (req, reply) => {
      const { stripeCustomerId } = req.params as { stripeCustomerId: string };
      if (!STRIPE_CUSTOMER_ID_RE.test(stripeCustomerId)) {
        return reply.code(400).send({ error: "stripeCustomerId must be a Stripe customer id" });
      }
      const { tenantId } = req.consolePrincipal!;
      // Status of stripe_connections is intentionally not consulted. Disconnect
      // leaves the reference row in place (TEID-38).
      const found = await withTenant(pool, tenantId, async (client) => {
        const link = (await client.query<{ customer_id: string; stripe_customer_id: string }>(
          `SELECT customer_id, stripe_customer_id
           FROM stripe_customer_links
           WHERE stripe_customer_id = $1
           ORDER BY created_at, id
           LIMIT 1`,
          [stripeCustomerId],
        )).rows[0];
        if (!link) return null;
        const customer = (await client.query<CustomerRow>(
          `SELECT id, tenant_id, name, email, parent_customer_id, balance_mode, created_at, updated_at
           FROM customers WHERE id = $1`,
          [link.customer_id],
        )).rows[0];
        if (!customer) return null;
        return { link, customer };
      });
      if (!found) return reply.code(404).send({ error: "stripe customer link not found" });
      return reply.send({
        customer_id: found.link.customer_id,
        stripe_customer_id: found.link.stripe_customer_id,
        customer: publicCustomer(found.customer),
      });
    });

    consoleRoute(scoped, "get", "/processor-neutrality/disconnect-check", { role: [...ROLES] }, async (req, reply) => {
      const query = (req.query ?? {}) as { customerId?: unknown };
      const customerId = query.customerId;
      if (typeof customerId !== "string" || !UUID_RE.test(customerId)) {
        return reply.code(400).send({ error: "customerId must be a UUID" });
      }
      const { tenantId } = req.consolePrincipal!;
      const ledger = await readLedgerSnapshot(pool, tenantId, customerId);
      if (!ledger) return reply.code(404).send({ error: "customer not found" });
      const balance = await recalculateReceivable(pool, tenantId, customerId);
      if (!balance.ok) return reply.code(balance.status).send({ error: balance.error });
      return reply.send({
        customer_id: customerId,
        ledger_transactions: ledger.ledger_transactions,
        balance: balance.balance,
      });
    });
  });
}
