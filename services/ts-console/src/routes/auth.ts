import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTenant } from "../lib/db.js";
import { resolveTenantByKey, getTenantSettings } from "../lib/tenants.js";
import { findUserByEmail, findUserByGoogleSubjectOrEmail, findUserById, MANDATORY_MFA_ROLES } from "../lib/users.js";
import { verifyPassword } from "../lib/passwords.js";
import { verifyGoogleIdToken, GoogleTimeoutError, GoogleVerificationError } from "../lib/google.js";
import { completePrimaryFactor } from "../lib/loginFlow.js";
import { getPendingLogin, deletePendingLogin } from "../lib/pendingLogins.js";
import { createSession, deleteSession } from "../lib/sessions.js";
import { verifyCode, generateSecret, otpauthUri } from "../lib/totp.js";
import { writeAuditEvent } from "../lib/audit.js";
import { sendEmail } from "../lib/notify.js";
import { requireSession } from "../lib/sessionAuth.js";

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MINUTES = 15;

// TEID-91-T8: keyed purely by the account (email within its tenant), never
// by request IP -- so rotating source IPs cannot bypass the lockout.
async function recordFailedPassword(pool: Pool, tenantId: string, userId: string, email: string): Promise<void> {
  const locked = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ failed_login_count: number }>(
      `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1 RETURNING failed_login_count`,
      [userId],
    );
    const count = rows[0].failed_login_count;
    if (count >= LOCKOUT_THRESHOLD) {
      await client.query(
        `UPDATE users SET locked_until = now() + interval '${LOCKOUT_MINUTES} minutes', failed_login_count = 0 WHERE id = $1`,
        [userId],
      );
      return true;
    }
    return false;
  });

  await writeAuditEvent(pool, tenantId, userId, "sign_in_failed", { email });
  if (locked) {
    await writeAuditEvent(pool, tenantId, userId, "account_locked", { email, minutes: LOCKOUT_MINUTES });
    await sendEmail(
      pool,
      tenantId,
      email,
      "Your Teideal account has been locked",
      `After ${LOCKOUT_THRESHOLD} failed sign-in attempts, your account is locked for ${LOCKOUT_MINUTES} minutes.`,
    );
  }
}

