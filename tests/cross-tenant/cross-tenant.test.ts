// TEID-41-T2 (Functional): cross-tenant regression suite across every API.
// TEID-41-T7 (Adversarial): SQL injection on a filter parameter.
// TEID-41-T8 (Adversarial): ID substitution on a PATCH endpoint.
//
// Throughout: tenant acct_1001 is the attacker, acct_1002 is the victim.
// Every case asserts not just a status code but that zero bytes of the
// victim's data crossed the boundary.
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, TS_CONSOLE_URL, GO_USAGE_URL, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;
let tenant1UsageEventId: string;
let tenant2UsageEventId: string;
let tenant1ReservationId: string;
let tenant2ReservationId: string;
let tenant1LedgerTransactionId: string;
let tenant2LedgerTransactionId: string;

beforeAll(async () => {
  fx = loadFixtures();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Seed one usage event per tenant so there is real victim data to try to
  // leak, not just an empty table that would trivially "pass". A run-unique
  // idempotency key keeps this safe to re-run against a database that
  // already has data from a previous run.
  const r1 = await call(`${GO_USAGE_URL}/usage`, {
    method: "POST",
    apiKey: fx.tenant1.apiKey,
    body: { customer_id: fx.tenant1.customerId, event_type: "api_call", quantity: 1, idempotency_key: `cross-tenant-seed-1001-${runId}` },
  });
  expect(r1.status).toBe(201);
  tenant1UsageEventId = r1.body.id;

  const r2 = await call(`${GO_USAGE_URL}/usage`, {
    method: "POST",
    apiKey: fx.tenant2.apiKey,
    body: { customer_id: fx.tenant2.customerId, event_type: "api_call", quantity: 1, idempotency_key: `cross-tenant-seed-1002-${runId}` },
  });
  expect(r2.status).toBe(201);
  tenant2UsageEventId = r2.body.id;

  const reservation1 = await call(`${GO_USAGE_URL}/reservations`, {
    method: "POST",
    apiKey: fx.tenant1.apiKey,
    body: { customer_id: fx.tenant1.customerId, usage_event_id: tenant1UsageEventId },
  });
  expect(reservation1.status).toBe(201);
  tenant1ReservationId = reservation1.body.id;

  const reservation2 = await call(`${GO_USAGE_URL}/reservations`, {
    method: "POST",
    apiKey: fx.tenant2.apiKey,
    body: { customer_id: fx.tenant2.customerId, usage_event_id: tenant2UsageEventId },
  });
  expect(reservation2.status).toBe(201);
  tenant2ReservationId = reservation2.body.id;

  const ledgerBody = (customerId: string, usageEventId: string, reservationId: string) => ({
    customer_id: customerId,
    usage_event_id: usageEventId,
    reservation_id: reservationId,
    lines: [
      { account_code: "receivable", direction: "debit", amount: "1.00" },
      { account_code: "revenue", direction: "credit", amount: "1.00" },
    ],
  });
  const ledger1 = await call(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    apiKey: fx.tenant1.apiKey,
    body: ledgerBody(fx.tenant1.customerId, tenant1UsageEventId, tenant1ReservationId),
  });
  expect(ledger1.status).toBe(201);
  tenant1LedgerTransactionId = ledger1.body.id;

  const ledger2 = await call(`${GO_USAGE_URL}/ledger/transactions`, {
    method: "POST",
    apiKey: fx.tenant2.apiKey,
    body: ledgerBody(fx.tenant2.customerId, tenant2UsageEventId, tenant2ReservationId),
  });
  expect(ledger2.status).toBe(201);
  tenant2LedgerTransactionId = ledger2.body.id;
});

