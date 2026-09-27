import { Secret, TOTP } from "otpauth";
import { call } from "./http.js";

export const TS_CONSOLE_URL = process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081";
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal";
export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
export const OWNER_ID = "00000000-0000-0000-0000-0000a0001001";

export async function passwordSession(email: string, password: string): Promise<string> {
  const response = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST", body: { tenant_key: "acct_1001", email, password },
  });
  if (response.status !== 200 || response.body.status !== "authenticated") {
    throw new Error(`Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.session_token;
}

export async function ownerSession(): Promise<string> {
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email: "owner@acmeco.com", password: "OwnerPass123!" },
  });
  if (primary.status !== 200) throw new Error(`Owner login failed: ${primary.status}`);
  if (primary.body.status === "authenticated") return primary.body.session_token;
  const code = new TOTP({
    issuer: "Teideal", label: "owner@acmeco.com", algorithm: "SHA1", digits: 6, period: 30,
    secret: Secret.fromBase32("JBSWY3DPEHPK3PXP"),
  }).generate();
  const verified = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST", body: { pending_token: primary.body.pending_token, totp_code: code },
  });
  if (verified.status !== 200) throw new Error(`Owner MFA failed: ${verified.status}`);
  return verified.body.session_token;
}

export async function createUser(token: string, role: string, marker: string) {
  const email = `${marker}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = "RoleTestPass123!";
  const response = await call(`${TS_CONSOLE_URL}/users`, {
    method: "POST", token, body: { email, password, role },
  });
  return { response, email, password };
}

export async function mintGoogleIdToken(email: string, subject: string): Promise<string> {
  const url = process.env.FAKE_GOOGLE_URL ?? "http://127.0.0.1:8090";
  const response = await fetch(`${url}/mint`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, subject }),
  });
  return (await response.json()).id_token;
}
