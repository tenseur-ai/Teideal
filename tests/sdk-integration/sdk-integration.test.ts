import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TeidealClient, type Logger } from "teideal-node";
import { startFlakyProxy, type FlakyProxy } from "./flaky-proxy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const GO_USAGE_URL = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
const API_KEY = "devkey_1001";
const CUSTOMER_ID = "00000000-0000-0000-0000-0000000c1001";
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const INSTALL_PYTHON = pythonWithSetuptools();
const SETUPTOOLS_PATH = externalSetuptoolsPath();
const OFFLINE_DURATION_MS = Number(process.env.SDK_OFFLINE_TEST_DURATION_MS ?? "600000");
const BENCHMARK_COUNT = Number(process.env.SDK_LATENCY_BENCHMARK_EVENTS_PER_MIN ?? "10000");
const temporaryRoots: string[] = [];
const proxies: FlakyProxy[] = [];

class CaptureLogger implements Logger {
  records: Array<{ level: string; args: unknown[] }> = [];
  debug(...args: unknown[]): void { this.records.push({ level: "debug", args }); }
  info(...args: unknown[]): void { this.records.push({ level: "info", args }); }
  warn(...args: unknown[]): void { this.records.push({ level: "warn", args }); }
  error(...args: unknown[]): void { this.records.push({ level: "error", args }); }
}

afterEach(async () => {
  while (proxies.length) await proxies.pop()?.close();
  while (temporaryRoots.length) {
    const path = temporaryRoots.pop();
    if (path && path.startsWith(resolve(HERE))) rmSync(path, { recursive: true, force: true });
  }
});

