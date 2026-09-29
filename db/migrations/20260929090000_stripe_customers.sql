-- TEID-38: link Teideal customers to Stripe customers, and queue uncertain
-- matches for operator review. A Teideal customer can only ever have one
-- Stripe link (UNIQUE on customer_id). The reverse is intentionally not unique.
CREATE TABLE IF NOT EXISTS stripe_customer_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id),
  stripe_customer_id TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('stripe_id', 'email', 'manual_create_in_stripe', 'manual_create_in_teideal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stripe_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customer_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_customer_links ON stripe_customer_links;
CREATE POLICY tenant_isolation_stripe_customer_links ON stripe_customer_links
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- AC3: a customer_id can only ever have one row (UNIQUE above). A
-- stripe_customer_id is intentionally NOT unique here -- nothing in this
-- story requires the reverse (one Stripe customer could, in principle,
-- be re-synced after a Teideal-side merge/rename; that is out of scope).
GRANT SELECT, INSERT ON stripe_customer_links TO teideal_app;

CREATE TABLE IF NOT EXISTS stripe_customer_match_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_name TEXT,
  stripe_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE stripe_customer_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customer_match_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_customer_match_candidates ON stripe_customer_match_candidates;
CREATE POLICY tenant_isolation_stripe_customer_match_candidates ON stripe_customer_match_candidates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON stripe_customer_match_candidates TO teideal_app;

-- Endpoint design: upsert pending candidates with
-- ON CONFLICT (tenant_id, stripe_customer_id) WHERE status = 'pending'.
CREATE UNIQUE INDEX IF NOT EXISTS stripe_customer_match_candidates_pending_uniq
  ON stripe_customer_match_candidates (tenant_id, stripe_customer_id)
  WHERE status = 'pending';
