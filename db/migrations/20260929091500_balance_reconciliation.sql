CREATE TABLE IF NOT EXISTS customer_balance_cache (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_code TEXT NOT NULL,
  cached_balance NUMERIC NOT NULL DEFAULT 0,
  last_recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id, account_code)
);
ALTER TABLE customer_balance_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_balance_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_balance_cache ON customer_balance_cache;
CREATE POLICY tenant_isolation_customer_balance_cache ON customer_balance_cache
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_balance_cache TO teideal_app;

-- Append-only review log. Routine all-clear comparisons are intentionally not
-- retained: only a real cache-versus-ledger mismatch creates a row.
CREATE TABLE IF NOT EXISTS balance_integrity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_code TEXT NOT NULL,
  cached_balance NUMERIC NOT NULL,
  recalculated_balance NUMERIC NOT NULL,
  discrepancy NUMERIC NOT NULL,
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE balance_integrity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_integrity_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_balance_integrity_checks ON balance_integrity_checks;
CREATE POLICY tenant_isolation_balance_integrity_checks ON balance_integrity_checks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON balance_integrity_checks TO teideal_app;