describe("TEID-41-T2: cross-tenant regression across every API", () => {
  it("GET /customers/:id cannot read another tenant's customer", async () => {
    const res = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, { apiKey: fx.tenant1.apiKey });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(fx.tenant2.customerId);
  });

  it("GET /customers (list) never includes another tenant's rows", async () => {
    const res = await call(`${TS_CONSOLE_URL}/customers`, { apiKey: fx.tenant1.apiKey });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(fx.tenant2.customerId);
  });

  it("PATCH /customers/:id cannot write another tenant's customer", async () => {
    const res = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, {
      method: "PATCH",
      apiKey: fx.tenant1.apiKey,
      body: { name: "pwned by acct_1001" },
    });
    expect(res.status).toBe(403);

    const verify = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, { apiKey: fx.tenant2.apiKey });
    expect(verify.status).toBe(200);
    expect(verify.body.name).not.toBe("pwned by acct_1001");
  });

  it("POST /usage cannot attach a usage event to another tenant's customer", async () => {
    const res = await call(`${GO_USAGE_URL}/usage`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: { customer_id: fx.tenant2.customerId, event_type: "api_call", quantity: 1, idempotency_key: "attack-attempt-1" },
    });
    expect(res.status).toBe(403);
  });

  it("GET /usage never includes another tenant's events, even filtered by the victim's own customer_id", async () => {
    const res = await call(`${GO_USAGE_URL}/usage?customer_id=${fx.tenant2.customerId}`, { apiKey: fx.tenant1.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(tenant2UsageEventId);
  });

  it("GET /usage (unfiltered) never includes another tenant's events", async () => {
    const res = await call(`${GO_USAGE_URL}/usage`, { apiKey: fx.tenant1.apiKey });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((e: { id: string }) => e.id);
    expect(ids).not.toContain(tenant2UsageEventId);
    expect(ids).toContain(tenant1UsageEventId);
  });

  it("GET /idempotency-conflicts never exposes another tenant's review queue", async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attackerKey = `cross-tenant-conflict-1001-${runId}`;
    const victimKey = `cross-tenant-conflict-1002-${runId}`;

    const attackerBody = {
      customer_id: fx.tenant1.customerId,
      event_type: "idempotency_isolation",
      quantity: 1,
      idempotency_key: attackerKey,
    };
    const victimBody = {
      customer_id: fx.tenant2.customerId,
      event_type: "idempotency_isolation",
      quantity: 1,
      idempotency_key: victimKey,
    };
    expect((await call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: fx.tenant1.apiKey, body: attackerBody })).status).toBe(201);
    expect((await call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: fx.tenant1.apiKey, body: { ...attackerBody, quantity: 2 } })).status).toBe(409);
    expect((await call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: fx.tenant2.apiKey, body: victimBody })).status).toBe(201);
    expect((await call(`${GO_USAGE_URL}/usage`, { method: "POST", apiKey: fx.tenant2.apiKey, body: { ...victimBody, quantity: 2 } })).status).toBe(409);

    const filteredAttack = await call(
      `${GO_USAGE_URL}/idempotency-conflicts?idempotency_key=${encodeURIComponent(victimKey)}`,
      { apiKey: fx.tenant1.apiKey },
    );
    expect(filteredAttack.status).toBe(200);
    expect(filteredAttack.body.data).toEqual([]);
    expect(JSON.stringify(filteredAttack.body)).not.toContain(victimKey);

    const attackerQueue = await call(`${GO_USAGE_URL}/idempotency-conflicts`, { apiKey: fx.tenant1.apiKey });
    expect(attackerQueue.status).toBe(200);
    const serialized = JSON.stringify(attackerQueue.body);
    expect(serialized).toContain(attackerKey);
    expect(serialized).not.toContain(victimKey);
  });

  it("POST /reservations cannot attach a reservation to another tenant's customer or usage event", async () => {
    const response = await call(`${GO_USAGE_URL}/reservations`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: { customer_id: fx.tenant2.customerId, usage_event_id: tenant2UsageEventId },
    });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(tenant2UsageEventId);
  });

  it("POST /ledger/transactions cannot use another tenant's customer or reservation", async () => {
    const response = await call(`${GO_USAGE_URL}/ledger/transactions`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        customer_id: fx.tenant2.customerId,
        reservation_id: tenant2ReservationId,
        lines: [
          { account_code: "receivable", direction: "debit", amount: "1.00" },
          { account_code: "revenue", direction: "credit", amount: "1.00" },
        ],
      },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(tenant2ReservationId);
  });

  it("GET /ledger/transactions/:id cannot read another tenant's transaction", async () => {
    const response = await call(`${GO_USAGE_URL}/ledger/transactions/${tenant2LedgerTransactionId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(tenant2LedgerTransactionId);

    const own = await call(`${GO_USAGE_URL}/ledger/transactions/${tenant1LedgerTransactionId}`, {
      apiKey: fx.tenant1.apiKey,
    });
    expect(own.status).toBe(200);
  });

  it("POST /ledger/transactions/:id/reverse cannot reverse another tenant's transaction", async () => {
    const response = await call(`${GO_USAGE_URL}/ledger/transactions/${tenant2LedgerTransactionId}/reverse`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: { reason: "cross-tenant attack" },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(tenant2LedgerTransactionId);

    const victimRead = await call(`${GO_USAGE_URL}/ledger/transactions/${tenant2LedgerTransactionId}`, {
      apiKey: fx.tenant2.apiKey,
    });
    expect(victimRead.status).toBe(200);
    expect(victimRead.body.reverses_transaction_id).toBeNull();
  });
});

describe("TEID-41-T7: SQL injection on a filter parameter", () => {
  it("a SQL-injection payload in customer_id leaks no rows from either tenant", async () => {
    const payload = encodeURIComponent("' OR '1'='1");
    const res = await call(`${GO_USAGE_URL}/usage?customer_id=${payload}`, { apiKey: fx.tenant1.apiKey });
    // Rejected before it ever reaches a query -- not a 200 with data.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(tenant2UsageEventId);
    expect(JSON.stringify(res.body)).not.toContain(tenant1UsageEventId);
  });

  it("the same payload against the TS console's customer lookup is equally inert", async () => {
    const payload = encodeURIComponent("' OR '1'='1");
    const res = await call(`${TS_CONSOLE_URL}/customers/${payload}`, { apiKey: fx.tenant1.apiKey });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(fx.tenant2.customerId);
  });
});

describe("TEID-41-T8: ID substitution on PATCH /customers/{id}", () => {
  it("a valid API key for acct_1001 cannot PATCH acct_1002's customer by substituting its UUID", async () => {
    const before = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, { apiKey: fx.tenant2.apiKey });
    expect(before.status).toBe(200);
    const originalEmail = before.body.email;

    const attack = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, {
      method: "PATCH",
      apiKey: fx.tenant1.apiKey,
      body: { email: "attacker-controlled@evil.test" },
    });
    expect(attack.status).toBe(403);

    const after = await call(`${TS_CONSOLE_URL}/customers/${fx.tenant2.customerId}`, { apiKey: fx.tenant2.apiKey });
    expect(after.status).toBe(200);
    expect(after.body.email).toBe(originalEmail);
    expect(after.body.email).not.toBe("attacker-controlled@evil.test");
  });
});
