-- TEID-39: period-close Stripe invoice sync attempt tracking and durable
-- line-item records. Owned by ts-console; reads ts-console consumption
-- ledger rows only.

CREATE TABLE period_close_invoice_sync_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);
ALTER TABLE period_close_invoice_sync_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_close_invoice_sync_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_period_close_invoice_sync_attempts ON period_close_invoice_sync_attempts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON period_close_invoice_sync_attempts TO teideal_app;
CREATE INDEX period_close_invoice_sync_attempts_period_idx
  ON period_close_invoice_sync_attempts (tenant_id, customer_id, period_start, period_end, started_at DESC);
CREATE INDEX period_close_invoice_sync_attempts_stalled_idx
  ON period_close_invoice_sync_attempts (status, started_at)
  WHERE status IN ('running', 'failed');

CREATE TABLE period_close_invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('usage','overage')),
  stripe_invoice_item_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  ledger_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, period_start, period_end, category)
);
ALTER TABLE period_close_invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_close_invoice_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_period_close_invoice_line_items ON period_close_invoice_line_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON period_close_invoice_line_items TO teideal_app;

ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_event_type_check
  CHECK (event_type IN (
    'threshold.reached', 'balance.depleted', 'grant.expiring_soon',
    'grant.expired', 'reservation.overrun', 'reconciliation.mismatch',
    'customer.suspended', 'period_close_sync.stalled'
  ));
