import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./renderMarkdown.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((pair) => Number.parseInt(pair, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("TEID-62-T5 quick-start accessibility", () => {
  it("renders static HTML with no axe WCAG 2.1 A/AA violations", async () => {
    const markdown = await readFile(path.join(repoRoot, "docs/quickstart.md"), "utf8");
    const html = renderMarkdown(markdown);
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://docs.teideal.test/quickstart" });
    dom.window.eval(axe.source);
    const axeInWindow = (dom.window as unknown as { axe: typeof axe }).axe;
    const result = await axeInWindow.run(dom.window.document.documentElement, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([]);
    expect(html).toContain('<main>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<pre tabindex="0">');
    // jsdom cannot calculate painted color contrast, so verify the renderer's
    // two explicit foreground/background pairs mathematically in addition to
    // running axe's complete WCAG 2.1 A/AA rule set without suppressions.
    expect(contrast("111111", "ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("0645ad", "ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
