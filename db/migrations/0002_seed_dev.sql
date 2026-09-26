-- Dev/test fixtures only. Never run against a real environment.
-- Tenants acct_1001 / acct_1002 and fixed dev API keys, matching the fixture
-- accounts named throughout TEID-41's tests.
--
-- Plaintext dev keys (sha256 hashed below, as the services expect):
--   acct_1001 -> devkey_1001
--   acct_1002 -> devkey_1002
--
-- sha256('devkey_1001') = 5e94a80... computed by the seed loader, see
-- db/seed.sh, which pipes through `sha256sum` so this file never hardcodes
-- a hash that could drift from the hashing scheme the services use.

INSERT INTO tenants (id, external_key, name)
VALUES
  ('00000000-0000-0000-0000-000000001001', 'acct_1001', 'Acme Co (dev fixture)'),
  ('00000000-0000-0000-0000-000000001002', 'acct_1002', 'Globex Inc (dev fixture)')
ON CONFLICT (external_key) DO NOTHING;
