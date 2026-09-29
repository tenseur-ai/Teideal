// TEID-38 acceptance suite. Shares TEID-37's fake Stripe double, session
// fixtures, and env. env.ts is imported first so the encryption key is set
// before stripeConnect.ts reads it at module load.
import "./env.js";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { FAKE_STRIPE_URL, TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { billingSession } from "./session.js";

interface LoggedExchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
}

interface SeedCustomer {
  id?: string;
  name?: string | null;
  email?: string | null;
}

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

async function fakeLog(): Promise<LoggedExchange[]> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_requests`);
  const body = await response.json() as { requests: LoggedExchange[] };
  return body.requests;
}

function accessTokenFor(log: LoggedExchange[], code: string): string {
  const hit = [...log].reverse().find((row) =>
    row.path === "/oauth/token" && row.requestBody.includes(`code=${code}`) && row.responseStatus === 200,
  );
  if (!hit) throw new Error(`no token exchange recorded for ${code}`);
  return JSON.parse(hit.responseBody).access_token as string;
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

async function connect(sessionToken: string, scope: "read_only" | "read_write") {
  const started = await call(`${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=${scope}`, { token: sessionToken });
  expect(started.status).toBe(200);
  const redeemed = await redeem(started.body.url);
  const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
    method: "POST",
    token: sessionToken,
    body: { code: redeemed.code, state: redeemed.state },
  });
  expect(created.status).toBe(201);
  const accessToken = accessTokenFor(await fakeLog(), redeemed.code);
  return { created, redeemed, accessToken };
}

async function seedCustomers(accessToken: string, customers: SeedCustomer[]): Promise<void> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_seed/customers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, customers }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`seed failed ${response.status} ${text}`);
}

async function insertCustomer(name: string, email: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) => {
    const row = (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, name, email],
    )).rows[0];
    return row.id;
  });
}

async function loadLink(customerId: string) {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{
      customer_id: string;
      stripe_customer_id: string;
      matched_by: string;
    }>(
      `SELECT customer_id, stripe_customer_id, matched_by FROM stripe_customer_links WHERE customer_id = $1`,
      [customerId],
    )).rows,
  );
}

async function fakeCustomers(accessToken: string): Promise<Array<{ id: string; name: string | null; email: string | null }>> {
  const out: Array<{ id: string; name: string | null; email: string | null }> = [];
  let startingAfter: string | undefined;
  for (;;) {
    const url = new URL(`${FAKE_STRIPE_URL}/v1/customers`);
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await response.json() as {
      data: Array<{ id: string; name: string | null; email: string | null }>;
      has_more: boolean;
    };
    out.push(...body.data);
    if (!body.has_more || body.data.length === 0) break;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return out;
}

beforeAll(async () => {
  token = await billingSession();
});

afterAll(async () => {
  await pool.end();
});

describe("TEID-38 Stripe customers", () => {
  it("TEID-38-T1 auto-links a Stripe customer whose email matches a Teideal customer case-insensitively", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer("Jane Doe", `jane-${tag}@acme.com`);
    const { accessToken } = await connect(token, "read_only");
    const matchedId = `cus_t1_${tag}`;
    await seedCustomers(accessToken, [
      { id: matchedId, name: "Jane", email: `Jane-${tag}@Acme.com` },
      { id: `cus_t1_other1_${tag}`, name: "Other One", email: `other1-${tag}@stripe.test` },
      { id: `cus_t1_other2_${tag}`, name: "Other Two", email: `other2-${tag}@stripe.test` },
    ]);

    const sync = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, { method: "POST", token, body: {} });
    expect(sync.status).toBe(200);
    expect(sync.body.linked).toBeGreaterThanOrEqual(1);

    const links = await loadLink(customerId);
    expect(links).toHaveLength(1);
    expect(links[0].stripe_customer_id).toBe(matchedId);
    expect(links[0].matched_by).toBe("email");
  });

  it("TEID-38-T2 queues a close-but-not-exact email for manual review instead of auto-linking", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer("Jane Doe", `jane.doe.${tag}@acmeco.com`);
    const { accessToken } = await connect(token, "read_only");
    const stripeId = `cus_t2_${tag}`;
    await seedCustomers(accessToken, [
      { id: stripeId, name: "Jane Doe", email: `jane.doe.${tag}@acmeco.co` },
    ]);

    const sync = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, { method: "POST", token, body: {} });
    expect(sync.status).toBe(200);
    expect(sync.body.linked).toBe(0);
    expect(sync.body.candidates).toBeGreaterThanOrEqual(1);
    expect(await loadLink(customerId)).toEqual([]);

    const review = await call(`${TS_CONSOLE_URL}/stripe/customers/match-candidates`, { token });
    expect(review.status).toBe(200);
    const candidate = review.body.data.find((row: { stripe_customer_id: string; status: string }) =>
      row.stripe_customer_id === stripeId,
    );
    expect(candidate).toBeTruthy();
    expect(candidate.status).toBe("pending");
  });

  it("TEID-38-T3 creates a Stripe customer from Teideal and links it", async () => {
    const tag = randomUUID();
    const email = `create-stripe-${tag}@acmeco.com`;
    const customerId = await insertCustomer("Create In Stripe", email);
    const { accessToken } = await connect(token, "read_write");

    const created = await call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
      method: "POST",
      token,
      body: { create_new: true, name: "Create In Stripe", email },
    });
    expect(created.status).toBe(201);
    expect(created.body.matched_by).toBe("manual_create_in_stripe");
    expect(created.body.customer_id).toBe(customerId);
    expect(created.body.stripe_customer_id).toBeTruthy();

    const links = await loadLink(customerId);
    expect(links).toHaveLength(1);
    expect(links[0].matched_by).toBe("manual_create_in_stripe");
    expect(links[0].stripe_customer_id).toBe(created.body.stripe_customer_id);

    const seeded = await fakeCustomers(accessToken);
    expect(seeded.some((row) => row.id === created.body.stripe_customer_id && row.email === email)).toBe(true);
  });

  it("TEID-38-T4 creates a Teideal customer from a pending Stripe candidate and links it", async () => {
    const tag = randomUUID();
    const { accessToken } = await connect(token, "read_only");
    const stripeId = `cus_t4_${tag}`;
    const email = `from-stripe-${tag}@stripe.test`;
    await seedCustomers(accessToken, [{ id: stripeId, name: "From Stripe", email }]);

    const sync = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, { method: "POST", token, body: {} });
    expect(sync.status).toBe(200);
    const review = await call(`${TS_CONSOLE_URL}/stripe/customers/match-candidates`, { token });
    const candidate = review.body.data.find((row: { stripe_customer_id: string; id: string }) =>
      row.stripe_customer_id === stripeId,
    );
    expect(candidate).toBeTruthy();

    const created = await call(`${TS_CONSOLE_URL}/stripe/candidates/${candidate.id}/create-in-teideal`, {
      method: "POST",
      token,
      body: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.customer.email).toBe(email);
    expect(created.body.customer.name).toBe("From Stripe");
    expect(created.body.link.matched_by).toBe("manual_create_in_teideal");
    expect(created.body.link.stripe_customer_id).toBe(stripeId);

    const links = await loadLink(created.body.customer.id);
    expect(links).toHaveLength(1);
    expect(links[0].matched_by).toBe("manual_create_in_teideal");

    const status = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ status: string; resolved_at: Date | null }>(
        `SELECT status, resolved_at FROM stripe_customer_match_candidates WHERE id = $1`,
        [candidate.id],
      )).rows[0],
    );
    expect(status.status).toBe("resolved");
    expect(status.resolved_at).toBeTruthy();
  });

  it("TEID-38-T5 rejects linking a customer that is already linked to a different Stripe customer", async () => {
    const tag = randomUUID();
    const email = `already-linked-${tag}@acmeco.com`;
    const customerId = await insertCustomer("Already Linked", email);
    const { accessToken } = await connect(token, "read_write");
    const otherId = `cus_t5_other_${tag}`;
    await seedCustomers(accessToken, [{ id: otherId, name: "Other", email: `other-${tag}@stripe.test` }]);

    const first = await call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
      method: "POST",
      token,
      body: { create_new: true, name: "Already Linked", email },
    });
    expect(first.status).toBe(201);
    const original = first.body.stripe_customer_id;

    const second = await call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
      method: "POST",
      token,
      body: { stripe_customer_id: otherId },
    });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "customer is already linked to a Stripe customer" });

    const links = await loadLink(customerId);
    expect(links).toHaveLength(1);
    expect(links[0].stripe_customer_id).toBe(original);
    expect(links[0].matched_by).toBe("manual_create_in_stripe");
  });

  it("TEID-38-T6 syncs 10,000 Stripe customers within 5 minutes and accounts for every one", async () => {
    const matchCount = 3333;
    const total = 10_000;
    const run = randomUUID().slice(0, 8);
    await withTenant(TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO customers (tenant_id, name, email)
         SELECT $1, 'T6 Customer ' || i, 't6-' || $3 || '-' || i || '@acmeco.com'
         FROM generate_series(1, $2) AS i`,
        [TENANT_ID, matchCount, run],
      );
    });
    const { accessToken } = await connect(token, "read_only");
    const seeded: SeedCustomer[] = [];
    for (let i = 1; i <= total; i++) {
      seeded.push({
        id: `cus_t6_${run}_${String(i).padStart(5, "0")}`,
        name: `Stripe ${i}`,
        email: i <= matchCount ? `t6-${run}-${i}@acmeco.com` : `t6-unmatched-${run}-${i}@stripe.test`,
      });
    }
    await seedCustomers(accessToken, seeded);

    const started = performance.now();
    const sync = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, { method: "POST", token, body: {} });
    const elapsedMs = performance.now() - started;
    expect(sync.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
    expect(sync.body.linked + sync.body.candidates).toBe(total);

    const review = await call(`${TS_CONSOLE_URL}/stripe/customers/match-candidates`, { token });
    expect(review.status).toBe(200);
    const t6Candidates = (review.body.data as Array<{ stripe_customer_id: string }>).filter((row) =>
      row.stripe_customer_id.startsWith(`cus_t6_${run}_`),
    );
    expect(t6Candidates).toHaveLength(sync.body.candidates);
    expect(sync.body.linked + t6Candidates.length).toBe(total);
  }, 5 * 60 * 1000);

  it("TEID-38-T7 accepts only one of two concurrent link requests for the same customer", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer("Race Customer", `race-${tag}@acmeco.com`);
    const { accessToken } = await connect(token, "read_write");
    const firstId = `cus_t7_a_${tag}`;
    const secondId = `cus_t7_b_${tag}`;
    await seedCustomers(accessToken, [
      { id: firstId, name: "Race A", email: `race-a-${tag}@stripe.test` },
      { id: secondId, name: "Race B", email: `race-b-${tag}@stripe.test` },
    ]);

    const [left, right] = await Promise.all([
      call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
        method: "POST",
        token,
        body: { stripe_customer_id: firstId },
      }),
      call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
        method: "POST",
        token,
        body: { stripe_customer_id: secondId },
      }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = left.status === 201 ? left : right;
    const loser = left.status === 409 ? left : right;
    expect(loser.body).toEqual({ error: "customer is already linked to a Stripe customer" });
    expect([firstId, secondId]).toContain(winner.body.stripe_customer_id);

    const links = await loadLink(customerId);
    expect(links).toHaveLength(1);
    expect(links[0].stripe_customer_id).toBe(winner.body.stripe_customer_id);
  });

  it("TEID-38-T8 lets a read-only connection sync and rejects create-in-Stripe at both layers", async () => {
    const tag = randomUUID();
    const customerId = await insertCustomer("Read Only Write", `readonly-${tag}@acmeco.com`);
    const { accessToken } = await connect(token, "read_only");
    await seedCustomers(accessToken, [
      { id: `cus_t8_${tag}`, name: "Readable", email: `readable-${tag}@stripe.test` },
    ]);

    const sync = await call(`${TS_CONSOLE_URL}/stripe/customers/sync`, { method: "POST", token, body: {} });
    expect(sync.status).toBe(200);
    expect(sync.body.candidates).toBeGreaterThanOrEqual(1);

    const logFrom = (await fakeLog()).length;
    const created = await call(`${TS_CONSOLE_URL}/stripe/customers/${customerId}/link-stripe`, {
      method: "POST",
      token,
      body: { create_new: true, name: "Read Only Write", email: `readonly-${tag}@acmeco.com` },
    });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/read-only/i);
    const fresh = (await fakeLog()).slice(logFrom);
    expect(fresh.some((row) => row.method === "POST" && row.path === "/v1/customers")).toBe(false);

    const fakeWrite = await fetch(`${FAKE_STRIPE_URL}/v1/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name: "Direct", email: `direct-${tag}@stripe.test` }),
    });
    expect(fakeWrite.status).toBe(403);
    expect(await fakeWrite.json()).toEqual({ error: "read_only" });
  });
});
