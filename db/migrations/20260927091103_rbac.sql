-- TEID-43: account-level SSO toggle and user lifecycle permissions.
ALTER TABLE tenant_settings ADD COLUMN sso_enabled BOOLEAN NOT NULL DEFAULT true;

GRANT DELETE ON users TO teideal_app;
