import type { PoolClient } from "pg";
import { getTenantSettings } from "./tenants.js";
import { mfaRequiredFor, type UserRow } from "./users.js";
import { createPendingLogin } from "./pendingLogins.js";
import { createSession } from "./sessions.js";
import { generateSecret, otpauthUri } from "./totp.js";
import { writeAuditEventWithClient } from "./audit.js";

export type LoginOutcome =
  | { status: "authenticated"; sessionToken: string }
  | { status: "mfa_required"; pendingToken: string }
  | { status: "mfa_enrollment_required"; pendingToken: string; otpauthUri: string };

// Shared by both the password and Google sign-in routes once their
// respective primary factor has already succeeded: decides whether MFA is
// required (TEID-91-AC2) and either completes the sign-in or hands back a
// pending-login token for the appropriate next step.
//
// Everything here runs on the single `client` the caller already has open
// (from its own withTenant), never on the pool directly -- acquiring a
// second connection from the same pool while the first is still held is
// what caused concurrent logins to deadlock the pool under TEID-91-T6's
// load (every held connection waiting on a login that itself needed a
// free connection that could never come free).
export async function completePrimaryFactor(client: PoolClient, user: UserRow): Promise<LoginOutcome> {
  const settings = await getTenantSettings(client, user.tenant_id);

  if (mfaRequiredFor(user, settings)) {
    if (!user.mfa_enrolled_at) {
      const secret = generateSecret();
      await client.query(`UPDATE users SET pending_mfa_secret = $1 WHERE id = $2`, [secret, user.id]);
      const pendingToken = await createPendingLogin(client, user.tenant_id, user.id, "enroll");
      return { status: "mfa_enrollment_required", pendingToken, otpauthUri: otpauthUri(secret, user.email) };
    }
    const pendingToken = await createPendingLogin(client, user.tenant_id, user.id, "verify");
    return { status: "mfa_required", pendingToken };
  }

  const sessionToken = await createSession(client, user.tenant_id, user.id, settings.idleTimeoutMinutes);
  await writeAuditEventWithClient(client, user.tenant_id, user.id, "sign_in_success", { method: "primary_factor_only" });
  return { status: "authenticated", sessionToken };
}
