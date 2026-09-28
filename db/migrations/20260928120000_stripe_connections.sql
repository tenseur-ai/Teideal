-- TEID-37: a tenant's Stripe Connect link. The access token is recoverable
-- (AES-256-GCM ciphertext + iv + auth tag) because Teideal must present the
-- exact token back to Stripe. Card and bank fields are intentionally absent.
CREATE TABLE IF NOT EXISTS stripe_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_auth_tag TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read_only', 'read_write')),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_by_user_id UUID REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ
);
ALTER TABLE stripe_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_connections ON stripe_connections;
CREATE POLICY tenant_isolation_stripe_connections ON stripe_connections
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON stripe_connections TO teideal_app;
