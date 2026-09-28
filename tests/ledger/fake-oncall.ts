import { createServer, type IncomingMessage } from "node:http";

interface AlertPayload {
  tenant_id: string;
  unbalanced_transaction_ids: string[];
  checked_at: string;
}

const state: { alerts: AlertPayload[] } = { alerts: [] };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const port = Number(process.env.FAKE_ONCALL_PORT ?? 8092);
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && req.url === "/state") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === "POST" && req.url === "/control") {
      const command = JSON.parse((await readBody(req)) || "{}") as { reset?: boolean };
      if (command.reset) state.alerts = [];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === "POST" && req.url === "/alerts") {
      state.alerts.push(JSON.parse(await readBody(req)) as AlertPayload);
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-oncall: listening on http://127.0.0.1:${port}`);
});
