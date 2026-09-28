-- TEID-32: a minimal reservation placeholder -- see specs/TEID-32.md's
-- scoping notes. Not the real E02 hold/reserve-then-settle system.
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  usage_event_id UUID REFERENCES usage_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_reservations ON reservations;
CREATE POLICY tenant_isolation_reservations ON reservations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON reservations TO teideal_app;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  usage_event_id UUID REFERENCES usage_events(id),
  grant_id UUID,              -- cross-service (ts-console), no FK -- see scoping notes
  reservation_id UUID REFERENCES reservations(id),
  pricing_rule_id UUID,       -- cross-service (plan_rates.id), no FK
  plan_version INT,           -- captured snapshot, not a live reference
  reverses_transaction_id UUID REFERENCES ledger_transactions(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ledger_transactions ON ledger_transactions;
CREATE POLICY tenant_isolation_ledger_transactions ON ledger_transactions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON ledger_transactions TO teideal_app;

CREATE TABLE IF NOT EXISTS ledger_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ledger_lines ON ledger_lines;
CREATE POLICY tenant_isolation_ledger_lines ON ledger_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON ledger_lines TO teideal_app;

-- Keeps the deferred per-row balance check local to the transaction it is
-- validating, even as the ledger grows to the T6 scale.
CREATE INDEX IF NOT EXISTS ledger_lines_transaction_id_idx
  ON ledger_lines (transaction_id);

-- AC1/T1/T7: this schema's first trigger-based immutability. Fires for
-- every role including a superuser -- the only mechanism in this
-- codebase's toolkit that isn't bypassed by BYPASSRLS/superuser status.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only and cannot be updated or deleted (attempted % on %.%)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER ledger_lines_immutable
  BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- AC3/T8: the real, unbypassable sum-to-zero guarantee. Deferred so it
-- checks the *whole* transaction's lines at commit, not row-by-row
-- during insert (which would reject the first line of every valid
-- transaction, since no single line sums to zero on its own).
CREATE OR REPLACE FUNCTION check_ledger_balance() RETURNS TRIGGER AS $$
DECLARE
  imbalance NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
    INTO imbalance
    FROM ledger_lines
    WHERE transaction_id = NEW.transaction_id;
  IF imbalance != 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (net %)', NEW.transaction_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_lines_balance
  AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
