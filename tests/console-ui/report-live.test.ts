import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupFixture,
  createCustomer,
  createFixture,
  linkCustomer,
  seedExpectedActivity,
  seedInvoiceRecord,
  seedRecord,
  superPool as verifyPool,
  type Fixture,
} from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { fullLogin } from "./session.js";

// AC11's exact clean-match scenario (expected 500.00 / billed 500.00 /
// line period 2026-08-15 to 2026-09-15), seeded fresh by this test rather
// than assuming a pre-existing customer -- a CI run gets a brand-new
// database with none of this session's own manually-seeded local demo
// data, so this test must be fully self-contained.
let token: string;
let fixture: Fixture;
let matchCustomer: string;
let mismatchCustomer: string;

function dom(): HTMLElement {
  const page = new JSDOM("<!doctype html><main id='app'></main>", { url: "http://console.test/console/#report" });
  Object.assign(globalThis, { window: page.window, document: page.window.document, Node: page.window.Node, HTMLElement: page.window.HTMLElement });
  return page.window.document.querySelector("#app")!;
}

async function report(): Promise<any> {
  const response = await call<any>(`${TS_CONSOLE_URL}/verify/discrepancy-report?period=2026-08`, { token });
  expect(response.status).toBe(200);
  return response.body;
}

beforeAll(async () => {
  token = await fullLogin();
  fixture = await createFixture(`teid-ui-1-${randomUUID()}`);

  // AC11's clean match: expected 500.00, billed 500.00, line period
  // 2026-08-15 to 2026-09-15 (a subscription cycle straddling, not equal
  // to, the Aug calendar-month report window -- the TEID-68.1 overlap fix
  // this story's report is built on).
  matchCustomer = await createCustomer(fixture, "500-match");
  const matchStripeCustomer = `cus_ui_match_${randomUUID()}`;
  const matchInvoiceId = `in_ui_match_${randomUUID()}`;
  const matchLineId = `il_ui_match_${randomUUID()}`;
  await linkCustomer(matchCustomer, matchStripeCustomer);
  await seedExpectedActivity(matchCustomer, `${fixture.marker}-match`, "500.00", "1");
  await seedRecord(fixture, "invoice", matchInvoiceId, {
    id: matchInvoiceId,
    customer_id: matchStripeCustomer,
    amount: "500.00",
    currency: "USD",
    status: "paid",
    issued_at: "2026-08-15T00:00:00.000Z",
    period_start: "2026-08-15T00:00:00.000Z",
    period_end: "2026-09-15T00:00:00.000Z",
    lines: [{
      id: matchLineId,
      invoice_id: matchInvoiceId,
      price_id: "price_console_ui",
      period_start: "2026-08-15T00:00:00.000Z",
      period_end: "2026-09-15T00:00:00.000Z",
      quantity: "1",
      amount: "500.00",
      currency: "USD",
      passthrough: {},
    }],
    passthrough: {},
  });

  mismatchCustomer = await createCustomer(fixture, "500-v-400");
  const stripeCustomer = `cus_ui_${randomUUID()}`;
  await linkCustomer(mismatchCustomer, stripeCustomer);
  await seedExpectedActivity(mismatchCustomer, `${fixture.marker}-expected`, "500.00", "1");
  await seedInvoiceRecord(fixture, `in_ui_${randomUUID()}`, stripeCustomer, `il_ui_${randomUUID()}`, "1", "400.00");

  const mapped = await call(`${TS_CONSOLE_URL}/verify/map-billed-lines`, { method: "POST", token });
  expect(mapped.status).toBe(200);
});

afterAll(async () => {
  if (fixture) await cleanupFixture(fixture);
  await verifyPool.end();
});

// The shared tenant's report can carry thousands of rows left behind by
// other suites' own scale tests running earlier in the same CI job against
// the same database (TEID-65's 2-million-line backfill, TEID-68.1's
// 500-customer scale seed, and this session's own long-lived local
// accumulation) -- none of that is this test's concern. Rendering a
// screen module builds one DOM row per report row regardless, so asserting
// against the raw, untrimmed response makes every one of these tests'
// cost scale with however much unrelated data happens to exist in the
// tenant at the moment it runs, not with anything this test actually
// seeded. Trim to just the two rows this test created before rendering.
function trimmedReport(raw: any): any {
  const data = raw.data.filter((row: any) => row.customer_id === matchCustomer || row.customer_id === mismatchCustomer);
  return { ...raw, data };
}

describe("TEID-UI-1 live Verify rendering", () => {
  it("TEID-UI-1-T5 uses a freshly seeded $500 match plus a $500/$400 customer and sorts the mismatch first", async () => {
    const raw = await report();
    expect(raw.data.find((row: any) => row.customer_id === matchCustomer)).toMatchObject({ expected_total: "500.00", billed_total: "500.00", delta: "0.00", classification: null });
    expect(raw.data.find((row: any) => row.customer_id === mismatchCustomer)).toMatchObject({ expected_total: "500.00", billed_total: "400.00" });
    const trimmed = trimmedReport(raw);
    const module: any = await import("../../services/ts-console/public/screens/home.js");
    const container = dom();
    await module.render(container, { apiFetch: async () => trimmed, principal: { role: "Billing Admin" }, getMonth: () => "2026-08", setMonth: () => undefined, navigate: () => undefined });
    const customerNames = [...container.querySelectorAll("tbody tr td:first-child")].map((node) => node.textContent);
    expect(customerNames.indexOf(trimmed.data.find((row: any) => row.customer_id === mismatchCustomer).customer_name))
      .toBeLessThan(customerNames.indexOf(trimmed.data.find((row: any) => row.customer_id === matchCustomer).customer_name));
  });

  it("TEID-UI-1-T6 renders live API monetary strings byte-identically and the match customer's cross-month period", async () => {
    const raw = await report();
    const trimmed = trimmedReport(raw);
    expect(trimmed.data).toHaveLength(2);
    const module: any = await import("../../services/ts-console/public/screens/report.js");
    const container = dom();
    await module.render(container, { apiFetch: async () => trimmed, principal: { role: "Billing Admin" }, getMonth: () => "2026-08", setMonth: () => undefined, navigate: () => undefined });
    for (const row of trimmed.data) for (const field of ["expected_total", "billed_total", "delta"]) {
      expect(container.querySelector(`[data-customer-id="${row.customer_id}"][data-money-field="${field}"]`)?.textContent).toBe(row[field]);
    }
    const matchRow = container.querySelector<HTMLTableRowElement>(`[data-customer-id="${matchCustomer}"]`)?.closest("tr");
    expect(matchRow).toBeTruthy(); matchRow!.click();
    const evidence = matchRow!.nextElementSibling?.textContent;
    expect(evidence).toContain("2026-08-15"); expect(evidence).toContain("2026-09-15");
  });
});