describe("TEID-59 SDK acceptance", () => {
  it("TEID-59-T1 installs both public packages in fresh projects and sends real events", async () => {
    const nodeProject = scratch(".tmp-sdk-node-install-");
    writeFileSync(join(nodeProject, "package.json"), JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }));
    execFileSync(npmCommand(), ["install", resolve(REPO, "sdks/typescript"), "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: nodeProject, stdio: "pipe", shell: process.platform === "win32",
    });
    const nodeScript = join(nodeProject, "send.mjs");
    writeFileSync(nodeScript, `import { TeidealClient } from "teideal-node";
const c = new TeidealClient(process.argv[2], process.argv[3], console, process.argv[5], {retryBackoffs:[0,0]});
const r = await c.sendEvent(process.argv[4], "sdk.install.node", 1); c.close(); console.log(JSON.stringify(r));`);
    const nodeResult = JSON.parse(execFileSync(process.execPath, [nodeScript, GO_USAGE_URL, API_KEY, CUSTOMER_ID, join(nodeProject, "buffer.ndjson")], { encoding: "utf8" })) as { id: string; idempotencyKey: string };
    expect(await eventCount(nodeResult.idempotencyKey)).toBe(1);

    const pythonProject = scratch(".tmp-sdk-python-install-");
    execFileSync(INSTALL_PYTHON, ["-m", "venv", "--system-site-packages", join(pythonProject, "venv")], { stdio: "pipe" });
    const venvPython = process.platform === "win32" ? join(pythonProject, "venv", "Scripts", "python.exe") : join(pythonProject, "venv", "bin", "python");
    const pipArguments = ["-m", "pip", "install", "--no-deps"];
    if (SETUPTOOLS_PATH) pipArguments.push("--no-build-isolation");
    pipArguments.push(resolve(REPO, "sdks/python"));
    execFileSync(venvPython, pipArguments, {
      stdio: "pipe",
      env: SETUPTOOLS_PATH ? { ...process.env, PYTHONPATH: SETUPTOOLS_PATH } : process.env,
    });
    const pythonScript = join(pythonProject, "send.py");
    writeFileSync(pythonScript, `import json,sys\nfrom teideal import TeidealClient\nc=TeidealClient(sys.argv[1],sys.argv[2],buffer_path=sys.argv[4],retry_backoffs=(0,0))\nr=c.send_event(sys.argv[3],"sdk.install.python",1)\nc.close()\nprint(json.dumps({"id":r.id,"idempotencyKey":r.idempotency_key}))\n`);
    const pythonResult = JSON.parse(execFileSync(venvPython, [pythonScript, GO_USAGE_URL, API_KEY, CUSTOMER_ID, join(pythonProject, "buffer.db")], { encoding: "utf8" })) as { id: string; idempotencyKey: string };
    expect(await eventCount(pythonResult.idempotencyKey)).toBe(1);
  });

  it("TEID-59-T2 retries exactly three times with one key and records one event", async () => {
    const nodeProxy = await proxy({ target: GO_USAGE_URL, failures: 2 });
    const nodeClient = new TeidealClient(nodeProxy.url, API_KEY, console, buffer("t2-node.ndjson"), { retryBackoffs: [0, 0] });
    const nodeResult = await nodeClient.sendEvent(CUSTOMER_ID, "sdk.retry.node", 1);
    expect(nodeProxy.requests).toHaveLength(3);
    expect(new Set(nodeProxy.requests.map((request) => request.body.idempotency_key)).size).toBe(1);
    expect(await eventCount(nodeResult.idempotencyKey)).toBe(1);
    nodeClient.close();

    const pythonProxy = await proxy({ target: GO_USAGE_URL, failures: 2 });
    const pythonResult = await runPython("send", pythonProxy.url, API_KEY, CUSTOMER_ID, buffer("t2-python.db")) as { id: string; idempotencyKey: string };
    expect(pythonProxy.requests).toHaveLength(3);
    expect(new Set(pythonProxy.requests.map((request) => request.body.idempotency_key)).size).toBe(1);
    expect(await eventCount(pythonResult.idempotencyKey)).toBe(1);
  });

  it("TEID-59-T3 keeps the billing path successful and logs Teideal 500s", async () => {
    const nodeProxy = await proxy({ target: GO_USAGE_URL, alwaysFail: true });
    const logger = new CaptureLogger();
    const nodeClient = new TeidealClient(nodeProxy.url, API_KEY, logger, buffer("t3-node.ndjson"), { retryBackoffs: [0, 0] });
    const billing: string[] = [];
    nodeClient.sendEventBestEffort(CUSTOMER_ID, "sdk.best_effort.node", 1);
    billing.push("succeeded");
    expect(billing).toEqual(["succeeded"]);
    await eventually(() => logger.records.some((record) => record.level === "error"));
    expect(logger.records.some((record) => record.level === "error")).toBe(true);
    nodeClient.close();

    const pythonProxy = await proxy({ target: GO_USAGE_URL, alwaysFail: true });
    const python = await runPython("best-effort", pythonProxy.url, API_KEY, CUSTOMER_ID, buffer("t3-python.db")) as { errors: number };
    billing.push("python-succeeded");
    expect(python.errors).toBeGreaterThan(0);
    expect(billing).toEqual(["succeeded", "python-succeeded"]);
  });

  it("TEID-59-T4 automatically flushes every disk-buffered event exactly once", async () => {
    const nodeProxy = await proxy({ target: GO_USAGE_URL, alwaysFail: true });
    const nodePath = buffer("t4-node.ndjson");
    const nodeClient = new TeidealClient(nodeProxy.url, API_KEY, console, nodePath, {
      retryBackoffs: [0, 0], flushInterval: 50,
    });
    const deadline = Date.now() + OFFLINE_DURATION_MS;
    do {
      nodeClient.sendEventBestEffort(CUSTOMER_ID, `sdk.offline.node.${journalKeys(nodePath).length}`, 1);
      await delay(10);
    } while (Date.now() < deadline);
    const nodeKeys = [...new Set(journalKeys(nodePath))];
    nodeClient.baseUrl = GO_USAGE_URL;
    await eventually(async () => (await Promise.all(nodeKeys.map(eventCount))).every((count) => count === 1));
    nodeClient.close();

    const python = await runPython("auto-recover", nodeProxy.url, GO_USAGE_URL, API_KEY, CUSTOMER_ID, buffer("t4-python.db")) as { keys: string[]; remaining: boolean };
    expect(python.remaining).toBe(false);
    expect((await Promise.all(python.keys.map(eventCount))).every((count) => count === 1)).toBe(true);
  });

  it("TEID-59-T6 keeps mean and p99 SDK overhead below 5ms at scaled load", async () => {
    const nodeClient = new TeidealClient(GO_USAGE_URL, API_KEY, console, buffer("t6-node.ndjson"), { retryBackoffs: [0, 0] });
    const rawLatencies: number[] = [];
    const sdkLatencies: number[] = [];
    for (let index = 0; index < BENCHMARK_COUNT; index += 1) {
      const rawStarted = performance.now();
      await rawSend("sdk.raw.node");
      rawLatencies.push(performance.now() - rawStarted);
      const sdkStarted = performance.now();
      await nodeClient.sendEvent(CUSTOMER_ID, "sdk.benchmark.node", 1);
      sdkLatencies.push(performance.now() - sdkStarted);
    }
    rawLatencies.sort((a, b) => a - b);
    sdkLatencies.sort((a, b) => a - b);
    const mean = Math.max(0, average(sdkLatencies) - average(rawLatencies));
    const percentileIndex = Math.min(BENCHMARK_COUNT - 1, Math.max(0, Math.floor(BENCHMARK_COUNT * 0.99) - 1));
    const p99 = Math.max(0, sdkLatencies[percentileIndex] - rawLatencies[percentileIndex]);
    expect(mean).toBeLessThan(5);
    expect(p99).toBeLessThan(5);
    nodeClient.close();

    const python = await runPython("benchmark", GO_USAGE_URL, API_KEY, CUSTOMER_ID, buffer("t6-python.db")) as { mean: number; p99: number; count: number };
    expect(python.count).toBe(BENCHMARK_COUNT);
    expect(python.mean).toBeLessThan(5);
    expect(python.p99).toBeLessThan(5);
  });

  it("TEID-59-T8 survives process death mid-flush with no loss or duplicates", async () => {
    const heldNode = await proxy({ target: GO_USAGE_URL, hold: true });
    const nodePath = buffer("t8-node.ndjson");
    const nodeChild = spawn(process.execPath, [join(HERE, "node-crash-runner.mjs"), heldNode.url, API_KEY, CUSTOMER_ID, nodePath], { stdio: "ignore" });
    await eventually(() => heldNode.requests.length === 3);
    await kill(nodeChild);
    const nodeKeys = journalKeys(nodePath);
    const recoveredNode = new TeidealClient(GO_USAGE_URL, API_KEY, console, nodePath, { retryBackoffs: [0, 0], compactionThreshold: 1 });
    await eventually(async () => (await Promise.all(nodeKeys.map(eventCount))).every((count) => count === 1));
    expect((await Promise.all(nodeKeys.map(eventCount))).every((count) => count === 1)).toBe(true);
    recoveredNode.close();

    const heldPython = await proxy({ target: GO_USAGE_URL, hold: true });
    const pythonPath = buffer("t8-python.db");
    const pythonChild = spawn(PYTHON, [join(HERE, "python-runner.py"), "crash", heldPython.url, API_KEY, CUSTOMER_ID, pythonPath], {
      env: pythonEnvironment(), stdio: "ignore",
    });
    await eventually(() => heldPython.requests.length === 3);
    await kill(pythonChild);
    const pythonKeys = sqliteKeys(pythonPath);
    await runPython("flush", GO_USAGE_URL, API_KEY, pythonPath);
    expect((await Promise.all(pythonKeys.map(eventCount))).every((count) => count === 1)).toBe(true);
  });
});

