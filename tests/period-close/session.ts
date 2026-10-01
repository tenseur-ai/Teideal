import { Secret, TOTP } from "otpauth";
import { BILLING_EMAIL, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export async function passwordSession(email: string, password: string): Promise<string> {
  const response = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email, password },
  });
  if (response.status !== 200 || response.body.status !== "authenticated") {
    throw new Error(`login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.session_token;
}

export function financeSession(): Promise<string> {
  return passwordSession("finance@acmeco.com", "FinancePass123!");
}

export function supportSession(): Promise<string> {
  return passwordSession("support@acmeco.com", "SupportPass123!");
}

export async function billingSession(): Promise<string> {
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email: BILLING_EMAIL, password: "BillingPass123!" },
  });
  if (primary.status !== 200) {
    throw new Error(`billing login failed: ${primary.status} ${JSON.stringify(primary.body)}`);
  }
  if (primary.body.status === "authenticated") return primary.body.session_token;
  const code = new TOTP({
    issuer: "Teideal",
    label: BILLING_EMAIL,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32("KRSXG5CTMVRXEZLU"),
  }).generate();
  const verified = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST",
    body: { pending_token: primary.body.pending_token, totp_code: code },
  });
  if (verified.status !== 200) {
    throw new Error(`billing MFA failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return verified.body.session_token;
}
