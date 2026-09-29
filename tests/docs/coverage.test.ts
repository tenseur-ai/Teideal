import { describe, expect, it } from "vitest";
import { checkCoverage } from "../../docs/api/check-coverage.js";

describe("TEID-62-T1 documentation coverage", () => {
  it("matches every registered route in both services and requires complete entries", async () => {
    const result = await checkCoverage();
    expect(result.actual.length).toBeGreaterThan(0);
    expect(result.undocumented).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.malformed).toEqual([]);
    expect(result.missingErrorCodes).toEqual([]);
    expect(result.missingReasonValues).toEqual([]);
  });
});
