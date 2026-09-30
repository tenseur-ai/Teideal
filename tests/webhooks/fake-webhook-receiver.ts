import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface CapturedWebhookRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  status: number;
  responseBody: string;
}

const requests: CapturedWebhookRequest[] = [];
let failureCount = 0;
let persistentFailure = false;
let received = 0;
let listening = false;
const port = Number(process.env.FAKE_WEBHOOK_PORT ?? 8095);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function finish(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      finish(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_requests") {
      finish(res, 200, { requests });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_reset") {
      requests.length = 0;
      failureCount = 0;
      persistentFailure = false;
      received = 0;
      finish(res, 200, { reset: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_mode") {
      const body = JSON.parse(await readBody(req)) as { failure_count?: unknown; persistent_failure?: unknown };
      if (body.failure_count !== undefined &&
          (typeof body.failure_count !== "number" || !Number.isInteger(body.failure_count) || body.failure_count < 0)) {
        finish(res, 400, { error: "failure_count must be a non-negative integer" });
        return;
      }
      if (body.persistent_failure !== undefined && typeof body.persistent_failure !== "boolean") {
        finish(res, 400, { error: "persistent_failure must be a boolean" });
        return;
      }
      failureCount = Number(body.failure_count ?? 0);
      persistentFailure = body.persistent_failure === true;
      received = 0;
      finish(res, 200, { failure_count: failureCount, persistent_failure: persistentFailure });
      return;
    }
    if (req.method !== "POST") {
      finish(res, 404, { error: "not found" });
      return;
    }

    const body = await readBody(req);
    received += 1;
    const fails = persistentFailure || received <= failureCount;
    const status = fails ? 500 : 200;
    const result = fails ? { error: "simulated failure", received } : { ok: true, received };
    requests.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body,
      status,
      responseBody: JSON.stringify(result),
    });
    finish(res, status, result);
  } catch (error) {
    finish(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

export function fakeWebhookUrl(): string {
  return `http://127.0.0.1:${port}`;
}

export async function startFakeWebhookReceiver(): Promise<string> {
  if (listening) return fakeWebhookUrl();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      listening = true;
      resolve();
    });
  });
  return fakeWebhookUrl();
}

export async function stopFakeWebhookReceiver(): Promise<void> {
  if (!listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  listening = false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeWebhookReceiver()
    .then((url) => console.log(`fake-webhook-receiver: listening on ${url}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
