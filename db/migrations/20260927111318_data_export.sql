-- TEID-44: full tenant data exports and daily S3 export schedules.

CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by_user_id UUID REFERENCES users(id),
  range_start TIMESTAMPTZ,
  range_end TIMESTAMPTZ,
  formats TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  record_counts JSONB,
  file_paths JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_exports ON exports;
CREATE POLICY tenant_isolation_exports ON exports
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON exports TO teideal_app;

CREATE TABLE IF NOT EXISTS export_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES users(id),
  s3_bucket TEXT NOT NULL,
  s3_prefix TEXT NOT NULL DEFAULT '',
  s3_region TEXT NOT NULL,
  role_arn TEXT NOT NULL,
  formats TEXT[] NOT NULL DEFAULT ARRAY['csv'],
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (last_run_status IN ('succeeded', 'failed')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE export_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_export_schedules ON export_schedules;
CREATE POLICY tenant_isolation_export_schedules ON export_schedules
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON export_schedules TO teideal_app;
