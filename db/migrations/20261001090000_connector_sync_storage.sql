-- TEID-65: generic landing storage for read-only billing connector data.
CREATE TABLE connector_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'customer', 'price', 'contract', 'invoice', 'credit', 'payment', 'refund'
  )),
  external_id TEXT NOT NULL,
  data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, entity_type, external_id)
);
ALTER TABLE connector_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_connector_records ON connector_records
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON connector_records TO teideal_app;
CREATE INDEX connector_records_connector_entity_idx ON connector_records (connector_id, entity_type);

ALTER TABLE connectors ADD COLUMN backfill_completed_at TIMESTAMPTZ;
ALTER TABLE connectors ADD COLUMN stripe_connection_id UUID REFERENCES stripe_connections(id);

CREATE TABLE csv_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  total_rows INT NOT NULL,
  accepted_rows INT NOT NULL,
  quarantined_rows INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE csv_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_csv_imports ON csv_imports
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON csv_imports TO teideal_app;

CREATE TABLE csv_import_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_id UUID NOT NULL REFERENCES csv_imports(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  raw_row JSONB NOT NULL,
  reason TEXT NOT NULL
);
ALTER TABLE csv_import_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_import_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_csv_import_quarantine ON csv_import_quarantine
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON csv_import_quarantine TO teideal_app;

COMMENT ON COLUMN connectors.cursor_high_water IS
  'Map of entity name -> {since, cursor}. TEID-65 connector workers checkpoint each successfully persisted page immediately; sync status still changes only through completeSync.';
