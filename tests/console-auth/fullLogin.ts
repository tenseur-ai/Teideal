import { TS_CONSOLE_URL } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { codeFor } from "./totp.js";

// Completes a full sign-in (password, then MFA if the account needs it)
// and returns a ready-to-use session token. Shared by every test that
// just needs an authenticated session rather than being about the login
// flow itself.
export async function fullLogin(email: string, password: string, mfaSecret?: string): Promise<string> {
  const primary = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: TENANT_KEY, email, password },
  });
  if (primary.status !== 200) throw new Error(`login failed for ${email}: ${primary.status} ${JSON.stringify(primary.body)}`);
  if (primary.body.status === "authenticated") return primary.body.session_token;

  if (primary.body.status === "mfa_required") {
    if (!mfaSecret) throw new Error(`${email} requires MFA but no secret was provided`);
    const verify = await call(`${TS_CONSOLE_URL}/auth/mfa/verify`, {
      method: "POST",
      body: { pending_token: primary.body.pending_token, totp_code: codeFor(mfaSecret, email) },
    });
    if (verify.status !== 200) throw new Error(`mfa verify failed for ${email}: ${verify.status} ${JSON.stringify(verify.body)}`);
    return verify.body.session_token;
  }

  throw new Error(`unexpected login status for ${email}: ${primary.body.status}`);
}
