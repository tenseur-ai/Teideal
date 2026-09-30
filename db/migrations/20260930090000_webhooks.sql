CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  subscribed_events TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_endpoints ON webhook_endpoints
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO teideal_app;

-- One row per logical occurrence. The unique dedup key is the atomic
-- claim-before-deliver boundary; raw_body is signed and resent verbatim.
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'threshold.reached', 'balance.depleted', 'grant.expiring_soon',
    'grant.expired', 'reservation.overrun', 'reconciliation.mismatch',
    'customer.suspended'
  )),
  dedup_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  raw_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedup_key)
);
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_events ON webhook_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON webhook_events TO teideal_app;
CREATE INDEX webhook_events_tenant_type_idx ON webhook_events (tenant_id, event_type, created_at DESC);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  webhook_endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'exhausted')),
  attempt_count INT NOT NULL DEFAULT 0,
  first_attempted_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_http_status INT,
  last_response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_event_id, webhook_endpoint_id)
);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_deliveries ON webhook_deliveries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO teideal_app;
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (tenant_id, status, next_retry_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_tenant_status_idx ON webhook_deliveries (tenant_id, status);

CREATE TABLE webhook_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  http_status INT,
  response_body TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE webhook_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_delivery_attempts ON webhook_delivery_attempts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON webhook_delivery_attempts TO teideal_app;
CREATE INDEX webhook_delivery_attempts_delivery_idx ON webhook_delivery_attempts (webhook_delivery_id, attempt_number);
