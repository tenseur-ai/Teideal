-- TEID-22: organisations and teams are customers rows in one tree.
-- A root is always isolated. A pooled node resolves upward to the nearest
-- isolated ancestor for the debit. customer_hierarchy_moves records a
-- re-parent without touching grants or usage.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS parent_customer_id UUID REFERENCES customers(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS balance_mode TEXT NOT NULL DEFAULT 'isolated'
  CHECK (balance_mode IN ('pooled', 'isolated'));

-- A pooled node has no meaningful balance of its own. Roots cannot be pooled:
-- there is no ancestor to resolve them to.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_root_is_isolated'
  ) THEN
    ALTER TABLE customers ADD CONSTRAINT customers_root_is_isolated
      CHECK (parent_customer_id IS NOT NULL OR balance_mode = 'isolated');
  END IF;
END
$$;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

-- AC4: history of a team's moves between parents. Nothing here references
-- usage_events or grants -- the move never touches them.
CREATE TABLE IF NOT EXISTS customer_hierarchy_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  old_parent_customer_id UUID REFERENCES customers(id),
  new_parent_customer_id UUID REFERENCES customers(id),
  moved_by_user_id UUID REFERENCES users(id),
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_hierarchy_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_hierarchy_moves FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_hierarchy_moves ON customer_hierarchy_moves;
CREATE POLICY tenant_isolation_customer_hierarchy_moves ON customer_hierarchy_moves
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON customer_hierarchy_moves TO teideal_app;

CREATE INDEX IF NOT EXISTS customers_parent_customer_id_idx ON customers (parent_customer_id);

-- The ceiling check joins every ancestor to that node's grants in one
-- recursive query. grants has no customer_id index of its own; without this,
-- the join seq-scans grants on every check (TEID-22-T5).
CREATE INDEX IF NOT EXISTS grants_hierarchy_ceiling_idx
  ON grants (tenant_id, customer_id)
  WHERE status = 'active';
