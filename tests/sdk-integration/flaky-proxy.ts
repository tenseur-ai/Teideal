import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface FlakyProxy {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

export async function startFlakyProxy(options: {
  target: string;
  failures?: number;
  alwaysFail?: boolean;
  hold?: boolean;
}): Promise<FlakyProxy> {
  const requests: CapturedRequest[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ path: request.url ?? "/", body });
    if (options.hold) {
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    if (options.alwaysFail || requests.length <= (options.failures ?? 0)) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "injected transient failure" }));
      return;
    }
    await forward(request, response, options.target, body);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy failed to bind TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const response of held) response.destroy();
      await close(server);
    },
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const upstream = await fetch(new URL(request.url ?? "/", target), {
      method: request.method,
      headers: {
        authorization: request.headers.authorization ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    response.end(await upstream.text());
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