export function registerAuthRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/auth/login", async (req, reply) => {
    const body = req.body as { tenant_key?: string; email?: string; password?: string };
    if (!body.tenant_key || !body.email || !body.password) {
      return reply.code(400).send({ error: "tenant_key, email and password are required" });
    }

    const tenantId = await resolveTenantByKey(pool, body.tenant_key);
    if (!tenantId) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const outcome = await withTenant(pool, tenantId, async (client) => {
      const user = await findUserByEmail(client, body.email!);
      if (!user) return { kind: "invalid" as const };

      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        return { kind: "locked" as const };
      }
      if (!user.password_hash || !(await verifyPassword(body.password!, user.password_hash))) {
        return { kind: "bad_password" as const, userId: user.id };
      }

      await client.query(`UPDATE users SET failed_login_count = 0 WHERE id = $1`, [user.id]);
      return { kind: "ok" as const, user };
    });

    if (outcome.kind === "invalid") return reply.code(401).send({ error: "invalid credentials" });
    if (outcome.kind === "locked") return reply.code(423).send({ error: "account is temporarily locked" });
    if (outcome.kind === "bad_password") {
      await recordFailedPassword(pool, tenantId, outcome.userId, body.email);
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const result = await withTenant(pool, tenantId, (client) => completePrimaryFactor(client, outcome.user));
    return reply.send(toLoginResponse(result));
  });

  app.post("/auth/login/google", async (req, reply) => {
    const body = req.body as { tenant_key?: string; id_token?: string };
    if (!body.tenant_key || !body.id_token) {
      return reply.code(400).send({ error: "tenant_key and id_token are required" });
    }

    const tenantId = await resolveTenantByKey(pool, body.tenant_key);
    if (!tenantId) return reply.code(401).send({ error: "invalid credentials" });

    let identity;
    try {
      identity = await verifyGoogleIdToken(body.id_token);
    } catch (err) {
      if (err instanceof GoogleTimeoutError) {
        return reply.code(504).send({ error: "timed out reaching Google; please try again" });
      }
      if (err instanceof GoogleVerificationError) {
        return reply.code(401).send({ error: "google sign-in failed" });
      }
      throw err;
    }

    const outcome = await withTenant(pool, tenantId, async (client) => {
      const user = await findUserByGoogleSubjectOrEmail(client, identity.subject, identity.email);
      if (!user) return { kind: "invalid" as const };
      if (!user.google_subject) {
        await client.query(`UPDATE users SET google_subject = $1 WHERE id = $2`, [identity.subject, user.id]);
      }
      return { kind: "ok" as const, user };
    });

    if (outcome.kind === "invalid") return reply.code(401).send({ error: "no account linked to this Google identity" });

    const result = await withTenant(pool, tenantId, (client) => completePrimaryFactor(client, outcome.user));
    return reply.send(toLoginResponse(result));
  });

  app.post("/auth/mfa/verify", async (req, reply) => {
    const body = req.body as { pending_token?: string; totp_code?: string };
    if (!body.pending_token || !body.totp_code) {
      return reply.code(400).send({ error: "pending_token and totp_code are required" });
    }
    const pending = await getPendingLogin(pool, body.pending_token);
    if (!pending || pending.purpose !== "verify") {
      return reply.code(401).send({ error: "invalid or expired pending login" });
    }

    const valid = await withTenant(pool, pending.tenantId, async (client) => {
      const user = await findUserById(client, pending.userId);
      return user?.mfa_secret ? verifyCode(user.mfa_secret, user.email, body.totp_code!) : false;
    });
    if (!valid) return reply.code(401).send({ error: "invalid authentication code" });

    await deletePendingLogin(pool, pending.id);
    const settings = await withTenant(pool, pending.tenantId, (client) => getTenantSettings(client, pending.tenantId));
    const sessionToken = await createSession(pool, pending.tenantId, pending.userId, settings.idleTimeoutMinutes);
    await writeAuditEvent(pool, pending.tenantId, pending.userId, "sign_in_success", { method: "mfa" });
    return reply.send({ status: "authenticated", session_token: sessionToken });
  });

  app.post("/auth/mfa/enroll/confirm", async (req, reply) => {
    const body = req.body as { pending_token?: string; totp_code?: string };
    if (!body.pending_token || !body.totp_code) {
      return reply.code(400).send({ error: "pending_token and totp_code are required" });
    }
    const pending = await getPendingLogin(pool, body.pending_token);
    if (!pending || pending.purpose !== "enroll") {
      return reply.code(401).send({ error: "invalid or expired pending login" });
    }

    const settings = await withTenant(pool, pending.tenantId, async (client) => {
      const user = await findUserById(client, pending.userId);
      if (!user?.pending_mfa_secret || !verifyCode(user.pending_mfa_secret, user.email, body.totp_code!)) {
        return null;
      }
      await client.query(`UPDATE users SET mfa_secret = pending_mfa_secret, pending_mfa_secret = NULL, mfa_enrolled_at = now() WHERE id = $1`, [
        user.id,
      ]);
      return getTenantSettings(client, pending.tenantId);
    });
    if (!settings) return reply.code(401).send({ error: "invalid authentication code" });

    await deletePendingLogin(pool, pending.id);
    const sessionToken = await createSession(pool, pending.tenantId, pending.userId, settings.idleTimeoutMinutes);
    await writeAuditEvent(pool, pending.tenantId, pending.userId, "mfa_enrolled", {});
    await writeAuditEvent(pool, pending.tenantId, pending.userId, "sign_in_success", { method: "mfa_enrollment" });
    return reply.send({ status: "authenticated", session_token: sessionToken });
  });

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    scoped.post("/auth/mfa/reset", async (req, reply) => {
      const { tenantId, userId } = req.consolePrincipal!;
      const body = req.body as { totp_code?: string };
      const result = await withTenant(pool, tenantId, async (client) => {
        const user = await findUserById(client, userId);
        if (!user?.mfa_secret) return { kind: "not_enrolled" as const };
        if (!body.totp_code || !verifyCode(user.mfa_secret, user.email, body.totp_code)) return { kind: "bad_step_up" as const };
        const secret = generateSecret();
        await client.query(`UPDATE users SET pending_mfa_secret = $1 WHERE id = $2`, [secret, userId]);
        return { kind: "ok" as const, uri: otpauthUri(secret, user.email) };
      });
      if (result.kind === "not_enrolled") return reply.code(400).send({ error: "MFA is not enrolled on this account" });
      if (result.kind === "bad_step_up") return reply.code(401).send({ error: "current authentication code required" });
      return reply.send({ otpauth_uri: result.uri });
    });

    scoped.post("/auth/mfa/reset/confirm", async (req, reply) => {
      const { tenantId, userId } = req.consolePrincipal!;
      const body = req.body as { totp_code?: string };
      const ok = await withTenant(pool, tenantId, async (client) => {
        const user = await findUserById(client, userId);
        if (!user?.pending_mfa_secret || !body.totp_code || !verifyCode(user.pending_mfa_secret, user.email, body.totp_code)) {
          return false;
        }
        await client.query(`UPDATE users SET mfa_secret = pending_mfa_secret, pending_mfa_secret = NULL WHERE id = $1`, [userId]);
        return true;
      });
      if (!ok) return reply.code(401).send({ error: "invalid authentication code" });
      await writeAuditEvent(pool, tenantId, userId, "mfa_method_changed", {});
      return reply.send({});
    });

    // TEID-91-T9: mandatory-role accounts can never disable MFA, and every
    // other account needs a fresh MFA code (step-up) to do so -- a session
    // established with only a password is not enough on its own.
    scoped.post("/auth/mfa/disable", async (req, reply) => {
      const { tenantId, userId, role } = req.consolePrincipal!;
      if (MANDATORY_MFA_ROLES.has(role)) {
        return reply.code(403).send({ error: "MFA is mandatory for this role and cannot be disabled" });
      }
      const body = req.body as { totp_code?: string };
      const ok = await withTenant(pool, tenantId, async (client) => {
        const user = await findUserById(client, userId);
        if (!user?.mfa_secret) return false;
        if (!body.totp_code || !verifyCode(user.mfa_secret, user.email, body.totp_code)) return false;
        await client.query(`UPDATE users SET mfa_secret = NULL, mfa_enrolled_at = NULL WHERE id = $1`, [userId]);
        return true;
      });
      if (!ok) return reply.code(401).send({ error: "current authentication code required" });
      await writeAuditEvent(pool, tenantId, userId, "mfa_disabled", {});
      return reply.send({});
    });

    scoped.post("/auth/logout", async (req, reply) => {
      await deleteSession(pool, req.consolePrincipal!.sessionId);
      return reply.send({});
    });
  });
}

function toLoginResponse(result: Awaited<ReturnType<typeof completePrimaryFactor>>) {
  if (result.status === "authenticated") return { status: result.status, session_token: result.sessionToken };
  if (result.status === "mfa_required") return { status: result.status, pending_token: result.pendingToken };
  return { status: result.status, pending_token: result.pendingToken, otpauth_uri: result.otpauthUri };
}
