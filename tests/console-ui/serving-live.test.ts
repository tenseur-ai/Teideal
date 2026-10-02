import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL } from "./env.js";

describe("TEID-UI-1 static console serving", () => {
  it("serves the no-build shell and redirects the service root", async () => {
    const root = await fetch(`${TS_CONSOLE_URL}/`, { redirect: "manual" });
    expect(root.status).toBeGreaterThanOrEqual(300);
    expect(root.status).toBeLessThan(400);
    expect(root.headers.get("location")).toBe("/console/");

    const page = await fetch(`${TS_CONSOLE_URL}/console/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('id="primary-nav"');
    expect(html).toContain('id="app"');
    expect(html).toContain('type="module"');

    const script = await fetch(`${TS_CONSOLE_URL}/console/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
  });
});
