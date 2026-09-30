import { Secret, TOTP } from "otpauth";
import { BILLING_EMAIL, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export async function billingSession(): Promise<string> {
  const primary = await call<{ status?: string; session_token?: string; pending_token?: string; error?: string }>(
    `${TS_CONSOLE_URL}/auth/login`,
    { method: "POST", body: { tenant_key: "acct_1001", email: BILLING_EMAIL, password: "BillingPass123!" } },
  );
  if (primary.status !== 200) throw new Error(`billing login failed: ${primary.status} ${JSON.stringify(primary.body)}`);
  if (primary.body.status === "authenticated" && primary.body.session_token) return primary.body.session_token;
  if (!primary.body.pending_token) throw new Error("billing login returned no pending token");
  const code = new TOTP({
    issuer: "Teideal",
    label: BILLING_EMAIL,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32("KRSXG5CTMVRXEZLU"),
  }).generate();
  const verified = await call<{ session_token?: string; error?: string }>(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST",
    body: { pending_token: primary.body.pending_token, totp_code: code },
  });
  if (verified.status !== 200 || !verified.body.session_token) {
    throw new Error(`billing MFA failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return verified.body.session_token;
}
