#!/usr/bin/env bash
# Seeds TEID-91's fixture users under tenant acct_1001 (the same tenant
# migration 0002 creates). Password hashes are produced by pgcrypto's
# crypt()/gen_salt('bf') -- already enabled by migration 0001 -- which
# emits standard bcrypt hashes that services/ts-console's bcryptjs verifies
# directly, so no Node dependency is needed in this seed script.
set -euo pipefail

PSQL_SUPERUSER="${PSQL_SUPERUSER:-postgres}"
DB_NAME="${DB_NAME:-teideal}"

run_psql() {
  if [ "${CI:-}" = "true" ]; then
    PGPASSWORD="${PGPASSWORD:-postgres}" psql -h 127.0.0.1 -U "$PSQL_SUPERUSER" -d "$DB_NAME" -tAq "$@"
  else
    sudo -u "$PSQL_SUPERUSER" psql -d "$DB_NAME" -tAq "$@"
  fi
}

TENANT1_ID="00000000-0000-0000-0000-000000001001"

# Fixed dev/test-only secrets -- not used anywhere real. Owner and Billing
# Admin are pre-enrolled (mandatory MFA, TEID-91-AC2), Support and Finance
# are not (optional).
OWNER_MFA_SECRET="JBSWY3DPEHPK3PXP"
BILLING_MFA_SECRET="KRSXG5CTMVRXEZLU"

run_psql -c "
INSERT INTO users (id, tenant_id, email, password_hash, role, mfa_secret, mfa_enrolled_at)
VALUES
  ('00000000-0000-0000-0000-0000a0001001', '${TENANT1_ID}', 'owner@acmeco.com',
   crypt('OwnerPass123!', gen_salt('bf')), 'Owner', '${OWNER_MFA_SECRET}', now()),
  ('00000000-0000-0000-0000-0000a0001002', '${TENANT1_ID}', 'billing@acmeco.com',
   crypt('BillingPass123!', gen_salt('bf')), 'Billing Admin', '${BILLING_MFA_SECRET}', now()),
  ('00000000-0000-0000-0000-0000a0001003', '${TENANT1_ID}', 'finance@acmeco.com',
   crypt('FinancePass123!', gen_salt('bf')), 'Finance', NULL, NULL),
  ('00000000-0000-0000-0000-0000a0001004', '${TENANT1_ID}', 'support@acmeco.com',
   crypt('SupportPass123!', gen_salt('bf')), 'Support', NULL, NULL)
ON CONFLICT (id) DO UPDATE SET
  password_hash = excluded.password_hash,
  role = excluded.role,
  mfa_secret = excluded.mfa_secret,
  mfa_enrolled_at = excluded.mfa_enrolled_at,
  pending_mfa_secret = NULL,
  failed_login_count = 0,
  locked_until = NULL;
"

run_psql -c "
UPDATE tenant_settings SET require_mfa_all_roles = false, idle_timeout_minutes = 480
WHERE tenant_id = '${TENANT1_ID}';
"

echo "seeded console-auth fixture users under acct_1001"
echo "  owner@acmeco.com   / OwnerPass123!   (Owner, MFA enrolled, secret ${OWNER_MFA_SECRET})"
echo "  billing@acmeco.com / BillingPass123! (Billing Admin, MFA enrolled, secret ${BILLING_MFA_SECRET})"
echo "  finance@acmeco.com / FinancePass123! (Finance, no MFA)"
echo "  support@acmeco.com / SupportPass123! (Support, no MFA)"
