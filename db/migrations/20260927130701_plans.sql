-- TEID-16: define plans as configuration.
-- A saved plan stays a draft until POST /plans/:id/publish records version 1.

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  included_credits NUMERIC NOT NULL DEFAULT 0 CHECK (included_credits >= 0),
  hard_cap NUMERIC CHECK (hard_cap IS NULL OR hard_cap >= 0),
  soft_cap NUMERIC CHECK (soft_cap IS NULL OR soft_cap >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  version INT,
  created_by_user_id UUID REFERENCES users(id),
  published_by_user_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_plans ON plans;
CREATE POLICY tenant_isolation_plans ON plans
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON plans TO teideal_app;

CREATE TABLE IF NOT EXISTS plan_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  model TEXT,
  rate NUMERIC NOT NULL CHECK (rate >= 0),
  UNIQUE (plan_id, metric, model)
);
ALTER TABLE plan_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_plan_rates ON plan_rates;
CREATE POLICY tenant_isolation_plan_rates ON plan_rates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_rates TO teideal_app;
