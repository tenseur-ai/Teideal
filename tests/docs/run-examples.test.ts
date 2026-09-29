import { describe, expect, it } from "vitest";
import { executeRunnableExample, extractRunnableExamples } from "./runnableExamples.js";

describe("TEID-62-T6 executable documentation", () => {
  it("executes every runnable fenced block exactly as published", async () => {
    const examples = await extractRunnableExamples();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) await executeRunnableExample(example);
  });
});
