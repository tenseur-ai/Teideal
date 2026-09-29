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
  livemode: boolean;
}

interface StripeCustomerRecord {
  name: string | null;
  email: string | null;
}

interface IssuedToken {
  scope: string;
  stripeUserId: string;
  stripeCustomers: Map<string, StripeCustomerRecord>;
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
const issuedTokens = new Map<string, IssuedToken>();
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

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length <= "Bearer ".length) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function lookupIssued(req: IncomingMessage): IssuedToken | null {
  const token = bearerToken(req);
  if (!token) return null;
  return issuedTokens.get(token) ?? null;
}

function parseCustomerFields(requestBody: string, contentType: string): { name: string | null; email: string | null } {
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(requestBody) as { name?: unknown; email?: unknown };
      return {
        name: typeof json.name === "string" ? json.name : null,
        email: typeof json.email === "string" ? json.email : null,
      };
    } catch {
      return { name: null, email: null };
    }
  }
  const params = new URLSearchParams(requestBody);
  return { name: params.get("name"), email: params.get("email") };
}

function listCustomers(
  issued: IssuedToken,
  email: string | null,
  startingAfter: string | null,
  limit: number,
): { data: Array<{ id: string; object: string; name: string | null; email: string | null }>; has_more: boolean } {
  let rows = [...issued.stripeCustomers.entries()].map(([id, record]) => ({
    id,
    object: "customer",
    name: record.name,
    email: record.email,
  }));
  if (email !== null) rows = rows.filter((row) => row.email === email);
  if (startingAfter) {
    const index = rows.findIndex((row) => row.id === startingAfter);
    rows = index >= 0 ? rows.slice(index + 1) : [];
  }
  return {
    data: rows.slice(0, limit),
    has_more: rows.length > limit,
  };
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
    if (req.method === "POST" && path === "/_seed/customers") {
      const requestBody = await readBody(req);
      let payload: { access_token?: unknown; customers?: unknown } = {};
      try {
        payload = JSON.parse(requestBody) as { access_token?: unknown; customers?: unknown };
      } catch {
        finish(res, 400, JSON.stringify({ error: "invalid json" }), "application/json");
        return;
      }
      if (typeof payload.access_token !== "string" || !issuedTokens.has(payload.access_token)) {
        finish(res, 400, JSON.stringify({ error: "unknown access_token" }), "application/json");
        return;
      }
      if (!Array.isArray(payload.customers)) {
        finish(res, 400, JSON.stringify({ error: "customers must be an array" }), "application/json");
        return;
      }
      const issued = issuedTokens.get(payload.access_token)!;
      const seeded: string[] = [];
      for (const row of payload.customers) {
        if (typeof row !== "object" || row === null) continue;
        const record = row as { id?: unknown; name?: unknown; email?: unknown };
        const id = typeof record.id === "string" && record.id.length > 0
          ? record.id
          : `cus_seed_${letters(14)}`;
        issued.stripeCustomers.set(id, {
          name: typeof record.name === "string" ? record.name : null,
          email: typeof record.email === "string" ? record.email : null,
        });
        seeded.push(id);
      }
      finish(res, 200, JSON.stringify({ seeded: seeded.length, ids: seeded }), "application/json");
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
          livemode: url.searchParams.get("livemode") === "true",
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
        issuedTokens.set(issued.accessToken, {
          scope: issued.scope,
          stripeUserId: issued.stripeUserId,
          stripeCustomers: new Map(),
        });
        responseStatus = 200;
        responseBody = JSON.stringify({
          access_token: issued.accessToken,
          stripe_user_id: issued.stripeUserId,
          scope: issued.scope,
          livemode: issued.livemode,
          token_type: "bearer",
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "GET" && path === "/v1/customers") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else {
        const limitRaw = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
        const listed = listCustomers(
          issued,
          url.searchParams.get("email"),
          url.searchParams.get("starting_after"),
          limit,
        );
        responseStatus = 200;
        responseBody = JSON.stringify({
          object: "list",
          url: "/v1/customers",
          has_more: listed.has_more,
          data: listed.data,
        });
      }
      finish(res, responseStatus, responseBody, "application/json");
    } else if (req.method === "POST" && path === "/v1/customers") {
      const issued = lookupIssued(req);
      if (!issued) {
        responseStatus = 401;
        responseBody = JSON.stringify({ error: "unauthorized" });
      } else if (issued.scope === "read_only") {
        responseStatus = 403;
        responseBody = JSON.stringify({ error: "read_only" });
      } else {
        const fields = parseCustomerFields(requestBody, String(req.headers["content-type"] ?? ""));
        const id = `cus_${letters(14)}`;
        issued.stripeCustomers.set(id, { name: fields.name, email: fields.email });
        responseStatus = 200;
        responseBody = JSON.stringify({
          id,
          object: "customer",
          name: fields.name,
          email: fields.email,
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
