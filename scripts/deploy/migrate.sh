#!/usr/bin/env bash
# Apply SQL migrations and views to Postgres.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

run_psql() {
  if [[ -n "${MIGRATION_DATABASE_URL:-}" ]]; then
    psql "$MIGRATION_DATABASE_URL" "$@"
  else
    psql "$@"
  fi
}

if [[ -z "${MIGRATION_DATABASE_URL:-}" && -z "${PGHOST:-}" ]]; then
  echo "ERROR: Set MIGRATION_DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE" >&2
  exit 1
fi

# 1 makes a set *_DB_PASSWORD whose role does not exist an error instead of a skip.
REQUIRE_RUNTIME_ROLES="${MIGRATE_REQUIRE_RUNTIME_ROLES:-0}"
if [[ "$REQUIRE_RUNTIME_ROLES" != "0" && "$REQUIRE_RUNTIME_ROLES" != "1" ]]; then
  echo "ERROR: MIGRATE_REQUIRE_RUNTIME_ROLES must be 0 or 1" >&2
  exit 1
fi

# Runs the SQL on stdin as one transaction that stops at the first error, after taking a
# transaction-scoped advisory lock that every step of this script shares: concurrent runs against
# one database execute their steps one at a time, and a killed client's lock ends with its session.
run_locked_psql() {
  { echo "SELECT pg_advisory_xact_lock(7400271203853146) AS migrate_lock \\gset"; cat; } \
    | run_psql --single-transaction -v ON_ERROR_STOP=1 "$@" -f -
}

run_locked_psql -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

echo "Running migrations..."
for f in "$ROOT_DIR"/db/migrations/*.sql; do
  BASENAME=$(basename "$f")
  ALREADY=$(echo "SELECT 1 FROM schema_migrations WHERE filename = :'fname'" | run_psql -v ON_ERROR_STOP=1 -v "fname=$BASENAME" -tA)
  if [[ "$ALREADY" == "1" ]]; then
    echo "  Skipping $BASENAME (already applied)"
    continue
  fi
  echo "  Applying $BASENAME"
  # --single-transaction: several migrations rely on being run as one
  # transaction per file — e.g. db/migrations/0035_sync_installations_and_
  # workspace_replicas.sql's `ON COMMIT DROP` scratch temp tables (dropped
  # before the next statement can use them without this), and org.workspaces'
  # fk_workspaces_fsrs_last_modified_replica, which is DEFERRABLE INITIALLY
  # DEFERRED specifically so a circular insert order across two tables can
  # be checked once at commit instead of per statement. Without this flag,
  # psql autocommits each statement individually and both patterns break on
  # a from-scratch migrate run.
  # The file and its schema_migrations row commit together, so an interrupted run leaves neither;
  # the re-check under the lock skips a file that a concurrent run applied after the check above.
  # \i resolves the bare file name against the subshell's directory: an interpolated path would not
  # survive whitespace.
  (cd "$(dirname "$f")" && run_locked_psql -v "fname=$BASENAME" <<'SQL'
SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = :'fname') AS already_applied \gset
\if :already_applied
\echo '  Skipping' :'fname' '(applied by a concurrent run)'
\else
\i :fname
INSERT INTO schema_migrations (filename) VALUES (:'fname');
\endif
SQL
  )
done

echo "Applying views..."
for f in "$ROOT_DIR"/db/views/*.sql; do
  echo "  Applying $(basename "$f")"
  (cd "$(dirname "$f")" && run_locked_psql -v "fname=$(basename "$f")" <<'SQL'
\i :fname
SQL
  )
done

# The password reaches psql only through MIGRATE_ROLE_PASSWORD in that call's environment and is read
# with \getenv (psql 15+; an older psql rejects the command and the step fails), so it is not in any
# process's command line. :'role_pass' and %L quote it as a literal.
configure_role_password() {
  MIGRATE_ROLE_PASSWORD="$2" run_locked_psql -v "role_name=$1" -v "role_required=$REQUIRE_RUNTIME_ROLES" <<'SQL'
\getenv role_pass MIGRATE_ROLE_PASSWORD
\if :{?role_pass}
\else
DO $$
BEGIN
  RAISE EXCEPTION 'runtime role password was not passed to psql';
END
$$;
\endif
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name') AS role_exists \gset
\if :role_exists
SELECT format('ALTER ROLE %I WITH PASSWORD %L', :'role_name', :'role_pass') \gexec
\elif :role_required
SELECT set_config('migrate.missing_role', :'role_name', true) AS missing_role \gset
DO $$
BEGIN
  RAISE EXCEPTION 'runtime role % does not exist', current_setting('migrate.missing_role');
END
$$;
\endif
SQL
}

if [[ -n "${BACKEND_DB_PASSWORD:-}" ]]; then
  configure_role_password backend_app "$BACKEND_DB_PASSWORD"
fi

if [[ -n "${AUTH_DB_PASSWORD:-}" ]]; then
  configure_role_password auth_app "$AUTH_DB_PASSWORD"
fi

if [[ -n "${REPORTING_DB_PASSWORD:-}" ]]; then
  configure_role_password reporting_readonly "$REPORTING_DB_PASSWORD"
fi

run_locked_psql -v "admin_emails=${ADMIN_EMAILS:-}" <<'SQL'
CREATE TEMP TABLE desired_bootstrap_admins (
  email TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO desired_bootstrap_admins (email)
SELECT DISTINCT lower(btrim(raw_email))
FROM regexp_split_to_table(:'admin_emails', ',') AS raw_email
WHERE btrim(raw_email) <> '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM desired_bootstrap_admins
    WHERE position('@' IN email) = 0
  ) THEN
    RAISE EXCEPTION 'ADMIN_EMAILS contains one or more invalid email values';
  END IF;
END
$$;

INSERT INTO auth.admin_users (email, granted_at, granted_by, revoked_at, note, source)
SELECT email, now(), 'bootstrap:ADMIN_EMAILS', NULL, NULL, 'bootstrap'
FROM desired_bootstrap_admins
ON CONFLICT (email) DO UPDATE
SET granted_at = now(),
    granted_by = EXCLUDED.granted_by,
    revoked_at = NULL,
    note = NULL,
    source = 'bootstrap'
WHERE auth.admin_users.source = 'bootstrap'
  AND auth.admin_users.revoked_at IS NOT NULL;

UPDATE auth.admin_users
SET revoked_at = now()
WHERE source = 'bootstrap'
  AND revoked_at IS NULL
  AND email NOT IN (
    SELECT email
    FROM desired_bootstrap_admins
  );
SQL

echo "Migrations complete."
