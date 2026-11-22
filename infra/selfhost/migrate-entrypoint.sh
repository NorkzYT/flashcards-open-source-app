#!/bin/bash
# One-shot migration job for the standalone stack: the repository's own driver
# (scripts/deploy/migrate.sh) as the schema owner, then runtime role passwords from secret files.
set -euo pipefail
export PGHOST="${DB_HOST:?}"
export PGPORT=5432
export PGDATABASE="${DB_NAME:?}"
export PGUSER="${DB_OWNER_USER:?}"
# An empty secret would make the driver skip that role's password instead of failing.
read_secret() {
  local value
  value="$(cat "/run/secrets/$1")"
  if [[ -z "$value" ]]; then
    echo "ERROR: secret $1 is empty" >&2
    exit 1
  fi
  printf '%s' "$value"
}
PGPASSWORD="$(read_secret db_owner_password)"
export PGPASSWORD
# Containers share a private Compose network with Postgres, which has no published port.
export PGSSLMODE=disable
BACKEND_DB_PASSWORD="$(read_secret db_backend_password)"
AUTH_DB_PASSWORD="$(read_secret db_auth_password)"
export BACKEND_DB_PASSWORD AUTH_DB_PASSWORD
# reporting_readonly keeps no password: it is not used by the standalone stack.
unset REPORTING_DB_PASSWORD
# Both runtime roles exist after the migrations, so a missing one is an error, not a skip.
export MIGRATE_REQUIRE_RUNTIME_ROLES=1
exec bash /scripts/deploy/migrate.sh
