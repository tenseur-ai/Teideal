-- TEID-47: balance threshold alerts.
-- Threshold config is per plan (every customer on that plan) or per customer
-- (overrides the plan for that customer only). scope_id is a plan_id or
-- customer_id depending on scope. The dedup table's UNIQUE constraint is
-- the enforcement mechanism for once-per-period, not a check-then-insert.

-- PostgreSQL rejects subqueries inside CHECK. The predicate below is the
-- spec's NOT EXISTS (unnest ...) condition, wrapped in an immutable
-- function so the constraint can call it. See NOTES-TEID-47.md.
CREATE OR REPLACE FUNCTION billing_alert_threshold_pcts_valid(pcts SMALLINT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(pcts) p WHERE p <= 0 OR p > 100);
$$;

CREATE TABLE IF NOT EXISTS billing_alert_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('plan', 'customer')),
  scope_id UUID NOT NULL,
  threshold_pcts SMALLINT[] NOT NULL DEFAULT '{50,80,100}',
  operator_emails TEXT[] NOT NULL DEFAULT '{}',
  slack_webhook_url TEXT,
  notify_customer BOOLEAN NOT NULL DEFAULT false,
  customer_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, scope_id)
);
ALTER TABLE billing_alert_thresholds DROP CONSTRAINT IF EXISTS billing_alert_thresholds_pcts_valid;
ALTER TABLE billing_alert_thresholds ADD CONSTRAINT billing_alert_thresholds_pcts_valid
  CHECK (billing_alert_threshold_pcts_valid(threshold_pcts));
ALTER TABLE billing_alert_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alert_thresholds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_billing_alert_thresholds ON billing_alert_thresholds;
CREATE POLICY tenant_isolation_billing_alert_thresholds ON billing_alert_thresholds
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON billing_alert_thresholds TO teideal_app;

CREATE TABLE IF NOT EXISTS billing_alert_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  grant_id UUID NOT NULL,
  threshold_pct SMALLINT NOT NULL,
  period_start DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status JSONB NOT NULL,
  UNIQUE (tenant_id, grant_id, threshold_pct, period_start)
);
ALTER TABLE billing_alert_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alert_sent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_billing_alert_sent ON billing_alert_sent;
CREATE POLICY tenant_isolation_billing_alert_sent ON billing_alert_sent
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON billing_alert_sent TO teideal_app;
CREATE INDEX IF NOT EXISTS billing_alert_sent_grant_period_idx
  ON billing_alert_sent (tenant_id, grant_id, period_start);
