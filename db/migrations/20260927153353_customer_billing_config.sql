-- TEID-96: per-customer billing time zone and month-end anchor day.
-- Owned by go-usage (period/ledger computation is this epic's domain),
-- not services/ts-console, even though it references customers(id) --
-- the same cross-service FK pattern usage_events.customer_id already
-- established.

CREATE TABLE IF NOT EXISTS customer_billing_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  billing_timezone TEXT NOT NULL DEFAULT 'UTC',
  billing_anchor_day INT NOT NULL DEFAULT 1 CHECK (billing_anchor_day BETWEEN 1 AND 31),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_billing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_billing_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_billing_config ON customer_billing_config;
CREATE POLICY tenant_isolation_customer_billing_config ON customer_billing_config
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_billing_config TO teideal_app;

