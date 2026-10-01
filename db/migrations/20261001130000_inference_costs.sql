-- TEID-51: Record inference costs
-- Adds optional `model` and `actual_cost` columns to `usage_events` (owned by go-usage),
-- and creates the `cost_rates` table (owned by ts-console).

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS actual_cost NUMERIC CHECK (actual_cost IS NULL OR (actual_cost >= 0 AND actual_cost < 1000000));

CREATE TABLE IF NOT EXISTS cost_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  metric TEXT NOT NULL,
  rate_per_unit NUMERIC NOT NULL CHECK (rate_per_unit >= 0),
  unit_size INT NOT NULL DEFAULT 1 CHECK (unit_size > 0),
  effective_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model, metric, effective_from)
);

ALTER TABLE cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cost_rates_tenant_isolation ON cost_rates;
CREATE POLICY cost_rates_tenant_isolation ON cost_rates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON cost_rates TO teideal_app;

CREATE INDEX IF NOT EXISTS cost_rates_lookup_idx
  ON cost_rates (tenant_id, model, metric, effective_from DESC);
