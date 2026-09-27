import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GO_USAGE_URL, loadFixtures, type Fixtures } from "./env.js";
import { call } from "./http.js";

let fx: Fixtures;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const goUsageDir = path.join(repoRoot, "services/go-usage");
const temporaryDirectories: string[] = [];

beforeAll(() => {
  fx = loadFixtures();
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runMoneyCheck(target = "./internal/money") {
  return spawnSync("go", ["run", "./tools/checkmoney", target], {
    cwd: goUsageDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GOCACHE: path.join(repoRoot, ".gocache"),
      GOMODCACHE: path.join(repoRoot, ".gomodcache"),
    },
  });
}

function scaledThousandths(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
}

describe("TEID-94 currency precision and rounding rules", () => {
  // TEID-94-T1: official minor-unit rendering for USD, JPY, and KWD.
  it("TEID-94-T1: renders USD, JPY, and KWD with 2, 0, and 3 decimal places", async () => {
    const cases = [
      { currency: "USD", pattern: /^\d+\.\d{2}$/ },
      { currency: "JPY", pattern: /^\d+$/ },
      { currency: "KWD", pattern: /^\d+\.\d{3}$/ },
    ];

    for (const testCase of cases) {
      const response = await call(`${GO_USAGE_URL}/money/preview`, {
        method: "POST",
        apiKey: fx.tenant1.apiKey,
        body: {
          currency: testCase.currency,
          lines: [{ amount: "10.999" }],
          rounding_point: "per_line",
          rounding_method: "round_half_up",
        },
      });
      expect(response.status).toBe(200);
      expect(response.body.lines[0].amount).toMatch(testCase.pattern);
      expect(response.body.total).toMatch(testCase.pattern);
    }
  });

  // TEID-94-T2: the real package passes and an injected float field fails with file:line output.
  it("TEID-94-T2: blocks a float-typed monetary field", () => {
    const clean = runMoneyCheck();
    expect(clean.status, clean.stderr).toBe(0);

    const temporaryRoot = mkdtempSync(path.join(repoRoot, ".tmp-money-check-"));
    temporaryDirectories.push(temporaryRoot);
    const copiedMoney = path.join(temporaryRoot, "money");
    cpSync(path.join(goUsageDir, "internal/money"), copiedMoney, { recursive: true });
    writeFileSync(
      path.join(copiedMoney, "injected_float.go"),
      "package money\n\ntype injectedAmount struct {\n\tValue float64\n}\n",
      "utf8",
    );

    const rejected = runMoneyCheck(copiedMoney);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/injected_float\.go:\d+: forbidden monetary type float64/);
  });

  // TEID-94-T3: identical fractional-cent lines differ at per-line versus per-invoice rounding points.
  it("TEID-94-T3: applies tenant-specific per-line and per-invoice rounding", async () => {
    const importedBillingSystem = "teid-94-t3";
    const tenantAConfig = await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_point: "per_line" },
    });
    const tenantBConfig = await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant2.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_point: "per_invoice" },
    });
    expect(tenantAConfig.status).toBe(200);
    expect(tenantBConfig.status).toBe(200);

    const body = {
      currency: "USD",
      imported_billing_system: importedBillingSystem,
      lines: [{ amount: "33.335" }, { amount: "33.335" }, { amount: "33.335" }],
    };
    const perLine = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body,
    });
    const perInvoice = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body,
    });

    expect(perLine.status).toBe(200);
    expect(perInvoice.status).toBe(200);
    expect(perLine.body.lines.map((line: { amount: string }) => line.amount)).toEqual(["33.34", "33.34", "33.34"]);
    expect(perLine.body.total).toBe("100.02");
    expect(perInvoice.body.lines.map((line: { amount: string }) => line.amount)).toEqual(["33.335", "33.335", "33.335"]);
    expect(perInvoice.body.total).toBe("100.01");
    expect(perLine.body.total).not.toBe(perInvoice.body.total);
  });

  // TEID-94-T4: midpoint behavior differs between half-up and half-to-even.
  it("TEID-94-T4: applies tenant-specific half-up and half-to-even methods", async () => {
    const importedBillingSystem = "teid-94-t4";
    await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_method: "round_half_up" },
    });
    await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant2.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_method: "round_half_to_even" },
    });

    const body = {
      currency: "USD",
      imported_billing_system: importedBillingSystem,
      lines: [{ amount: "0.125" }],
    };
    const halfUp = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body,
    });
    const halfEven = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant2.apiKey,
      body,
    });

    expect(halfUp.status).toBe(200);
    expect(halfEven.status).toBe(200);
    expect(halfUp.body.lines[0].amount).toBe("0.13");
    expect(halfEven.body.lines[0].amount).toBe("0.12");
  });

  // TEID-94-T5: invoice-level remainder is explicit and reconciles the full-precision lines to the rounded total.
  it("TEID-94-T5: reports the 0.005 rounding adjustment as a distinct entry", async () => {
    const response = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        currency: "USD",
        imported_billing_system: "teid-94-t5-no-stored-config",
        rounding_point: "per_invoice",
        lines: [{ amount: "33.335" }, { amount: "33.335" }, { amount: "33.335" }],
      },
    });

    expect(response.status).toBe(200);
    expect(["100.00", "100.01"]).toContain(response.body.total);
    expect(response.body.rounding_adjustment).toBe("0.005");
    const lineSum = response.body.lines.reduce(
      (sum: bigint, line: { amount: string }) => sum + scaledThousandths(line.amount),
      0n,
    );
    const total = scaledThousandths(response.body.total);
    const adjustment = scaledThousandths(response.body.rounding_adjustment);
    expect(lineSum + adjustment === total || lineSum - adjustment === total).toBe(true);
  });

  // TEID-94-T6: audit the complete money package, including unexported declarations and casts.
  it("TEID-94-T6: finds zero float32 or float64 identifiers in the complete money package", () => {
    const result = runMoneyCheck();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  // TEID-94-T7: one partial update changes only the method.
  it("TEID-94-T7: changes only rounding_method with one PUT", async () => {
    const importedBillingSystem = "teid-94-t7";
    await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_point: "per_event", rounding_method: "round_half_up" },
    });
    const before = await call(
      `${GO_USAGE_URL}/rounding-config?imported_billing_system=${encodeURIComponent(importedBillingSystem)}`,
      { apiKey: fx.tenant1.apiKey },
    );

    const updated = await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_method: "round_half_to_even" },
    });
    expect(updated.status).toBe(200);

    const after = await call(
      `${GO_USAGE_URL}/rounding-config?imported_billing_system=${encodeURIComponent(importedBillingSystem)}`,
      { apiKey: fx.tenant1.apiKey },
    );
    expect(after.status).toBe(200);
    expect(after.body.rounding_method).toBe("round_half_to_even");
    expect(after.body.rounding_point).toBe(before.body.rounding_point);
  });

  // TEID-94-T8: invalid enum input is rejected and cannot mutate stored configuration.
  it("TEID-94-T8: rejects an unsupported rounding method without changing config", async () => {
    const importedBillingSystem = "teid-94-t8";
    await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_method: "round_half_to_even", rounding_point: "per_invoice" },
    });
    const configURL = `${GO_USAGE_URL}/rounding-config?imported_billing_system=${encodeURIComponent(importedBillingSystem)}`;
    const before = await call(configURL, { apiKey: fx.tenant1.apiKey });

    const rejected = await call(`${GO_USAGE_URL}/rounding-config`, {
      method: "PUT",
      apiKey: fx.tenant1.apiKey,
      body: { imported_billing_system: importedBillingSystem, rounding_method: "round_down_always" },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("rounding_method must be round_half_up or round_half_to_even");

    const after = await call(configURL, { apiKey: fx.tenant1.apiKey });
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  });

  // TEID-94-T9: string input keeps 0.1 + 0.2 exact at a visible three-decimal scale.
  it("TEID-94-T9: computes 0.1 plus 0.2 as exact decimal 0.300", async () => {
    const response = await call(`${GO_USAGE_URL}/money/preview`, {
      method: "POST",
      apiKey: fx.tenant1.apiKey,
      body: {
        currency: "KWD",
        lines: [{ amount: "0.1" }, { amount: "0.2" }],
        rounding_point: "per_invoice",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe("0.300");
    expect(JSON.stringify(response.body)).not.toContain("0.30000000000000004");
  });
});
