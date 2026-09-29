import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export interface RunnableExample {
  file: string;
  line: number;
  language: string;
  code: string;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
  }));
  return nested.flat();
}

export async function extractRunnableExamples(): Promise<RunnableExample[]> {
  const examples: RunnableExample[] = [];
  for (const filePath of await markdownFiles(path.join(repoRoot, "docs"))) {
    const markdown = await readFile(filePath, "utf8");
    const fence = /```([A-Za-z0-9_-]+)\s+runnable\s*\r?\n([\s\S]*?)```/g;
    for (const match of markdown.matchAll(fence)) {
      const language = match[1].toLowerCase();
      if (!["javascript", "js", "mjs"].includes(language)) {
        throw new Error(`${path.relative(repoRoot, filePath)} uses unsupported runnable language ${language}`);
      }
      examples.push({
        file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
        line: markdown.slice(0, match.index).split(/\r?\n/).length,
        language,
        code: match[2],
      });
    }
  }
  return examples.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

export async function executeRunnableExample(example: RunnableExample, timeoutMs = 300_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${example.file}:${example.line} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${example.file}:${example.line} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.stdin.end(example.code);
  });
}
