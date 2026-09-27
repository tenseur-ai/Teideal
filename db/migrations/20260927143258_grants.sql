-- TEID-17: issue credit grants with expiry.
-- Grants are the only way credits enter a customer's balance. Every grant
-- is traceable through grant_ledger_entries. Recurring issuance is
-- idempotent per template and UTC period via grants_recurring_period_unique.

CREATE TABLE IF NOT EXISTS recurring_grant_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paid', 'promotional', 'commit', 'goodwill')),
  interval TEXT NOT NULL CHECK (interval IN ('monthly')),
  created_by_user_id UUID REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE recurring_grant_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_grant_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_recurring_grant_templates ON recurring_grant_templates;
CREATE POLICY tenant_isolation_recurring_grant_templates ON recurring_grant_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON recurring_grant_templates TO teideal_app;

CREATE TABLE IF NOT EXISTS grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  remaining_amount NUMERIC NOT NULL CHECK (remaining_amount >= 0),
  unit TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paid', 'promotional', 'commit', 'goodwill')),
  start_date TIMESTAMPTZ NOT NULL,
  expiry_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'void')),
  created_by_user_id UUID REFERENCES users(id),
  recurring_template_id UUID REFERENCES recurring_grant_templates(id),
  period_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS grants_recurring_period_unique
  ON grants (recurring_template_id, period_key) WHERE recurring_template_id IS NOT NULL;
ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_grants ON grants;
CREATE POLICY tenant_isolation_grants ON grants
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON grants TO teideal_app;

CREATE TABLE IF NOT EXISTS grant_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('issued', 'expired', 'voided')),
  amount NUMERIC NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE grant_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_ledger_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_grant_ledger_entries ON grant_ledger_entries;
CREATE POLICY tenant_isolation_grant_ledger_entries ON grant_ledger_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only, matching audit_log's own precedent: no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON grant_ledger_entries TO teideal_app;
