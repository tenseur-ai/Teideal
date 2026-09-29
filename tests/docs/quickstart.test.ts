import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { executeRunnableExample, extractRunnableExamples } from "./runnableExamples.js";

describe("TEID-62-T2 scripted quick-start proxy", () => {
  it("runs the published account-to-key-to-rate-to-event-to-read-back walkthrough within five minutes", async () => {
    const examples = (await extractRunnableExamples()).filter((example) => example.file === "docs/quickstart.md");
    expect(examples).toHaveLength(1);
    const started = performance.now();
    await executeRunnableExample(examples[0]);
    expect(performance.now() - started).toBeLessThan(300_000);
  });
});
