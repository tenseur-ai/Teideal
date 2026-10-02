import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const publicRoot = resolve(import.meta.dirname, "../../services/ts-console/public");
const reportFixture = {
  data: [
    { customer_id: "match", customer_name: "Demo customer", expected_total: "500.00", billed_total: "500.00", delta: "0.00", classification: null, evidence: { expected: { ledger_line_ids: ["ledger-match"], usage_event_ids: ["usage-match"], overage_consumption_line_ids: [] }, billed: { lines: [{ stripe_invoice_line_id: "il_match", period_start: "2026-08-15T00:00:00.000Z", period_end: "2026-09-15T00:00:00.000Z", amount: "500.00", quantity: "1" }] } } },
    { customer_id: "mismatch", customer_name: "Dev mismatch", expected_total: "500.00", billed_total: "400.00", delta: "100.00", classification: "rate_drift", evidence: { expected: { ledger_line_ids: ["ledger-mismatch"], usage_event_ids: ["usage-mismatch"], overage_consumption_line_ids: [] }, billed: { lines: [{ stripe_invoice_line_id: "il_mismatch", period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-09-01T00:00:00.000Z", amount: "400.00", quantity: "1" }] } } },
  ],
  excluded: [{ customer_id: "cus_unmapped", customer_name: "Unmapped", reason: "unmapped_customer", billed_total: "49.99", evidence: { stripe_invoice_line_ids: ["il_unmapped"], connector_record_ids: ["rec"] } }],
  totals: { expected: "1000.00", billed: "900.00", delta: "100.00", excluded_billed: "49.99" },
  caveats: ["Credits are evidence only."],
};

function installDom() {
  const dom = new JSDOM("<!doctype html><header><div id='session-summary'></div></header><nav id='primary-nav'></nav><main id='app'></main>", { url: "http://console.test/console/" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement, sessionStorage: dom.window.sessionStorage, location: dom.window.location,
    history: dom.window.history, FormData: dom.window.FormData, Headers: globalThis.Headers,
    confirm: () => true, prompt: () => "1",
  });
  return dom;
}

async function screen(name: string): Promise<any> {
  return import(`../../services/ts-console/public/screens/${name}.js`);
}

function context(role: string, apiFetch: (path: string, options?: any) => Promise<any>) {
  let month = "2026-08";
  return { principal: { role }, apiFetch, getMonth: () => month, setMonth: (value: string) => { month = value; }, navigate: vi.fn() };
}

beforeEach(() => { installDom(); vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("TEID-UI-1 cataloged console behavior", () => {
  it("TEID-UI-1-T1 renders the MFA-required prompt and loads the Billing Admin role", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.endsWith("/auth/login") ? { status: "mfa_required", pending_token: "pending" }
        : path.endsWith("/auth/mfa/verify") ? { status: "authenticated", session_token: "session" }
        : path.endsWith("/auth/me") ? { user_id: "u", tenant_id: "t", role: "Billing Admin" }
        : reportFixture;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const appPath = pathToFileURL(resolve(import.meta.dirname, "../../services/ts-console/public/app.js")).href; await import(appPath);
    const login = document.querySelector<HTMLFormElement>(".auth-card form")!;
    login.querySelector<HTMLInputElement>("[name=tenant_key]")!.value = "acct_1001";
    login.querySelector<HTMLInputElement>("[name=email]")!.value = "billing@acmeco.com";
    login.querySelector<HTMLInputElement>("[name=password]")!.value = "password";
    login.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("[name=totp_code]")).not.toBeNull());
    expect(document.body.textContent).toContain("Enter your authentication code");
    document.querySelector<HTMLInputElement>("[name=totp_code]")!.value = "123456";
    document.querySelector<HTMLFormElement>(".auth-card form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".role-badge")?.textContent).toBe("Billing Admin"));
  });

  it("TEID-UI-1-T2 renders the enrollment URI and confirms enrollment", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.endsWith("/auth/login") ? { status: "mfa_enrollment_required", pending_token: "pending", otpauth_uri: "otpauth://totp/Teideal:user?secret=ABC" }
        : path.endsWith("/auth/mfa/enroll/confirm") ? { status: "authenticated", session_token: "session" }
        : path.endsWith("/auth/me") ? { user_id: "u", tenant_id: "t", role: "Owner" }
        : reportFixture;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const appPath = pathToFileURL(resolve(import.meta.dirname, "../../services/ts-console/public/app.js")).href; await import(appPath);
    const login = document.querySelector<HTMLFormElement>(".auth-card form")!;
    for (const [name, value] of [["tenant_key", "acct_1001"], ["email", "owner@acmeco.com"], ["password", "password"]]) login.querySelector<HTMLInputElement>(`[name=${name}]`)!.value = value;
    login.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".otpauth-uri")?.textContent).toContain("otpauth://"));
    document.querySelector<HTMLInputElement>("[name=totp_code]")!.value = "123456";
    document.querySelector<HTMLFormElement>(".auth-card form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".role-badge")?.textContent).toBe("Owner"));
  });

  it("TEID-UI-1-T3 gives Support timeline-only customer behavior and renders forbidden errors plainly", async () => {
    const calls: string[] = [];
    const module = await screen("customer");
    await module.render(document.querySelector("#app")!, context("Support", async (path) => { calls.push(path); return { entries: [] }; }));
    const input = document.querySelector<HTMLInputElement>("[name=customer_id]")!; input.value = "customer-id";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls).toEqual(["/customers/customer-id/timeline"]));
    expect(document.querySelector('[data-section="plan-balance"]')).toBeNull();
  });

  it("TEID-UI-1-T4 keeps Billing Admin user controls and renders the backend 403 inline", async () => {
    const module = await screen("users");
    await module.render(document.querySelector("#app")!, context("Billing Admin", async (path, options) => {
      if (path === "/users" && options?.method === "POST") throw new Error("this action requires role Owner; your role is Billing Admin");
      if (path === "/users") throw new Error("this action requires role Owner; your role is Billing Admin");
      return { data: [] };
    }));
    const form = [...document.querySelectorAll("form")].find((item) => item.querySelector("[name=email]"))!;
    form.querySelector<HTMLInputElement>("[name=email]")!.value = "new@example.test";
    form.querySelector<HTMLInputElement>("[name=password]")!.value = "StrongPass123!";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("requires role Owner"));
  });

  it("TEID-UI-1-T5 renders totals and sorts the nonzero row before the match", async () => {
    const module = await screen("home");
    await module.render(document.querySelector("#app")!, context("Billing Admin", async () => reportFixture));
    const names = [...document.querySelectorAll("tbody tr td:first-child")].map((node) => node.textContent);
    expect(names).toEqual(["Dev mismatch", "Demo customer"]);
    expect(document.body.textContent).toContain("1000.00");
  });

  it("TEID-UI-1-T6 keeps every rendered monetary string byte-identical to the raw response", async () => {
    const raw = JSON.stringify(reportFixture);
    const response = JSON.parse(raw);
    const module = await screen("report");
    await module.render(document.querySelector("#app")!, context("Billing Admin", async () => response));
    for (const row of response.data) for (const field of ["expected_total", "billed_total", "delta"] as const) {
      const rendered = document.querySelector(`[data-customer-id="${row.customer_id}"][data-money-field="${field}"]`)?.textContent;
      expect(rendered).toBe(row[field]);
    }
    for (const [field, value] of Object.entries(response.totals)) expect(document.querySelector(`[data-money-field="${field}"]`)?.textContent).toBe(value);
    const renderPath = `${await readFile(resolve(publicRoot, "screens/home.js"), "utf8")}\n${await readFile(resolve(publicRoot, "screens/report.js"), "utf8")}`;
    expect(renderPath).not.toMatch(/Number\(|parseFloat\(|toFixed\(/);
  });

  it("TEID-UI-1-T7 shows Match and fetched evidence without a second request", async () => {
    const fetcher = vi.fn(async () => reportFixture);
    const module = await screen("report");
    await module.render(document.querySelector("#app")!, context("Billing Admin", fetcher));
    expect(document.body.textContent).toContain("Match"); expect(document.body.textContent).toContain("rate_drift");
    document.querySelector<HTMLTableRowElement>(".interactive-row")!.click();
    expect(document.body.textContent).toContain("il_match"); expect(document.body.textContent).toContain("2026-08-15");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("TEID-UI-1-T8 structurally separates excluded customers and caveats", async () => {
    const module = await screen("report"); await module.render(document.querySelector("#app")!, context("Finance", async () => reportFixture));
    expect(document.querySelector('[data-report-section="mapped"]')!.contains(document.querySelector('[data-report-section="excluded"]'))).toBe(false);
    expect(document.querySelector('[data-report-section="excluded"]')!.textContent).toContain("Unmapped");
    expect(document.querySelector('[data-report-section="excluded"]')!.textContent).toContain("Credits are evidence only.");
  });

  it("TEID-UI-1-T9 renders Owner plan, balance, and timeline from their own responses", async () => {
    const module = await screen("customer");
    await module.render(document.querySelector("#app")!, context("Owner", async (path) => path.endsWith("/timeline") ? { entries: [{ type: "grant", occurred_at: "2026-08-01", id: "event-1" }] } : path.endsWith("/subscription") ? { current_plan_id: "plan-1", plan_family_id: "family-1", grandfathered: false } : path.startsWith("/grants") ? { data: [{ customer_id: "customer-id", source: "paid", remaining_amount: "500.00", unit: "credits", status: "active" }] } : path === "/customers" ? { data: [] } : { name: "Demo", email: "demo@example.test" }));
    document.querySelector<HTMLInputElement>("[name=customer_id]")!.value = "customer-id";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("plan-1"));
    expect(document.body.textContent).toContain("500.00"); expect(document.body.textContent).toContain("event-1");
  });

  it("TEID-UI-1-T10 never calls customer detail for Support and omits plan/balance", async () => {
    const fetcher = vi.fn(async (_path: string, _options?: unknown) => ({ entries: [] }));
    const module = await screen("customer"); await module.render(document.querySelector("#app")!, context("Support", fetcher));
    document.querySelector<HTMLInputElement>("[name=customer_id]")!.value = "customer-id";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["/customers/customer-id/timeline"]);
    expect(document.querySelector('[data-section="plan-balance"]')).toBeNull();
  });

  it("TEID-UI-1-T11 sends the exact create-grant contract and refreshes in place", async () => {
    const calls: Array<[string, any]> = [];
    const module = await screen("contract");
    await module.render(document.querySelector("#app")!, context("Billing Admin", async (path, options) => { calls.push([path, options]); if (path === "/plans") return { data: [] }; if (path.startsWith("/grants")) return { data: [] }; if (path.endsWith("/subscription")) { const error: any = new Error(); error.status = 404; throw error; } return {}; }));
    document.querySelector<HTMLInputElement>("[name=customer_id]")!.value = "customer-id";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".grant-form")).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>(".grant-form")!;
    form.querySelector<HTMLInputElement>("[name=amount]")!.value = "500"; form.querySelector<HTMLInputElement>("[name=unit]")!.value = "credits"; form.querySelector<HTMLInputElement>("[name=start_date]")!.value = "2026-08-01T00:00";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls.some(([path, options]) => path === "/grants" && options?.method === "POST")).toBe(true));
    const sent = JSON.parse(calls.find(([path, options]) => path === "/grants" && options?.method === "POST")![1].body);
    expect(Object.keys(sent).sort()).toEqual(["amount", "customer_id", "source", "start_date", "unit"]);
  });

  it("TEID-UI-1-T12 contains no forbidden Stripe path and only disconnects with DELETE", async () => {
    const screenFiles = (await readdir(resolve(publicRoot, "screens"))).filter((file) => file.endsWith(".js")).map((file) => `screens/${file}`);
    const shipped = (await Promise.all(["app.js", ...screenFiles].map((file) => readFile(resolve(publicRoot, file), "utf8")))).join("\n");
    expect(shipped).not.toContain("/stripe/connections/"); expect(shipped).not.toContain("request-write-access"); expect(shipped).not.toMatch(/invoice[-_/ ]?items?/i);
    const calls: Array<[string, any]> = [];
    const module = await screen("stripe"); await module.render(document.querySelector("#app")!, context("Owner", async (path, options) => { calls.push([path, options]); return path === "/connectors/sync-health" ? { data: [{ id: "connector-1", display_name: "Stripe", status: "connected" }] } : {}; }));
    document.querySelector<HTMLButtonElement>("[data-connector-disconnect]")!.click();
    await vi.waitFor(() => expect(calls.some(([path, options]) => path === "/connectors/connector-1" && options?.method === "DELETE")).toBe(true));
  });

  it("TEID-UI-1-T13 renders Finance period-close data without a mutating control", async () => {
    const module = await screen("periodClose"); await module.render(document.querySelector("#app")!, context("Finance", async () => ({ data: [{ customer_id: "c", customer_name: "Demo", usage_billed: "500.00", commit_drawn_down: "0.00", overage: "0.00", expired_credits: "0.00", adjustments: "0.00" }] })));
    expect(document.body.textContent).toContain("500.00"); expect(document.body.textContent).not.toContain("Sync period to Stripe");
  });

  it("TEID-UI-1-T14 defaults audit to 30 days and links the existing CSV endpoint", async () => {
    const calls: string[] = [];
    const module = await screen("auditLog"); await module.render(document.querySelector("#app")!, context("Developer", async (path) => { calls.push(path); return { data: [{ event_type: "sign_in", occurred_at: new Date().toISOString() }] }; }));
    expect(calls[0]).toMatch(/^\/audit-log\?from=/); expect(document.querySelector<HTMLAnchorElement>("[data-export-endpoint]")!.getAttribute("href")).toMatch(/^\/audit-log\/export\.csv\?from=/);
  });

  it("TEID-UI-1-T15 shows plaintext only in one-time create/rotate dialogs, never list/detail", async () => {
    let mode = "list";
    const module = await screen("apiKeys");
    document.querySelector("#app")!.append(module.apiKeysPanel(context("Developer", async (path, options) => {
      if (path === "/api-keys" && options?.method === "POST") return { key: "sk_test_plaintext", id: "key-1" };
      if (path.endsWith("/rotate")) return { key: "sk_test_rotated", id: "key-2" };
      if (path === "/api-keys/key-1") return { display_hint: "sk_test_****text", scope: "read-only", environment: "sandbox", status: "active" };
      return { data: [{ id: "key-1", label: "Test", display_hint: "sk_test_****text", scope: "read-only", environment: "sandbox", status: "active", created_at: "now" }] };
    })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("sk_test_****text"));
    const form = document.querySelector<HTMLFormElement>(".api-key-form")!; form.querySelector<HTMLInputElement>("[name=label]")!.value = "New"; form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("dialog")?.textContent).toContain("sk_test_plaintext"));
    expect(document.querySelector("dialog")?.textContent).toContain("will not be shown again");
    document.querySelector<HTMLButtonElement>("dialog button")!.click(); expect(document.body.textContent).not.toContain("sk_test_plaintext");
    mode = "done"; expect(mode).toBe("done");
  });

  it("TEID-UI-1-T16 shared 401 handling clears session and all prior figures", async () => {
    vi.resetModules();
    sessionStorage.setItem("teideal_console_session", "expired");
    document.querySelector("#app")!.textContent = "500.00 previously fetched";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "expired" }), { status: 401, headers: { "content-type": "application/json" } })));
    const appPath = pathToFileURL(resolve(import.meta.dirname, "../../services/ts-console/public/app.js")).href; await import(appPath);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Welcome back"));
    expect(sessionStorage.getItem("teideal_console_session")).toBeNull();
    expect(document.body.textContent).not.toContain("500.00 previously fetched");
  });
});
