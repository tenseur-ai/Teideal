-- TEID-50: support tenant-wide calendar-month period close aggregation.
CREATE INDEX IF NOT EXISTS usage_consumptions_tenant_occurred_idx
  ON usage_consumptions (tenant_id, occurred_at);

CREATE INDEX IF NOT EXISTS grant_ledger_entries_tenant_occurred_idx
  ON grant_ledger_entries (tenant_id, occurred_at) WHERE entry_type = 'expired';
