// Stand-in for Stripe Connect OAuth. Production code talks to it through
// STRIPE_CONNECT_BASE_URL the same way Google sign-in talks to fake-google.
// Authorization codes are single-use: the first /oauth/token exchange
// succeeds and every later exchange of that same code is invalid_grant.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

interface IssuedCode {
  scope: string;
  stripeUserId: string;
  accessToken: string;
}

interface LoggedExchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
}

const pending = new Map<string, IssuedCode>();
const consumed = new Set<string>();
const requests: LoggedExchange[] = [];

function letters(count: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(count);
  let out = "";
  for (let i = 0; i < count; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function finish(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

const port = Number(process.env.FAKE_STRIPE_PORT ?? 8092);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/healthz") {
      finish(res, 200, JSON.stringify({ status: "ok" }), "application/json");
      return;
    }
    // The debug read is not itself an OAuth exchange. Logging it would make
    // the captured body contain the log.
    if (req.method === "GET" && path === "/_requests") {
      finish(res, 200, JSON.stringify({ requests }), "application/json");
      return;
    }

    const requestBody = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
    let responseStatus = 404;
    let responseBody = "";

    if (req.method === "GET" && path === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        responseStatus = 400;
        responseBody = JSON.stringify({ error: "redirect_uri is required" });
        finish(res, responseStatus, responseBody, "application/json");
      } else {
        const scope = url.searchParams.get("scope") === "read_write" ? "read_write" : "read_only";
        const code = `ac_test_${letters(20)}`;
        const issued: IssuedCode = {
          scope,
          stripeUserId: `acct_${letters(16)}`,
          accessToken: `sk_test_fake_${letters(24)}`,
        };
        pending.set(code, issued);
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        responseStatus = 302;
        responseBody = redirect.toString();
        res.statusCode = 302;
        res.setHeader("Location", redirect.toString());
        res.end();
      }
    } else if (req.method === "POST" && path === "/oauth/token") {
      const params = new URLSearchParams(requestBody);
      const code = params.get("code") ?? "";
      if (consumed.has(code) || !pending.has(code)) {
        responseStatus = 400;
        responseBody = JSON.stringify({ error: "invalid_grant" });
      } else {
        const issued = pending.get(code)!;
        pending.delete(code);
        consumed.add(code);
        responseStatus = 200;
        responseBody = JSON.stringify({
          access_token: issued.accessToken,
          stripe_user_id: issued.stripeUserId,
          scope: issued.scope,
          livemode: false,
          token_type: "bearer",
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "POST" && path === "/oauth/deauthorize") {
      const params = new URLSearchParams(requestBody);
      responseStatus = 200;
      responseBody = JSON.stringify({ stripe_user_id: params.get("stripe_user_id") ?? "" });
      finish(res, responseStatus, responseBody, "application/json");
    } else if (responseStatus === 404) {
      responseBody = JSON.stringify({ error: "not_found" });
      finish(res, 404, responseBody, "application/json");
    }

    requests.push({
      method: req.method ?? "GET",
      path,
      query: url.search,
      requestBody,
      responseStatus,
      responseBody,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-stripe: listening on http://127.0.0.1:${port}`);
});
