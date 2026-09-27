import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { ADMIN_API_KEY, JANE_EMAIL, TENANT_ID, janeSession, ownerSession } from "./session.js";

let ownerToken: string;
let janeToken: string;

beforeAll(async () => {
  ownerToken = await ownerSession();
  janeToken = await janeSession();
});
afterAll(() => pool.end());

function businessFields(plan: {
  name: string;
  currency: string;
  billing_interval: string;
  included_credits: number;
  hard_cap: number | null;
  soft_cap: number | null;
  status: string;
  version: number | null;
  rates: unknown;
  published_by: string | null;
  published_at: string | null;
}) {
  return {
    name: plan.name,
    currency: plan.currency,
    billing_interval: plan.billing_interval,
    included_credits: plan.included_credits,
    hard_cap: plan.hard_cap,
    soft_cap: plan.soft_cap,
    status: plan.status,
    version: plan.version,
    rates: plan.rates,
    published_by: plan.published_by,
    published_at: plan.published_at,
  };
}

async function rawBody(url: string, token: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, text: await response.text() };
}

async function planCount(): Promise<number> {
  const count = await withTenant(TENANT_ID, async (client) =>
    (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM plans`)).rows[0].count,
  );
  return Number(count);
}

describe("TEID-16 plans as configuration", () => {
  // TEID-16-T1 (Functional): one creation path exists. Two identical POSTs
  // produce two plan records whose fields match and whose ids differ.
  it("TEID-16-T1 creates two identical Growth-Monthly plans with matching fields", async () => {
    const body = { name: "Growth-Monthly", currency: "USD", billing_interval: "monthly" };
    const first = await call(`${TS_CONSOLE_URL}/plans`, { method: "POST", token: ownerToken, body });
    const second = await call(`${TS_CONSOLE_URL}/plans`, { method: "POST", token: ownerToken, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(businessFields(first.body)).toEqual(businessFields(second.body));
    expect(businessFields(first.body)).toMatchObject({
      name: "Growth-Monthly",
      currency: "USD",
      billing_interval: "monthly",
      included_credits: 0,
      hard_cap: null,
      soft_cap: null,
      status: "draft",
      version: null,
      rates: [],
      published_by: null,
      published_at: null,
    });

    const firstPage = await call(`${TS_CONSOLE_URL}/plans?limit=1`, { token: ownerToken });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.cursor).toBe(firstPage.body.data[0].id);
    const secondPage = await call(`${TS_CONSOLE_URL}/plans?limit=1&cursor=${firstPage.body.cursor}`, { token: ownerToken });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 30 && !(seen.has(first.body.id) && seen.has(second.body.id)); page++) {
      const listed = await call(
        cursor ? `${TS_CONSOLE_URL}/plans?limit=200&cursor=${cursor}` : `${TS_CONSOLE_URL}/plans?limit=200`,
        { token: ownerToken },
      );
      expect(listed.status).toBe(200);
      for (const plan of listed.body.data as Array<{ id: string }>) seen.add(plan.id);
      cursor = listed.body.cursor;
      if (!cursor) break;
    }
    expect(seen.has(first.body.id)).toBe(true);
    expect(seen.has(second.body.id)).toBe(true);
  });

  // TEID-16-T2 (Functional): every supplied field round-trips on create and
  // on the detail read. A later draft edit persists the same way.
  it("TEID-16-T2 persists Enterprise-Annual credits, rate, and hard cap", async () => {
    const body = {
      name: "Enterprise-Annual",
      currency: "USD",
      billing_interval: "annual",
      included_credits: 10000,
      hard_cap: 50000,
      rates: [{ metric: "gpt-4o-tokens", model: "gpt-4o", rate: 0.002 }],
    };
    const created = await call(`${TS_CONSOLE_URL}/plans`, { method: "POST", token: ownerToken, body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Enterprise-Annual",
      currency: "USD",
      billing_interval: "annual",
      included_credits: 10000,
      hard_cap: 50000,
      soft_cap: null,
      status: "draft",
      version: null,
      rates: [{ metric: "gpt-4o-tokens", model: "gpt-4o", rate: 0.002 }],
    });

    const detail = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: ownerToken });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(created.body);

    const patched = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: ownerToken,
      body: { soft_cap: 1000 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.soft_cap).toBe(1000);
    expect(patched.body.included_credits).toBe(10000);
    expect(patched.body.hard_cap).toBe(50000);
    expect(patched.body.rates).toEqual([{ metric: "gpt-4o-tokens", model: "gpt-4o", rate: 0.002 }]);
    const afterPatch = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: ownerToken });
    expect(afterPatch.body).toEqual(patched.body);
  });

  // TEID-16-T3 (Functional): this codebase rejects a malformed body with 400,
  // matching api-keys, rather than the story text's 422. The error names the
  // missing currency, then the listed metric whose rate was omitted.
  it("TEID-16-T3 names a missing currency and a listed metric with no rate", async () => {
    const missingCurrency = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: "Missing-Currency", billing_interval: "monthly" },
    });
    expect(missingCurrency.status).toBe(400);
    expect(missingCurrency.body).toEqual({ error: "currency is required" });

    const missingRate = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: {
        name: "Missing-Rate",
        currency: "USD",
        billing_interval: "monthly",
        rates: [{ metric: "image-generation" }],
      },
    });
    expect(missingRate.status).toBe(400);
    expect(missingRate.body).toEqual({ error: "a rate is required for metric image-generation" });

    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: {
        name: "Rate-Edit-Target",
        currency: "USD",
        billing_interval: "monthly",
        rates: [{ metric: "tokens", model: "gpt-4o", rate: 0.01 }],
      },
    });
    expect(created.status).toBe(201);
    const badEdit = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: ownerToken,
      body: { rates: [{ metric: "image-generation" }] },
    });
    expect(badEdit.status).toBe(400);
    expect(badEdit.body).toEqual({ error: "a rate is required for metric image-generation" });
    const detail = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: ownerToken });
    expect(detail.body.rates).toEqual([{ metric: "tokens", model: "gpt-4o", rate: 0.01 }]);
  });

  // TEID-16-T4 (Functional): no subscription or entitlement check exists yet.
  // A draft plan must leave the existing customer read byte-for-byte unchanged.
  it("TEID-16-T4 leaves GET /customers/:id unchanged after saving draft Starter-v2", async () => {
    const marker = randomUUID();
    const customer = await call(`${TS_CONSOLE_URL}/customers`, {
      method: "POST",
      token: ADMIN_API_KEY,
      body: { name: `Starter customer ${marker}`, email: `${marker}@example.test` },
    });
    expect(customer.status).toBe(201);
    const customerUrl = `${TS_CONSOLE_URL}/customers/${customer.body.id}`;
    const before = await rawBody(customerUrl, ADMIN_API_KEY);
    expect(before.status).toBe(200);

    const draft = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: "Starter-v2", currency: "USD", billing_interval: "monthly" },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");

    const after = await rawBody(customerUrl, ADMIN_API_KEY);
    expect(after.status).toBe(200);
    expect(after.text).toBe(before.text);
  });

  // TEID-16-T5 (Functional): publishing as jane@acme.com records version 1,
  // her email, and a publish timestamp. A second publish and a later edit conflict.
  it("TEID-16-T5 publishes Starter-v2 as jane@acme.com at version 1", async () => {
    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: janeToken,
      body: { name: "Starter-v2", currency: "USD", billing_interval: "monthly" },
    });
    expect(created.status).toBe(201);
    const beforePublish = Date.now();
    const published = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}/publish`, {
      method: "POST",
      token: janeToken,
    });
    expect(published.status).toBe(200);
    expect(published.body.version).toBe(1);
    expect(published.body.published_by).toBe(JANE_EMAIL);
    expect(published.body.status).toBe("published");
    const publishedAt = new Date(published.body.published_at).getTime();
    expect(publishedAt).toBeGreaterThanOrEqual(beforePublish - 5_000);
    expect(publishedAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(Date.now() - publishedAt).toBeLessThan(15_000);

    const again = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}/publish`, {
      method: "POST",
      token: janeToken,
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "plan is not a draft (already published, or does not exist for this tenant)",
    });
    const edit = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: janeToken,
      body: { name: "Starter-v2-edited" },
    });
    expect(edit.status).toBe(409);
    expect(edit.body).toEqual({ error: "cannot edit a published plan" });
    const detail = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: janeToken });
    expect(detail.body.version).toBe(1);
    expect(detail.body.published_by).toBe(JANE_EMAIL);
    expect(detail.body.name).toBe("Starter-v2");
  });

  // TEID-16-T6 (Non-functional): backend stand-in for a 500-metric form.
  // Count and budget are overridable the same way the other load tests are.
  it("TEID-16-T6 accepts a large rate catalog inside the server budget", async () => {
    const count = Number(process.env.PLAN_RATE_LOAD_TEST_COUNT ?? 500);
    const budgetMs = Number(process.env.PLAN_RATE_LOAD_TEST_BUDGET_MS ?? 500);
    const rates = Array.from({ length: count }, (_, index) => ({ metric: `metric-${index}`, rate: 0.01 }));
    const started = performance.now();
    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: `Load-${count}-${randomUUID()}`, currency: "USD", billing_interval: "monthly", rates },
    });
    const elapsed = performance.now() - started;
    expect(created.status).toBe(201);
    expect(created.body.rates).toHaveLength(count);
    const metrics = new Set(created.body.rates.map((rate: { metric: string; model: string | null; rate: number }) => rate.metric));
    expect(metrics.size).toBe(count);
    expect(metrics.has("metric-0")).toBe(true);
    expect(metrics.has(`metric-${count - 1}`)).toBe(true);
    expect(created.body.rates.every((rate: { model: string | null; rate: number }) => rate.model === null && rate.rate === 0.01)).toBe(true);
    expect(elapsed, `POST /plans with ${count} rates took ${elapsed.toFixed(1)}ms`).toBeLessThan(budgetMs);
  });

  // TEID-16-T7 (Non-functional): each required-field rejection names the
  // missing thing instead of a generic invalid-request message.
  it("TEID-16-T7 names currency, billing_interval, and the omitted metric rate", async () => {
    const missingCurrency = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: "Usability-Currency", billing_interval: "annual" },
    });
    const missingInterval = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: "Usability-Interval", currency: "USD" },
    });
    const missingRate = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: {
        name: "Usability-Rate",
        currency: "USD",
        billing_interval: "monthly",
        rates: [{ metric: "image-generation" }],
      },
    });
    expect(missingCurrency.status).toBe(400);
    expect(missingInterval.status).toBe(400);
    expect(missingRate.status).toBe(400);
    expect(missingCurrency.body.error).toContain("currency");
    expect(missingInterval.body.error).toContain("billing_interval");
    expect(missingRate.body.error).toContain("image-generation");
    for (const response of [missingCurrency, missingInterval, missingRate]) {
      expect(response.body.error).not.toBe("invalid request");
      expect(String(response.body.error).toLowerCase()).not.toContain("invalid request");
    }
  });

  // TEID-16-T8 (Adversarial): a negative included-credits value is rejected
  // and does not create or rewrite a plan.
  it("TEID-16-T8 rejects included_credits of -500 without saving a plan", async () => {
    const name = `Negative-Credits-${randomUUID()}`;
    const before = await planCount();
    const rejected = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name, currency: "USD", billing_interval: "monthly", included_credits: -500 },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("included_credits");
    expect(await planCount()).toBe(before);
    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query(`SELECT id FROM plans WHERE name = $1`, [name])).rowCount,
    );
    expect(stored).toBe(0);

    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: `Keep-${name}`, currency: "EUR", billing_interval: "annual", included_credits: 10 },
    });
    expect(created.status).toBe(201);
    const badEdit = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, {
      method: "PATCH",
      token: ownerToken,
      body: { included_credits: -500 },
    });
    expect(badEdit.status).toBe(400);
    expect(badEdit.body.error).toContain("included_credits");
    const detail = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: ownerToken });
    expect(detail.body.included_credits).toBe(10);
  });

  // TEID-16-T9 (Adversarial): two concurrent publishes. Exactly one creates
  // version 1; the other conflicts; the stored version stays 1.
  it("TEID-16-T9 lets only one of two concurrent publishes create version 1", async () => {
    const created = await call(`${TS_CONSOLE_URL}/plans`, {
      method: "POST",
      token: ownerToken,
      body: { name: `Concurrent-${randomUUID()}`, currency: "USD", billing_interval: "monthly" },
    });
    expect(created.status).toBe(201);
    const publishUrl = `${TS_CONSOLE_URL}/plans/${created.body.id}/publish`;
    const [first, second] = await Promise.all([
      call(publishUrl, { method: "POST", token: ownerToken }),
      call(publishUrl, { method: "POST", token: janeToken }),
    ]);
    const responses = [first, second].sort((left, right) => left.status - right.status);
    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(responses[0].body.version).toBe(1);
    expect(responses[1].body).toEqual({
      error: "plan is not a draft (already published, or does not exist for this tenant)",
    });

    const detail = await call(`${TS_CONSOLE_URL}/plans/${created.body.id}`, { token: ownerToken });
    expect(detail.status).toBe(200);
    expect(detail.body.version).toBe(1);
    expect(detail.body.status).toBe("published");
    const publishAudits = await withTenant(TENANT_ID, async (client) =>
      (await client.query(
        `SELECT id FROM audit_log
         WHERE object_type = 'Plan' AND object_id = $1 AND after->>'version' = '1'`,
        [created.body.id],
      )).rowCount,
    );
    expect(publishAudits).toBe(1);
  });
});
