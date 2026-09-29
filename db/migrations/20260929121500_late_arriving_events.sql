-- TEID-34: late-arriving usage is reviewed without silently changing a
-- closed billing period.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS is_prior_period_adjustment BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customer_billing_config
  ADD COLUMN IF NOT EXISTS auto_approve_adjustment_threshold NUMERIC
    CHECK (
      auto_approve_adjustment_threshold IS NULL OR
      (auto_approve_adjustment_threshold >= 0 AND auto_approve_adjustment_threshold <= 1000000)
    );

CREATE TABLE IF NOT EXISTS usage_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  auto_approved BOOLEAN NOT NULL DEFAULT false,
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  resulting_usage_event_id UUID REFERENCES usage_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE usage_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_adjustments ON usage_adjustments;
CREATE POLICY tenant_isolation_usage_adjustments ON usage_adjustments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON usage_adjustments TO teideal_app;
