-- TEID-31 AC3: a repeated idempotency key whose content (excluding
-- occurred_at -- see specs/TEID-31.md's scoping notes on TEID-96-T8)
-- differs from the original is rejected and recorded here for an
-- operator's review, rather than silently treated as a duplicate.
CREATE TABLE IF NOT EXISTS idempotency_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- Nullable + SET NULL, not CASCADE: this table is append-only (a review
  -- record must survive even after the key it flagged is later legitimately
  -- reused past the retention floor and its original row is deleted --
  -- CASCADE would silently erase review history, contradicting the
  -- append-only intent this table exists for).
  existing_usage_event_id UUID REFERENCES usage_events(id) ON DELETE SET NULL,
  attempted_customer_id UUID,
  attempted_event_type TEXT,
  attempted_quantity NUMERIC,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE idempotency_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_idempotency_conflicts ON idempotency_conflicts;
CREATE POLICY tenant_isolation_idempotency_conflicts ON idempotency_conflicts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only: a conflict record is never edited or removed by the app.
GRANT SELECT, INSERT ON idempotency_conflicts TO teideal_app;

-- Expired-key reuse deletes exactly the one conflicting usage row. The
-- initial schema did not grant that operation to the runtime role.
GRANT DELETE ON usage_events TO teideal_app;
