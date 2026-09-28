-- TEID-20: a customer-scoped rate override for one metric/model, with a
-- validity window. AC1's "any metric or model" -- model is nullable
-- (a metric-wide override), matching plan_rates' own metric/model shape.
CREATE TABLE IF NOT EXISTS customer_rate_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  metric TEXT NOT NULL,
  model TEXT,
  rate NUMERIC NOT NULL CHECK (rate >= 0),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date > start_date)
);
ALTER TABLE customer_rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rate_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_rate_overrides ON customer_rate_overrides;
CREATE POLICY tenant_isolation_customer_rate_overrides ON customer_rate_overrides
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON customer_rate_overrides TO teideal_app;

-- AC3's "ledger": one row per priced usage line, recording which override
-- (if any) applied. Deliberately separate from usage_consumption_lines
-- (a credit-consumption concept with no metric/model dimension) -- see
-- specs/TEID-20.md's scoping notes.
CREATE TABLE IF NOT EXISTS priced_usage_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  plan_id UUID NOT NULL REFERENCES plans(id),
  metric TEXT NOT NULL,
  model TEXT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  rate_applied NUMERIC NOT NULL CHECK (rate_applied >= 0),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  rate_override_id UUID REFERENCES customer_rate_overrides(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE priced_usage_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE priced_usage_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_priced_usage_lines ON priced_usage_lines;
CREATE POLICY tenant_isolation_priced_usage_lines ON priced_usage_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only, matching grant_ledger_entries'/audit_log's own precedent.
GRANT SELECT, INSERT ON priced_usage_lines TO teideal_app;
