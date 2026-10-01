-- TEID-66: typed billed-side facts derived from Stripe connector records.
CREATE TABLE verify_billed_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  stripe_invoice_line_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  quantity NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stripe_invoice_line_id)
);
ALTER TABLE verify_billed_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_billed_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_verify_billed_lines ON verify_billed_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON verify_billed_lines TO teideal_app;

CREATE TABLE verify_unmapped_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_customer_name TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connector_id, stripe_customer_id)
);
ALTER TABLE verify_unmapped_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_unmapped_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_verify_unmapped_customers ON verify_unmapped_customers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON verify_unmapped_customers TO teideal_app;
