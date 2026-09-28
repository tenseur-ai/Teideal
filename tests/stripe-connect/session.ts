import { Secret, TOTP } from "otpauth";
import { BILLING_EMAIL, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

async function login(email: string, password: string, mfaSecret: string): Promise<string> {
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email, password },
  });
  if (primary.status !== 200) throw new Error(`${email} login failed: ${primary.status} ${JSON.stringify(primary.body)}`);
  if (primary.body.status === "authenticated") return primary.body.session_token;
  const code = new TOTP({
    issuer: "Teideal", label: email, algorithm: "SHA1", digits: 6, period: 30,
    secret: Secret.fromBase32(mfaSecret),
  }).generate();
  const verified = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST", body: { pending_token: primary.body.pending_token, totp_code: code },
  });
  if (verified.status !== 200) throw new Error(`${email} MFA failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return verified.body.session_token;
}

export async function billingSession(): Promise<string> {
  return login(BILLING_EMAIL, "BillingPass123!", "KRSXG5CTMVRXEZLU");
}
