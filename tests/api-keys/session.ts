import { Secret, TOTP } from "otpauth";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
export const CUSTOMER_ID = "00000000-0000-0000-0000-0000000c1001";
export const OWNER_ID = "00000000-0000-0000-0000-0000a0001001";

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
