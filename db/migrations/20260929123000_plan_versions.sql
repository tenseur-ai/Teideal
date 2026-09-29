-- TEID-23: a plan version is a new plans row sharing plan_family_id.
-- The first row of a family uses its own id as plan_family_id. Later
-- versions set plan_family_id explicitly to that family. Existing INSERT
-- statements (POST /plans and test fixtures) do not name the column, so a
-- BEFORE INSERT trigger fills it when it is omitted. A column DEFAULT
-- cannot reference id.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_family_id UUID;
UPDATE plans SET plan_family_id = id WHERE plan_family_id IS NULL;
ALTER TABLE plans ALTER COLUMN plan_family_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plans_family_version_uniq
  ON plans (plan_family_id, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS plans_plan_family_id_idx ON plans (plan_family_id);

CREATE OR REPLACE FUNCTION plans_set_plan_family_id() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.plan_family_id IS NULL THEN
    NEW.plan_family_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plans_set_plan_family_id ON plans;
CREATE TRIGGER plans_set_plan_family_id
  BEFORE INSERT ON plans
  FOR EACH ROW EXECUTE FUNCTION plans_set_plan_family_id();

CREATE TABLE IF NOT EXISTS customer_plan_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id),
  plan_family_id UUID NOT NULL,
  current_plan_id UUID NOT NULL REFERENCES plans(id),
  grandfathered BOOLEAN NOT NULL DEFAULT false,
  scheduled_plan_id UUID REFERENCES plans(id),
  scheduled_migration_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scheduled_plan_id IS NULL) = (scheduled_migration_date IS NULL)),
  CHECK (NOT (grandfathered AND scheduled_plan_id IS NOT NULL))
);
ALTER TABLE customer_plan_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_plan_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_plan_subscriptions ON customer_plan_subscriptions;
CREATE POLICY tenant_isolation_customer_plan_subscriptions ON customer_plan_subscriptions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_plan_subscriptions TO teideal_app;

-- previewMigration groups by this column. T6 times that aggregate at 25k rows.
CREATE INDEX IF NOT EXISTS customer_plan_subscriptions_scheduled_plan_id_idx
  ON customer_plan_subscriptions (scheduled_plan_id);
