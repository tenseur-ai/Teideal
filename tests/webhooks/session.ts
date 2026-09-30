import { Secret, TOTP } from "otpauth";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export const TENANT_ID = "00000000-0000-0000-0000-000000001001";

export async function opsSession(): Promise<string> {
  const email = "ops@teideal.com";
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email, password: "OpsPass123!" },
  });
  if (primary.status !== 200) throw new Error(`login failed: ${primary.status} ${JSON.stringify(primary.body)}`);
  if (primary.body.status === "authenticated") return primary.body.session_token;
  const code = new TOTP({
    issuer: "Teideal", label: email, algorithm: "SHA1", digits: 6, period: 30,
    secret: Secret.fromBase32("KRSXG5CTMVRXEZLU"),
  }).generate();
  const verified = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST", body: { pending_token: primary.body.pending_token, totp_code: code },
  });
  if (verified.status !== 200) throw new Error(`MFA failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return verified.body.session_token;
}
