import { Secret, TOTP } from "otpauth";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
export const OPS_USER_ID = "00000000-0000-0000-0000-0000a0001007";
export const OWNER_ID = "00000000-0000-0000-0000-0000a0001001";

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

export async function opsSession(): Promise<string> {
  return login("ops@teideal.com", "OpsPass123!", "KRSXG5CTMVRXEZLU");
}

export async function ownerSession(): Promise<string> {
  return login("owner@acmeco.com", "OwnerPass123!", "JBSWY3DPEHPK3PXP");
}
