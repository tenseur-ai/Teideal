// TEID-37 acceptance suite. env.ts is imported first so the encryption key is
// set before stripeConnect.ts reads it at module load.
import "./env.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertWriteScope,
  decryptToken,
  readUsableAccessToken,
  requireConnectedAccessToken,
  StripeConnectionClosedError,
  StripeScopeError,
} from "../../services/ts-console/src/lib/stripeConnect.js";
import { pool, withTenant } from "./db.js";
import { BILLING_USER_ID, FAKE_STRIPE_URL, TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { billingSession } from "./session.js";

const READ_ONLY_NOTICE =
  "Teideal will only be able to read your Stripe data. It cannot create, modify, or delete anything in Stripe.";

interface LoggedExchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
}

interface ConnectionSecrets {
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_auth_tag: string;
  stripe_account_id: string;
  scope: string;
  status: string;
}

let token: string;

function requestWithoutRedirect(target: string): Promise<{ status: number; location: string | null; body: string }> {
  const url = new URL(target);
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const location = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          location: Array.isArray(location) ? location[0] ?? null : location ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fakeLog(): Promise<LoggedExchange[]> {
  const response = await fetch(`${FAKE_STRIPE_URL}/_requests`);
  const body = await response.json() as { requests: LoggedExchange[] };
  return body.requests;
}

async function authorize(sessionToken: string, scope?: string) {
  const url = scope === undefined
    ? `${TS_CONSOLE_URL}/stripe/connect/authorize-url`
    : `${TS_CONSOLE_URL}/stripe/connect/authorize-url?scope=${encodeURIComponent(scope)}`;
  return call(url, { token: sessionToken });
}

async function redeem(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const redirected = await requestWithoutRedirect(authorizeUrl);
  expect(redirected.status).toBe(302);
  expect(redirected.location).toBeTruthy();
  const location = new URL(redirected.location!, authorizeUrl);
  const code = location.searchParams.get("code");
  const state = location.searchParams.get("state");
  expect(code).toBeTruthy();
  expect(state).toBeTruthy();
  return { code: code!, state: state! };
}

async function connectReadOnly(sessionToken: string) {
  const started = await authorize(sessionToken, "read_only");
  expect(started.status).toBe(200);
  const redeemed = await redeem(started.body.url);
  const created = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
    method: "POST",
    token: sessionToken,
    body: { code: redeemed.code, state: redeemed.state },
  });
  return { started, redeemed, created };
}

async function loadSecrets(id: string): Promise<ConnectionSecrets> {
  return withTenant(TENANT_ID, async (client) => {
    const row = (await client.query<ConnectionSecrets>(
      `SELECT access_token_ciphertext, access_token_iv, access_token_auth_tag, stripe_account_id, scope, status
       FROM stripe_connections WHERE id = $1`,
      [id],
    )).rows[0];
    if (!row) throw new Error(`connection ${id} not visible`);
    return row;
  });
}

