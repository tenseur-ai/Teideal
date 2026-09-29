-- TEID-60: a sandbox is a distinct tenant row so all existing tenant RLS
-- policies isolate sandbox data without environment columns on domain tables.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'production'
  CHECK (kind IN ('production', 'sandbox'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_sandbox_has_parent'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_sandbox_has_parent
      CHECK (kind = 'production' OR parent_tenant_id IS NOT NULL);
  END IF;
END
$$;

-- A production tenant has at most one sandbox (AC1's "a sandbox", singular).
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_sandbox_per_parent
  ON tenants (parent_tenant_id) WHERE kind = 'sandbox';

-- The console application creates only sandbox children; tenants remains the
-- non-RLS tenancy directory described by the initial schema migration.
-- UPDATE is required too: SELECT ... FOR UPDATE (locking the parent row
-- while creating its sandbox, serializing concurrent creation attempts
-- ahead of the unique-index backstop above) needs Postgres's UPDATE
-- privilege, not just SELECT -- confirmed directly against a live
-- Postgres 16 instance, not assumed.
GRANT INSERT, UPDATE ON tenants TO teideal_app;

-- AC3: reviewed plan copies from a sandbox into its production parent.
CREATE TABLE IF NOT EXISTS sandbox_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  production_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_plan_id UUID NOT NULL,
  created_plan_id UUID NOT NULL REFERENCES plans(id),
  promoted_by_user_id UUID REFERENCES users(id),
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sandbox_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_promotions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_promotions ON sandbox_promotions;
CREATE POLICY tenant_isolation_sandbox_promotions ON sandbox_promotions
  USING (production_tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (production_tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON sandbox_promotions TO teideal_app;
