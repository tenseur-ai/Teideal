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
  superPool as verifyPool,
  type Fixture,
} from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { fullLogin } from "./session.js";

const LIVE_DEMO_CUSTOMER = "26a005fe-c266-4471-a699-6b702bb19715";
let token: string;
let fixture: Fixture;
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

describe("TEID-UI-1 live Verify rendering", () => {
  it("TEID-UI-1-T5 uses the existing $500 match plus a separately seeded $500/$400 customer and sorts the mismatch first", async () => {
    const raw = await report();
    expect(raw.data.find((row: any) => row.customer_id === LIVE_DEMO_CUSTOMER)).toMatchObject({ expected_total: "500.00", billed_total: "500.00", delta: "0.00", classification: null });
    expect(raw.data.find((row: any) => row.customer_id === mismatchCustomer)).toMatchObject({ expected_total: "500.00", billed_total: "400.00" });
    const module: any = await import("../../services/ts-console/public/screens/home.js");
    const container = dom();
    await module.render(container, { apiFetch: async () => raw, principal: { role: "Billing Admin" }, getMonth: () => "2026-08", setMonth: () => undefined, navigate: () => undefined });
    const customerNames = [...container.querySelectorAll("tbody tr td:first-child")].map((node) => node.textContent);
    expect(customerNames.indexOf(raw.data.find((row: any) => row.customer_id === mismatchCustomer).customer_name))
      .toBeLessThan(customerNames.indexOf(raw.data.find((row: any) => row.customer_id === LIVE_DEMO_CUSTOMER).customer_name));
  });

  it("TEID-UI-1-T6 renders live API monetary strings byte-identically and the demo line's cross-month period", async () => {
    const raw = await report();
    const module: any = await import("../../services/ts-console/public/screens/report.js");
    const container = dom();
    await module.render(container, { apiFetch: async () => raw, principal: { role: "Billing Admin" }, getMonth: () => "2026-08", setMonth: () => undefined, navigate: () => undefined });
    for (const row of raw.data) for (const field of ["expected_total", "billed_total", "delta"]) {
      expect(container.querySelector(`[data-customer-id="${row.customer_id}"][data-money-field="${field}"]`)?.textContent).toBe(row[field]);
    }
    const demoRow = [...container.querySelectorAll<HTMLTableRowElement>(".interactive-row")].find((row) => row.textContent?.includes("Live Demo Customer"));
    expect(demoRow).toBeTruthy(); demoRow!.click();
    const evidence = demoRow!.nextElementSibling?.textContent;
    expect(evidence).toContain("2026-08-15"); expect(evidence).toContain("2026-09-15");
  });
});
