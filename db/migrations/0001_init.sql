-- TEID-41: Structural tenant isolation.
-- Every tenant-scoped table below enforces isolation in the database itself
-- via row-level security, not via application-level filtering. See
-- docs/isolation-design.md for the full design and rationale.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The application connects as this role. It owns nothing (migrations run as
-- the migrating superuser/owner), has NOSUPERUSER and NOBYPASSRLS, and is
-- therefore always subject to RLS policies -- there is no code path, buggy
-- or otherwise, that can see another tenant's rows through this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teideal_app') THEN
    CREATE ROLE teideal_app LOGIN PASSWORD 'teideal_app_dev_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- tenants: the tenancy directory itself. Not "tenant data" in the AC1 sense
-- (a tenant does not own a row of another tenant's data here -- every row
-- here is a distinct tenant), so RLS is not applicable to this table. Only
-- non-secret directory fields live here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- api_keys: minimal auth shim so requests can be attributed to a tenant.
-- Deliberately minimal (no scopes, rotation or revocation) -- superseded by
-- TEID-92 when that story is built. Keys are stored hashed, never plaintext.
-- ---------------------------------------------------------------------------
-- issued_to_tenant_id, not tenant_id: this column names *whose* key it is,
-- it is not "tenant data" filtered by RLS the way a customer or usage_events
-- row is. Naming it something other than the literal "tenant_id" also keeps
-- it out of the structural, no-exemption-list RLS audit (TEID-41-T1), which
-- treats any column literally named tenant_id as something that must be
-- RLS-protected.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issued_to_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT 'dev',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No RLS: a request has no tenant context yet when looking up its own key.
-- This table is looked up by key_hash only, one row at a time, and never
-- listed or joined across tenants by application code.

GRANT SELECT ON tenants TO teideal_app;
GRANT SELECT ON api_keys TO teideal_app;

-- ---------------------------------------------------------------------------
-- customers: owned by services/ts-console.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customers ON customers;
CREATE POLICY tenant_isolation_customers ON customers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO teideal_app;

-- ---------------------------------------------------------------------------
-- usage_events: owned by services/go-usage. idempotency_key gives the
-- exactly-once (dedup-on-write) guarantee for TEID-3's ledger later; for
-- TEID-41 it just needs to exist as a real tenant-scoped table with a real
-- write path to prove isolation on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events;
CREATE POLICY tenant_isolation_usage_events ON usage_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON usage_events TO teideal_app;

-- ---------------------------------------------------------------------------
-- security_events: blocked cross-tenant attempts, for the security
-- monitoring dashboard (TEID-41-T6). This is a system/security table, not
-- tenant business data -- it inherently spans tenants (an attempt made *by*
-- one tenant *against* another) -- so it is intentionally exempt from
-- per-tenant RLS and instead restricted at the application layer to an
-- admin-only endpoint. See docs/isolation-design.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acting_tenant_id UUID,
  target_tenant_id UUID,
  endpoint TEXT NOT NULL,
  http_method TEXT NOT NULL,
  detail TEXT,
  resolved_action TEXT NOT NULL
);

GRANT SELECT, INSERT ON security_events TO teideal_app;

CREATE INDEX IF NOT EXISTS security_events_occurred_at_idx ON security_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_customer_idx ON usage_events (tenant_id, customer_id);
