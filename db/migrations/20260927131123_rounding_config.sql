-- TEID-94: per-tenant, per-imported-billing-system rounding configuration.

CREATE TABLE IF NOT EXISTS rounding_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  imported_billing_system TEXT,
  rounding_method TEXT NOT NULL DEFAULT 'round_half_up'
    CHECK (rounding_method IN ('round_half_up', 'round_half_to_even')),
  rounding_point TEXT NOT NULL DEFAULT 'per_line'
    CHECK (rounding_point IN ('per_line', 'per_invoice', 'per_event')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, imported_billing_system)
);
CREATE UNIQUE INDEX IF NOT EXISTS rounding_configs_default_per_tenant
  ON rounding_configs (tenant_id) WHERE imported_billing_system IS NULL;

ALTER TABLE rounding_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounding_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rounding_configs ON rounding_configs;
CREATE POLICY tenant_isolation_rounding_configs ON rounding_configs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON rounding_configs TO teideal_app;
