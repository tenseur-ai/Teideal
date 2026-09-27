-- TEID-91: Console sign-in with multi-factor authentication.
--
-- Tables split into the same two categories TEID-41 established:
--   * real tenant data (RLS ENABLE+FORCE+policy): users, tenant_settings,
--     audit_log, notifications_sent.
--   * pre-auth resolution tables (no RLS, looked up by an opaque credential
--     before a tenant context exists -- same category as api_keys):
--     sessions, pending_logins. Their tenant-linkage column is named
--     issued_to_tenant_id, not tenant_id, both to say what it means (whose
--     credential this is, not "this row is that tenant's protected data")
--     and to keep TEID-41-T1's structural RLS audit (which treats any
--     column literally named tenant_id as something that must be
--     RLS-protected) honest rather than needing a hand-maintained
--     exemption list.

-- ---------------------------------------------------------------------------
-- users: owned by services/ts-console. Real tenant data -- password
-- hashes and MFA secrets are exactly what RLS exists to protect. Login
-- resolves the tenant from the public tenant_key (via the already-exempt
-- tenants table) *before* querying users, so this table is only ever
-- reached from inside an already tenant-scoped transaction -- see
-- services/ts-console/src/lib/sessions.ts and routes/auth.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT,
  google_subject TEXT,
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Billing Admin', 'Finance', 'Support', 'Developer')),
  mfa_secret TEXT,
  pending_mfa_secret TEXT,
  mfa_enrolled_at TIMESTAMPTZ,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_users ON users;
CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON users TO teideal_app;

-- ---------------------------------------------------------------------------
-- tenant_settings: one row per tenant, but -- unlike tenants itself --
-- genuinely tenant data (AC3's idle timeout, AC2's require-MFA-for-everyone
-- toggle), so it gets ordinary RLS rather than living as columns on the
-- exempt tenants table. This is what actually keeps a bug in the
-- settings-update endpoint from letting one tenant touch another's
-- settings: RLS enforces it even if the endpoint forgot a WHERE clause.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  require_mfa_all_roles BOOLEAN NOT NULL DEFAULT false,
  idle_timeout_minutes INT NOT NULL DEFAULT 480,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_settings ON tenant_settings;
CREATE POLICY tenant_isolation_tenant_settings ON tenant_settings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON tenant_settings TO teideal_app;

INSERT INTO tenant_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- audit_log: minimal shape for what TEID-91-AC5 needs (sign-ins, failed
-- attempts, MFA changes, lockouts). TEID-42 (build order 3) will extend
-- this same table for general config-change auditing (object/before/after,
-- CSV export, filtering) rather than duplicating it. Append-only from the
-- start, ahead of TEID-42 formally requiring it -- an audit log should
-- never be mutable even in its minimal form.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,
  event_type TEXT NOT NULL,
  detail JSONB
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit_log ON audit_log;
CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON audit_log TO teideal_app;
REVOKE UPDATE, DELETE ON audit_log FROM teideal_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO teideal_app;

CREATE INDEX IF NOT EXISTS audit_log_tenant_occurred_idx ON audit_log (tenant_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- notifications_sent: placeholder for a real email provider (mirrors how
-- the Stripe connector is meant to be pluggable per the architecture ADR).
-- Real tenant data -- who got emailed what -- so it is RLS-protected like
-- any other tenant-owned record, not treated as a system table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notifications_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_sent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_notifications_sent ON notifications_sent;
CREATE POLICY tenant_isolation_notifications_sent ON notifications_sent
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON notifications_sent TO teideal_app;

-- ---------------------------------------------------------------------------
-- sessions: pre-auth resolution table (see header). Holds only a token
-- hash and linkage/timestamps -- no secrets -- looked up by token_hash
-- before a tenant context exists, exactly like api_keys.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issued_to_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  idle_timeout_minutes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO teideal_app;
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen_at);

-- ---------------------------------------------------------------------------
-- pending_logins: the short-lived state between a successful primary
-- factor (password/Google) and a completed MFA step. Pre-auth resolution
-- table, same category as sessions/api_keys.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_logins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issued_to_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'enroll')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
GRANT SELECT, INSERT, DELETE ON pending_logins TO teideal_app;
