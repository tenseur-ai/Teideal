#!/usr/bin/env bash
# Seeds the two dev-fixture tenants (acct_1001/acct_1002, already inserted by
# migration 0002) with API keys and one customer each, then writes the
# resulting IDs to tests/cross-tenant/.fixtures.json for the test suite.
# Seeding runs with admin/superuser privileges (like a migration) -- this is
# test infrastructure, not something the teideal_app runtime role does.
set -euo pipefail

PSQL_SUPERUSER="${PSQL_SUPERUSER:-postgres}"
DB_NAME="${DB_NAME:-teideal}"
OUT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../tests/cross-tenant" && pwd)/.fixtures.json"

run_psql() {
  # -q suppresses the "INSERT 0 1" command-tag footer that would otherwise
  # get glued onto -tA's single-value output when a statement has RETURNING.
  if [ "${CI:-}" = "true" ]; then
    PGPASSWORD="${PGPASSWORD:-postgres}" psql -h 127.0.0.1 -U "$PSQL_SUPERUSER" -d "$DB_NAME" -tAq "$@"
  else
    sudo -u "$PSQL_SUPERUSER" psql -d "$DB_NAME" -tAq "$@"
  fi
}

TENANT1_ID="00000000-0000-0000-0000-000000001001"
TENANT2_ID="00000000-0000-0000-0000-000000001002"
KEY1_PLAINTEXT="devkey_1001"
KEY2_PLAINTEXT="devkey_1002"
KEY1_HASH="$(printf '%s' "$KEY1_PLAINTEXT" | sha256sum | cut -d' ' -f1)"
KEY2_HASH="$(printf '%s' "$KEY2_PLAINTEXT" | sha256sum | cut -d' ' -f1)"

# Idempotent: delete-then-insert is fine for dev/test fixture data (never
# run against a real environment -- see the warning at the top of
# the *_seed_dev.sql migration).
run_psql -c "DELETE FROM api_keys WHERE key_hash IN ('${KEY1_HASH}', '${KEY2_HASH}');"
run_psql -c "
INSERT INTO api_keys (issued_to_tenant_id, key_hash, label, scope, environment) VALUES
  ('${TENANT1_ID}', '${KEY1_HASH}', 'test-fixture', 'admin', 'sandbox'),
  ('${TENANT2_ID}', '${KEY2_HASH}', 'test-fixture', 'admin', 'sandbox');
"

# Fixed customer IDs (rather than delete-then-insert) so re-running this
# script doesn't hit a foreign-key error against usage_events the test
# suite already wrote against a previous run's customer row.
CUSTOMER1_ID="00000000-0000-0000-0000-0000000c1001"
CUSTOMER2_ID="00000000-0000-0000-0000-0000000c1002"
run_psql -c "
INSERT INTO customers (id, tenant_id, name, email) VALUES ('${CUSTOMER1_ID}', '${TENANT1_ID}', 'Fixture Customer 1001', 'customer@acct1001.test')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email;
"
run_psql -c "
INSERT INTO customers (id, tenant_id, name, email) VALUES ('${CUSTOMER2_ID}', '${TENANT2_ID}', 'Fixture Customer 1002', 'customer@acct1002.test')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email;
"

cat > "$OUT_FILE" <<JSON
{
  "tenant1": {"id": "${TENANT1_ID}", "externalKey": "acct_1001", "apiKey": "${KEY1_PLAINTEXT}", "customerId": "${CUSTOMER1_ID}"},
  "tenant2": {"id": "${TENANT2_ID}", "externalKey": "acct_1002", "apiKey": "${KEY2_PLAINTEXT}", "customerId": "${CUSTOMER2_ID}"}
}
JSON

echo "wrote fixtures to $OUT_FILE"
cat "$OUT_FILE"
