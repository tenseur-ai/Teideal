import { Secret, TOTP } from "otpauth";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
export const TENANT_KEY = "acct_1001";
export const API_KEY = "devkey_1001";
export const OWNER_ID = "00000000-0000-0000-0000-0000a0001001";
export const OWNER_EMAIL = "owner@acmeco.com";
const OWNER_PASSWORD = "OwnerPass123!";
const OWNER_MFA_SECRET = "JBSWY3DPEHPK3PXP";

function ownerCode(): string {
  return new TOTP({
    issuer: "Teideal",
    label: OWNER_EMAIL,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(OWNER_MFA_SECRET),
  }).generate();
}

export async function ownerSession(): Promise<string> {
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: TENANT_KEY, email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  if (primary.status !== 200) throw new Error(`Owner login failed: ${primary.status} ${JSON.stringify(primary.body)}`);
  if (primary.body.status === "authenticated") return primary.body.session_token;
  const verified = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
    method: "POST",
    body: { pending_token: primary.body.pending_token, totp_code: ownerCode() },
  });
  if (verified.status !== 200) throw new Error(`Owner MFA failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  return verified.body.session_token;
}
