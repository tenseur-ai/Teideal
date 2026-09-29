import { afterEach, describe, expect, it } from "vitest";
import { deprecatedRoutes } from "../../services/ts-console/src/lib/deprecatedRoutes.js";
import { buildServer } from "../../services/ts-console/src/server.js";

afterEach(() => {
  delete deprecatedRoutes["/v0/usage"];
});

describe("TEID-62-T7 deprecated path guidance", () => {
  it("returns 410 and a current-path pointer without intercepting live routes", async () => {
    deprecatedRoutes["/v0/usage"] = "/usage";
    const app = buildServer();
    try {
      await app.ready();
      const retired = await app.inject({ method: "POST", url: "/v0/usage", payload: {} });
      expect(retired.statusCode).toBe(410);
      expect(retired.json()).toEqual({ error: "this path is deprecated", see: "/usage" });

      const live = await app.inject({ method: "GET", url: "/healthz" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
