import { Secret, TOTP } from "otpauth";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export const BILLING = { email: "billing@acmeco.com", password: "BillingPass123!", secret: "KRSXG5CTMVRXEZLU" };
export const OWNER = { email: "owner@acmeco.com", password: "OwnerPass123!", secret: "JBSWY3DPEHPK3PXP" };

export function totp(secret: string, email: string): string {
  return new TOTP({ issuer: "Teideal", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate();
}

export async function fullLogin(user = BILLING): Promise<string> {
  const primary = await call<{ status: string; pending_token?: string; session_token?: string }>(`${TS_CONSOLE_URL}/auth/login`, { method: "POST", body: { tenant_key: "acct_1001", email: user.email, password: user.password } });
  if (primary.body.session_token) return primary.body.session_token;
  const verified = await call<{ session_token: string }>(`${TS_CONSOLE_URL}/auth/mfa/verify`, { method: "POST", body: { pending_token: primary.body.pending_token, totp_code: totp(user.secret, user.email) } });
  return verified.body.session_token;
}
