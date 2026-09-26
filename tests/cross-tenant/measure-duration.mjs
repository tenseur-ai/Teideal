#!/usr/bin/env node
// TEID-41-T5 (Non-functional): the full cross-tenant isolation regression
// suite must complete in under 15 minutes so it doesn't block release
// cadence. This wraps the real `vitest run` invocation (not a self-timed
// assertion inside vitest, which can't measure vitest's own total wall
// clock) and fails if the budget is exceeded.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 15 * 60 * 1000;
const here = path.dirname(fileURLToPath(import.meta.url));

const startedAt = Date.now();
const child = spawn("npx", ["vitest", "run"], { cwd: here, stdio: "inherit" });

child.on("exit", (code) => {
  const elapsedMs = Date.now() - startedAt;
  const elapsedMin = (elapsedMs / 60_000).toFixed(2);
  console.log(`\nTEID-41-T5: suite took ${elapsedMin} min (budget: 15 min)`);

  if (code !== 0) {
    console.error("TEID-41-T5: suite failed -- see output above (duration check is moot if tests failed).");
    process.exit(code ?? 1);
  }
  if (elapsedMs >= BUDGET_MS) {
    console.error(`TEID-41-T5: FAILED -- suite took ${elapsedMin} min, exceeding the 15 minute budget.`);
    process.exit(1);
  }
  console.log("TEID-41-T5: PASSED");
  process.exit(0);
});
