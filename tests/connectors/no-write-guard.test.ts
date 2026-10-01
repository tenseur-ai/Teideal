import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ForbiddenCall {
  offset: number;
  method: string;
}

export function findForbiddenFetchCalls(source: string): ForbiddenCall[] {
  const forbidden: ForbiddenCall[] = [];
  const fetchCall = /\bfetch\s*\(/g;
  for (const match of source.matchAll(fetchCall)) {
    const callStart = match.index!;
    const open = source.indexOf("(", callStart);
    let depth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    let end = source.length;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    const call = source.slice(callStart, end);
    const method = /\bmethod\s*:\s*(["'`])([^"'`]+)\1/i.exec(call);
    if (method && method[2].toUpperCase() !== "GET") {
      forbidden.push({ offset: callStart, method: method[2].toUpperCase() });
    } else if (/\bmethod\s*:/.test(call) && !method) {
      forbidden.push({ offset: callStart, method: "dynamic" });
    }
  }
  return forbidden;
}

describe("TEID-65-T8 connector write release guard", () => {
  it("TEID-65-T8 allows only GET or method-less fetch calls in connector source", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const connectorDirectory = path.resolve(here, "../../services/ts-console/src/lib/connectors");
    const files = (await readdir(connectorDirectory)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(path.join(connectorDirectory, file), "utf8");
      const calls = [...source.matchAll(/\bfetch\s*\(/g)];
      if (file === "credentials.ts") expect(calls, `${file} must contain no fetch calls`).toHaveLength(0);
      expect(findForbiddenFetchCalls(source), `${file} contains a billing-system write call`).toEqual([]);
    }
  });

  it("TEID-65-T8 adversarial self-proof catches a forged hidden write call", () => {
    const forgedSource = 'async function hidden(url: string) { await fetch(url, { method: "POST" }); }';
    expect(findForbiddenFetchCalls(forgedSource)).toEqual([{ offset: forgedSource.indexOf("fetch"), method: "POST" }]);
  });
});