async function connectionCount(): Promise<number> {
  return withTenant(TENANT_ID, async (client) => {
    const row = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_connections`)).rows[0];
    return row.n;
  });
}

function accessTokenFor(log: LoggedExchange[], code: string): string {
  const hit = [...log].reverse().find((row) =>
    row.path === "/oauth/token" && row.requestBody.includes(`code=${code}`) && row.responseStatus === 200,
  );
  if (!hit) throw new Error(`no token exchange recorded for ${code}`);
  return JSON.parse(hit.responseBody).access_token as string;
}

const FORBIDDEN_KEY = /^(card|card_number|cardnumber|cvv|cvc|account_number|routing_number|last4|bank_account|pan)$/i;
const CARD_RUN = /\d{16}/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scanValue(value: unknown, path: string, problems: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    // UUIDs contain a 4-4-4-4 hyphen group. That is an identifier, not a card number.
    if (!UUID_TEXT.test(value) && CARD_RUN.test(value)) problems.push(`${path} has a 16-digit number`);
    if (/^\d{3,4}$/.test(value)) problems.push(`${path} is a 3-4 digit value`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, `${path}[${index}]`, problems));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) problems.push(`field ${path}.${key}`);
      scanValue(child, `${path}.${key}`, problems);
    }
  }
}

function scanText(label: string, text: string, problems: string[]): void {
  const withoutUuids = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "");
  if (CARD_RUN.test(withoutUuids)) problems.push(`${label} has a 16-digit number`);
  if (/(^|[?&])(card|card_number|cvv|cvc|account_number|routing_number|last4|bank_account|pan)=/i.test(text)) {
    problems.push(`${label} has a payment field`);
  }
  if (/"[^"]*(card_number|cardnumber|cvv|cvc|account_number|routing_number|last4|bank_account)[^"]*"\s*:/i.test(text)) {
    problems.push(`${label} has a payment field name`);
  }
  try {
    scanValue(JSON.parse(text), label, problems);
  } catch {
    // form bodies and redirect URLs are not JSON
  }
}

beforeAll(async () => {
  token = await billingSession();
});

afterAll(async () => {
  await pool.end();
});

describe("TEID-37 Stripe Connect", () => {
  it("TEID-37-T1 completes the OAuth code flow and stores a decryptable access token", async () => {
    const { created, redeemed } = await connectReadOnly(token);
    expect(created.status).toBe(201);
    expect(created.body.scope).toBe("read_only");
    expect(created.body.status).toBe("connected");
    expect(created.body.stripe_account_id).toBeTruthy();
    expect(created.body.connected_at).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toMatch(/access_token|ciphertext|auth_tag|client_secret/i);

    const rows = await withTenant(TENANT_ID, async (client) =>
      (await client.query(`SELECT id FROM stripe_connections WHERE id = $1`, [created.body.id])).rowCount,
    );
    expect(rows).toBe(1);
    const stored = await loadSecrets(created.body.id);
    expect(stored.access_token_ciphertext.length).toBeGreaterThan(0);
    expect(stored.access_token_iv.length).toBeGreaterThan(0);
    expect(stored.access_token_auth_tag.length).toBeGreaterThan(0);
    const issued = accessTokenFor(await fakeLog(), redeemed.code);
    expect(decryptToken(stored.access_token_ciphertext, stored.access_token_iv, stored.access_token_auth_tag)).toBe(issued);
  });

  it("TEID-37-T2 requests read-only scope by default and states that Teideal cannot change Stripe", async () => {
    const response = await authorize(token);
    expect(response.status).toBe(200);
    const url = new URL(response.body.url);
    expect(response.body.url).toContain("scope=read_only");
    expect(url.searchParams.get("scope")).toBe("read_only");
    expect(response.body.url).not.toContain("read_write");
    expect(response.body.notice).toBe(READ_ONLY_NOTICE);
    expect(response.body.notice).toContain("cannot");
    expect(response.body.notice).toMatch(/cannot create, modify, or delete anything in Stripe/);
  });

  it("TEID-37-T3 asks for write scope with a separate authorize URL and does not upgrade the existing connection", async () => {
    const connected = await connectReadOnly(token);
    expect(connected.created.status).toBe(201);
    const before = await connectionCount();
    const upgrade = await call(`${TS_CONSOLE_URL}/stripe/connections/${connected.created.body.id}/request-write-access`, {
      method: "POST",
      token,
      body: {},
    });
    expect(upgrade.status).toBe(200);
    const upgraded = new URL(upgrade.body.url);
    const original = new URL(connected.started.body.url);
    expect(upgrade.body.url).toContain("scope=read_write");
    expect(upgraded.searchParams.get("scope")).toBe("read_write");
    expect(upgrade.body.url).not.toBe(connected.started.body.url);
    expect(upgraded.searchParams.get("state")).not.toBe(original.searchParams.get("state"));
    expect(await connectionCount()).toBe(before);
    const stored = await loadSecrets(connected.created.body.id);
    expect(stored.scope).toBe("read_only");
    expect(stored.status).toBe("connected");
  });

  it("TEID-37-T4 never stores or transmits card or bank details", async () => {
    const problems: string[] = [];
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name].bind(console));
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
        originals[methods.indexOf(name)](...args);
      };
    }
    const logFrom = (await fakeLog()).length;
    try {
      const connected = await connectReadOnly(token);
      expect(connected.created.status).toBe(201);
      scanValue(connected.started.body, "authorize-response", problems);
      scanValue(connected.created.body, "callback-response", problems);
      const exchanged = (await fakeLog()).slice(logFrom);
      expect(exchanged.length).toBeGreaterThan(0);
      for (const entry of exchanged) {
        scanText(`fake ${entry.method} ${entry.path} query`, `${entry.query}\n${entry.requestBody}`, problems);
        scanText(`fake ${entry.method} ${entry.path} response`, entry.responseBody, problems);
      }
      const doc = await withTenant(TENANT_ID, async (client) =>
        (await client.query<{ doc: unknown }>(
          `SELECT row_to_json(c) AS doc FROM stripe_connections c WHERE id = $1`,
          [connected.created.body.id],
        )).rows[0].doc,
      );
      scanValue(doc, "stripe_connections", problems);
      for (const line of lines) scanText("console", line, problems);
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index];
      });
    }
    expect(problems).toEqual([]);

    const columns = (await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stripe_connections'`,
    )).rows.map((row) => row.column_name);
    expect(columns).toContain("access_token_ciphertext");
    const forbidden = /card|cvv|cvc|account_number|routing_number|last4|bank_account|pan/i;
    expect(columns.filter((name) => forbidden.test(name))).toEqual([]);
    for (const name of ["card_number", "cvv", "account_number", "routing_number", "last4"]) {
      expect(columns).not.toContain(name);
    }
  });

  it("TEID-37-T5 disconnects immediately, rejects token use, and audits the actor", async () => {
    const connected = await connectReadOnly(token);
    expect(connected.created.status).toBe(201);
    const windowStart = Date.now();
    const disconnected = await call(`${TS_CONSOLE_URL}/stripe/connections/${connected.created.body.id}/disconnect`, {
      method: "POST",
      token,
      body: {},
    });
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.status).toBe("disconnected");
    expect(JSON.stringify(disconnected.body)).not.toMatch(/access_token|ciphertext|auth_tag/i);

    await expect(withTenant(TENANT_ID, (client) => readUsableAccessToken(client, connected.created.body.id)))
      .rejects.toBeInstanceOf(StripeConnectionClosedError);
    // Garbage ciphertext would fail decryption. The status check has to run
    // first, so this throws the closed-connection error instead.
    expect(() => requireConnectedAccessToken({
      status: "disconnected",
      scope: "read_only",
      access_token_ciphertext: "not-ciphertext",
      access_token_iv: "not-an-iv",
      access_token_auth_tag: "not-a-tag",
    })).toThrow(StripeConnectionClosedError);

    const audit = await call(`${TS_CONSOLE_URL}/audit-log?object_type=StripeConnection`, { token });
    expect(audit.status).toBe(200);
    const entry = audit.body.data.find((row: { object_id: string; after: { status?: string } | null }) =>
      row.object_id === connected.created.body.id && row.after?.status === "disconnected",
    );
    expect(entry).toBeTruthy();
    expect(entry.object_type).toBe("StripeConnection");
    expect(entry.actor_user_id).toBe(BILLING_USER_ID);
    const occurredAt = new Date(entry.occurred_at).getTime();
    expect(occurredAt).toBeGreaterThanOrEqual(windowStart - 2_000);
    expect(occurredAt).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  it("TEID-37-T6 rejects a disconnected connection from the local status check within 5 seconds", async () => {
    const connected = await connectReadOnly(token);
    expect(connected.created.status).toBe(201);
    const disconnected = await call(`${TS_CONSOLE_URL}/stripe/connections/${connected.created.body.id}/disconnect`, {
      method: "POST",
      token,
      body: {},
    });
    expect(disconnected.status).toBe(200);
    const started = performance.now();
    await expect(withTenant(TENANT_ID, (client) => readUsableAccessToken(client, connected.created.body.id)))
      .rejects.toBeInstanceOf(StripeConnectionClosedError);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(5_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("TEID-37-T7 rejects a write attempt on a read-only connection before calling Stripe", async () => {
    const connected = await connectReadOnly(token);
    expect(connected.created.status).toBe(201);
    const stored = await loadSecrets(connected.created.body.id);
    expect(stored.scope).toBe("read_only");
    const before = (await fakeLog()).filter((row) => row.path.startsWith("/oauth"));
    expect(() => assertWriteScope(stored)).toThrow(StripeScopeError);
    const after = (await fakeLog()).filter((row) => row.path.startsWith("/oauth"));
    expect(after).toEqual(before);
  });

  it("TEID-37-T8 rejects a second exchange of an authorization code that was already used", async () => {
    const connected = await connectReadOnly(token);
    expect(connected.created.status).toBe(201);
    const beforeCount = await connectionCount();
    const original = await loadSecrets(connected.created.body.id);
    const fresh = await authorize(token, "read_only");
    expect(fresh.status).toBe(200);
    const redeemed = await redeem(fresh.body.url);
    expect(redeemed.state).not.toBe(connected.redeemed.state);
    const replay = await call(`${TS_CONSOLE_URL}/stripe/connect/callback`, {
      method: "POST",
      token,
      body: { code: connected.redeemed.code, state: redeemed.state },
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await connectionCount()).toBe(beforeCount);
    const after = await loadSecrets(connected.created.body.id);
    expect(after).toEqual(original);

    const exchanges = (await fakeLog()).filter((row) =>
      row.path === "/oauth/token" && row.requestBody.includes(`code=${connected.redeemed.code}`),
    );
    expect(exchanges.map((row) => row.responseStatus)).toEqual([200, 400]);
  });
});
