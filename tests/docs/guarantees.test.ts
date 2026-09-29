import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("TEID-62-T3 documented guarantees", () => {
  it("names all guarantees and only references test files that exist", async () => {
    const markdown = await readFile(path.join(repoRoot, "docs/guarantees.md"), "utf8");
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1].toLowerCase());
    expect(headings).toEqual(expect.arrayContaining(["exactly-once ingestion", "ordering", "degraded mode"]));

    for (const guarantee of ["Exactly-once ingestion", "Ordering", "Degraded mode"]) {
      const section = markdown.split(`## ${guarantee}`)[1]?.split(/^## /m)[0] ?? "";
      const paths = [...section.matchAll(/`((?:tests|sdks)\/[A-Za-z0-9_./-]+\.(?:ts|py))`/g)].map((match) => match[1]);
      expect(paths.length, `${guarantee} must name its verifying files`).toBeGreaterThan(0);
      await Promise.all(paths.map((file) => access(path.join(repoRoot, file))));
    }
  });
});
