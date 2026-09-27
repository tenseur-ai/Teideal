-- TEID-92: API key lifecycle, scoping, rotation, and revocation.
ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin'
    CHECK (scope IN ('ingest-only', 'read-only', 'admin')),
  ADD COLUMN environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  ADD COLUMN display_hint TEXT NOT NULL DEFAULT '',
  ADD COLUMN creator_user_id UUID REFERENCES users(id),
  ADD COLUMN last_used_at TIMESTAMPTZ,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN revoked_at TIMESTAMPTZ;

ALTER TABLE api_keys ALTER COLUMN scope DROP DEFAULT;
ALTER TABLE api_keys ALTER COLUMN environment DROP DEFAULT;

GRANT INSERT, UPDATE ON api_keys TO teideal_app;
