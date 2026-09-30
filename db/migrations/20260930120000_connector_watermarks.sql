ALTER TABLE connectors ADD COLUMN cursor_high_water JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN connectors.cursor_high_water IS
  'Map of entity name -> {since, cursor}, advanced only on a successful completeSync call. Never used for Stripe Connect (TEID-37); that flow''s own OAuth state lives entirely in stripe_connections.';

COMMENT ON COLUMN connectors.credential_ciphertext IS
  'For API-key-style connectors (csv_mock now; Metronome/Orb/Lago later). Stripe Connect OAuth tokens for Verify (TEID-65) MUST continue to live in stripe_connections, encrypted under STRIPE_TOKEN_ENCRYPTION_KEY -- never copy an OAuth refresh/access token into this column.';

-- A tenant may later have multiple accounts of the same connector type, so
-- display_name, rather than connector_type alone, completes the unique key.
ALTER TABLE connectors ADD CONSTRAINT connectors_tenant_type_name_uniq
  UNIQUE (tenant_id, connector_type, display_name);
