// TEID-37: Stripe Connect OAuth (authorize URL, code exchange, deauthorize)
// and recoverable storage of the access token. The token must be presented
// back to Stripe, so it is encrypted with AES-256-GCM rather than hashed.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { SignJWT, jwtVerify } from "jose";

export const READ_ONLY_NOTICE =
  "Teideal will only be able to read your Stripe data. It cannot create, modify, or delete anything in Stripe.";

export type StripeScope = "read_only" | "read_write";

const DEFAULT_CONNECT_BASE_URL = "https://connect.stripe.com";

export class StripeConfigError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

export class StripeOAuthError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "StripeOAuthError";
  }
}

export class StripeScopeError extends Error {
  readonly statusCode = 403;
  constructor(message = "stripe connection is read-only and cannot perform write operations") {
    super(message);
    this.name = "StripeScopeError";
  }
}

export class StripeConnectionClosedError extends Error {
  readonly statusCode = 400;
  constructor(message = "stripe connection is disconnected") {
    super(message);
    this.name = "StripeConnectionClosedError";
  }
}

export interface OAuthStateClaims {
  tenantId: string;
  userId: string;
  scope: StripeScope;
}

export interface ExchangedToken {
  accessToken: string;
  stripeAccountId: string;
  scope: StripeScope;
}

export interface EncryptedToken {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface StripeConnectionSecrets {
  status: string;
  scope: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_auth_tag: string;
}

interface StripeEnv {
  encryptionKey: Buffer;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  redirectUri: string;
}

let cachedKey: Buffer | undefined;
let cachedEnv: StripeEnv | undefined;
let startupError: Error | undefined;

function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new StripeConfigError("STRIPE_TOKEN_ENCRYPTION_KEY must be base64 that decodes to 32 bytes");
  }
  return key;
}

// A present key is decoded once, here, at module load. A wrong length is
// remembered and reported as a 400-shaped startup failure. A missing key is
// not fatal at import time: tests construct the app in-process without Stripe
// env, and the process entrypoint calls assertStripeConfig before listen.
if (process.env.STRIPE_TOKEN_ENCRYPTION_KEY) {
  try {
    cachedKey = decodeKey(process.env.STRIPE_TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    startupError = err instanceof Error ? err : new StripeConfigError(String(err));
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new StripeConfigError(`${name} is required`);
  return value;
}

export function loadStripeEnv(): StripeEnv {
  if (startupError) throw startupError;
  if (cachedEnv) return cachedEnv;
  const rawKey = process.env.STRIPE_TOKEN_ENCRYPTION_KEY;
  if (!rawKey) throw new StripeConfigError("STRIPE_TOKEN_ENCRYPTION_KEY is required");
  const encryptionKey = cachedKey ?? decodeKey(rawKey);
  cachedKey = encryptionKey;
  const env: StripeEnv = {
    encryptionKey,
    clientId: requiredEnv("STRIPE_CONNECT_CLIENT_ID"),
    clientSecret: requiredEnv("STRIPE_CONNECT_CLIENT_SECRET"),
    baseUrl: (process.env.STRIPE_CONNECT_BASE_URL ?? DEFAULT_CONNECT_BASE_URL).replace(/\/+$/, ""),
    redirectUri: requiredEnv("STRIPE_CONNECT_REDIRECT_URI"),
  };
  cachedEnv = env;
  return env;
}

export function assertStripeConfig(): void {
  loadStripeEnv();
}

function encryptionKey(): Buffer {
  return loadStripeEnv().encryptionKey;
}

export function encryptToken(plaintext: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptToken(ciphertext: string, iv: string, authTag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

export function assertWriteScope(connection: { scope: string }): void {
  if (connection.scope !== "read_write") {
    throw new StripeScopeError("stripe connection is read-only and cannot perform write operations");
  }
}

// Future Stripe call sites (TEID-39/40) must go through this before using a
// token. Status is checked before decryption, so a disconnected row is
// rejected even if its ciphertext would still decrypt.
export function requireConnectedAccessToken(connection: StripeConnectionSecrets): string {
  if (connection.status !== "connected") {
    throw new StripeConnectionClosedError("stripe connection is disconnected");
  }
  return decryptToken(
    connection.access_token_ciphertext,
    connection.access_token_iv,
    connection.access_token_auth_tag,
  );
}

export async function readUsableAccessToken(client: PoolClient, connectionId: string): Promise<string> {
  const { rows } = await client.query<StripeConnectionSecrets>(
    `SELECT status, scope, access_token_ciphertext, access_token_iv, access_token_auth_tag
     FROM stripe_connections WHERE id = $1`,
    [connectionId],
  );
  const row = rows[0];
  if (!row) throw new StripeConnectionClosedError("stripe connection is disconnected");
  return requireConnectedAccessToken(row);
}

export async function buildAuthorizeUrl(tenantId: string, userId: string, scope: StripeScope): Promise<string> {
  const env = loadStripeEnv();
  // jti is the OAuth state nonce (single-use within the 10-minute expiry).
  const state = await new SignJWT({ tenantId, userId, scope })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(env.encryptionKey);
  const url = new URL(`${env.baseUrl}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("scope", scope);
  url.searchParams.set("redirect_uri", env.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function verifyState(token: string): Promise<OAuthStateClaims> {
  const env = loadStripeEnv();
  try {
    const { payload } = await jwtVerify(token, env.encryptionKey, { algorithms: ["HS256"] });
    const tenantId = payload.tenantId;
    const userId = payload.userId;
    const scope = payload.scope;
    if (typeof tenantId !== "string" || typeof userId !== "string" || (scope !== "read_only" && scope !== "read_write")) {
      throw new StripeOAuthError("invalid or expired oauth state");
    }
    return { tenantId, userId, scope };
  } catch (err) {
    if (err instanceof StripeOAuthError) throw err;
    throw new StripeOAuthError("invalid or expired oauth state");
  }
}

async function readResponse(response: Response): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { ok: response.ok, status: response.status, payload };
}

export async function exchangeCode(code: string): Promise<ExchangedToken> {
  const env = loadStripeEnv();
  const response = await fetch(`${env.baseUrl}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_secret: env.clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });
  const { ok, payload } = await readResponse(response);
  const body = payload as { error?: unknown; access_token?: unknown; stripe_user_id?: unknown; scope?: unknown } | null;
  if (!ok) {
    const message = body && typeof body.error === "string" ? body.error : "stripe token exchange failed";
    throw new StripeOAuthError(message);
  }
  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new StripeOAuthError("stripe token exchange returned no access_token");
  }
  if (typeof body.stripe_user_id !== "string" || body.stripe_user_id.length === 0) {
    throw new StripeOAuthError("stripe token exchange returned no stripe_user_id");
  }
  if (body.scope !== "read_only" && body.scope !== "read_write") {
    throw new StripeOAuthError("stripe token exchange returned an unsupported scope");
  }
  return { accessToken: body.access_token, stripeAccountId: body.stripe_user_id, scope: body.scope };
}

export async function deauthorize(stripeAccountId: string): Promise<void> {
  const env = loadStripeEnv();
  const response = await fetch(`${env.baseUrl}/oauth/deauthorize`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.clientId,
      stripe_user_id: stripeAccountId,
    }),
  });
  if (!response.ok) {
    await response.text();
    throw new StripeOAuthError("stripe deauthorize failed");
  }
  await response.text();
}
