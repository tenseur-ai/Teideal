#!/usr/bin/env bash
# Creates the local `teideal` database (if needed) and applies migrations.
# Run as a role that can connect to Postgres as a superuser (locally: the
# `postgres` OS/DB user via peer auth). In CI this runs against the
# postgres service container instead -- see .github/workflows/ci.yml.
set -euo pipefail

PSQL_SUPERUSER="${PSQL_SUPERUSER:-postgres}"
DB_NAME="${DB_NAME:-teideal}"
MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/migrations" && pwd)"

run_psql() {
  if [ "${CI:-}" = "true" ]; then
    PGPASSWORD="${PGPASSWORD:-postgres}" psql -h 127.0.0.1 -U "$PSQL_SUPERUSER" "$@"
  else
    sudo -u "$PSQL_SUPERUSER" psql "$@"
  fi
}

if ! run_psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" postgres | grep -q 1; then
  run_psql -c "CREATE DATABASE ${DB_NAME}" postgres
fi

for migration in "$MIGRATIONS_DIR"/*.sql; do
  echo "applying $(basename "$migration")"
  run_psql -d "$DB_NAME" -f "$migration"
done
