-- TEID-18: configure credit consumption order.
-- plans.consumption_order is plan-level configuration. No customer-to-plan
-- assignment exists yet, so that column is stored and never resolved onto
-- a customer by this story.
-- usage_consumption_lines.grant_id is null for the overage remainder
-- (source_category = 'overage'). The usage tables are append-only.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS consumption_order TEXT[];

CREATE TABLE IF NOT EXISTS customer_consumption_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  consumption_order TEXT[] NOT NULL,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_consumption_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_consumption_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_consumption_overrides ON customer_consumption_overrides;
CREATE POLICY tenant_isolation_customer_consumption_overrides ON customer_consumption_overrides
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_consumption_overrides TO teideal_app;

CREATE TABLE IF NOT EXISTS usage_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  requested_amount NUMERIC NOT NULL CHECK (requested_amount > 0),
  unit TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usage_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_consumptions ON usage_consumptions;
CREATE POLICY tenant_isolation_usage_consumptions ON usage_consumptions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON usage_consumptions TO teideal_app;

CREATE TABLE IF NOT EXISTS usage_consumption_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumption_id UUID NOT NULL REFERENCES usage_consumptions(id) ON DELETE CASCADE,
  grant_id UUID REFERENCES grants(id),
  source_category TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0)
);
ALTER TABLE usage_consumption_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_consumption_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_consumption_lines ON usage_consumption_lines;
CREATE POLICY tenant_isolation_usage_consumption_lines ON usage_consumption_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON usage_consumption_lines TO teideal_app;
