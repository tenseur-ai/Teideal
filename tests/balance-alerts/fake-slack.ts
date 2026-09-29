// Stand-in for a Slack incoming webhook. Production code POSTs
// { text } JSON at the tenant-configured URL the same way go-usage's
// postAlert posts at ONCALL_ALERT_WEBHOOK_URL. Failure mode returns 500
// so a threshold alert can record slack: "failed" without a real workspace.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

interface LoggedRequest {
  method: string;
  path: string;
  body: string;
  status: number;
}

const requests: LoggedRequest[] = [];
let failure = false;
let listening = false;

const port = Number(process.env.FAKE_SLACK_PORT ?? 8094);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function finish(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/healthz") {
      finish(res, 200, JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && path === "/_requests") {
      finish(res, 200, JSON.stringify({ requests }));
      return;
    }
    if (req.method === "POST" && path === "/_reset") {
      requests.length = 0;
      failure = false;
      finish(res, 200, JSON.stringify({ reset: true }));
      return;
    }
    if (req.method === "POST" && path === "/_mode") {
      const raw = await readBody(req);
      let payload: { failure?: unknown } = {};
      try {
        payload = JSON.parse(raw) as { failure?: unknown };
      } catch {
        finish(res, 400, JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (typeof payload.failure !== "boolean") {
        finish(res, 400, JSON.stringify({ error: "failure must be a boolean" }));
        return;
      }
      failure = payload.failure;
      finish(res, 200, JSON.stringify({ failure }));
      return;
    }

    if (req.method !== "POST") {
      finish(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readBody(req);
    const status = failure ? 500 : 200;
    requests.push({ method: "POST", path, body, status });
    finish(res, status, JSON.stringify(failure ? { error: "simulated failure" } : { ok: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish(res, 500, JSON.stringify({ error: message }));
  }
});

export function fakeSlackUrl(): string {
  return `http://127.0.0.1:${port}`;
}

export async function startFakeSlack(): Promise<string> {
  if (listening) return fakeSlackUrl();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      listening = true;
      resolve();
    });
  });
  return fakeSlackUrl();
}

export async function stopFakeSlack(): Promise<void> {
  if (!listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  listening = false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeSlack()
    .then((url) => {
      console.log(`fake-slack: listening on ${url}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