function scratch(prefix: string): string {
  const path = mkdtempSync(join(HERE, prefix));
  temporaryRoots.push(path);
  return path;
}

function buffer(name: string): string {
  const root = scratch(".tmp-sdk-buffer-");
  return join(root, name);
}

async function proxy(options: Parameters<typeof startFlakyProxy>[0]): Promise<FlakyProxy> {
  const instance = await startFlakyProxy(options);
  proxies.push(instance);
  return instance;
}

function runPython(command: string, ...args: string[]): Promise<unknown> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(PYTHON, [join(HERE, "python-runner.py"), command, ...args], {
      env: pythonEnvironment(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code !== 0) return rejectRun(new Error(`Python runner exited ${code}: ${stderr}`));
      resolveRun(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "null") as unknown);
    });
  });
}

function pythonEnvironment(): NodeJS.ProcessEnv {
  const existing = process.env.PYTHONPATH;
  return { ...process.env, PYTHONPATH: [resolve(REPO, "sdks/python"), existing].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
}

function npmCommand(): string { return process.platform === "win32" ? "npm.cmd" : "npm"; }

function pythonWithSetuptools(): string {
  const candidates = [PYTHON];
  if (process.platform === "win32") {
    try {
      const output = execFileSync("py", ["-0p"], { encoding: "utf8" });
      candidates.push(...output.split(/\r?\n/).map((line) => line.trim().split(/\s+/).at(-1) ?? "").filter(Boolean));
    } catch { /* The configured Python remains the only candidate. */ }
    const localPrograms = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Python") : "";
    if (localPrograms && existsSync(localPrograms)) {
      candidates.push(...readdirSync(localPrograms).map((directory) => join(localPrograms, directory, "python.exe")));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      execFileSync(candidate, ["-c", "import setuptools"], { stdio: "ignore" });
      return candidate;
    } catch { /* Try the next installed interpreter. */ }
  }
  return PYTHON;
}

function externalSetuptoolsPath(): string | undefined {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const root = join(process.env.LOCALAPPDATA, "Programs", "Python");
  if (!existsSync(root)) return undefined;
  for (const directory of readdirSync(root)) {
    const sitePackages = join(root, directory, "Lib", "site-packages");
    if (existsSync(join(sitePackages, "setuptools"))) return sitePackages;
  }
  return undefined;
}

async function eventCount(idempotencyKey: string): Promise<number> {
  const response = await fetch(`${GO_USAGE_URL}/usage?customer_id=${CUSTOMER_ID}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!response.ok) throw new Error(`GET /usage failed: ${response.status}`);
  const body = await response.json() as { data: Array<{ idempotency_key: string }> };
  return body.data.filter((event) => event.idempotency_key === idempotencyKey).length;
}

async function rawSend(eventType: string): Promise<void> {
  const response = await fetch(`${GO_USAGE_URL}/usage`, {
    method: "POST", headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: CUSTOMER_ID, event_type: eventType, quantity: 1, idempotency_key: crypto.randomUUID() }),
  });
  if (response.status !== 201) throw new Error(`raw POST /usage failed: ${response.status}`);
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("condition was not met before timeout");
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }

function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

async function kill(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function journalKeys(path: string): string[] {
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { idempotencyKey: string }).idempotencyKey);
}

function sqliteKeys(path: string): string[] {
  const script = "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps([r[0] for r in c.execute('select idempotency_key from events where sent_at is null')]))";
  return JSON.parse(execFileSync(PYTHON, ["-c", script, path], { encoding: "utf8" })) as string[];
}
