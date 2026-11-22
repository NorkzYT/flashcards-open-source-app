#!/usr/bin/env bash
# Integration test of scripts/deploy/migrate.sh against a real, disposable PostgreSQL server that
# the caller owns. It runs the driver over a synthetic migration tree, so it never touches the
# repository's schema, and creates one fresh database per case (migsafe_<case>_<run>), which it
# leaves in place. Never point it at a server holding data.
#
#   PGHOST=... PGPORT=... PGUSER=<superuser> PGPASSWORD=... \
#     MIGRATE_SAFETY_DISPOSABLE_SERVER=1 bash infra/selfhost/tests/migrate-driver-safety.sh
#
# MIGRATE_DRIVER overrides the driver under test (default: this checkout's). The server must
# authenticate TCP/socket logins by password (as the postgres image does for non-local hosts).
set -euo pipefail

if [[ "${MIGRATE_SAFETY_DISPOSABLE_SERVER:-}" != "1" ]]; then
  echo "Refusing: set MIGRATE_SAFETY_DISPOSABLE_SERVER=1 to confirm PGHOST is a disposable server." >&2
  exit 2
fi
: "${PGHOST:?}" "${PGUSER:?}"
unset MIGRATION_DATABASE_URL PGDATABASE BACKEND_DB_PASSWORD AUTH_DB_PASSWORD REPORTING_DB_PASSWORD \
  ADMIN_EMAILS MIGRATE_REQUIRE_RUNTIME_ROLES MIGRATE_ROLE_PASSWORD

REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
DRIVER="${MIGRATE_DRIVER:-${REPO_DIR}/scripts/deploy/migrate.sh}"
RUN_ID="$(date +%s)_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/migsafe.XXXXXX")"
FAILURES=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

q() { psql -d "$DB" -v ON_ERROR_STOP=1 -XAtq -c "$1"; }

# new_case <name>: fresh database plus a synthetic tree with the driver and two base migrations.
new_case() {
  DB="migsafe_$1_${RUN_ID}"
  ROOT="${WORK}/$1"
  mkdir -p "${ROOT}/scripts/deploy" "${ROOT}/db/migrations" "${ROOT}/db/views"
  cp "$DRIVER" "${ROOT}/scripts/deploy/migrate.sh"
  psql -d postgres -v ON_ERROR_STOP=1 -XAtq -c "CREATE DATABASE ${DB}"
  cat > "${ROOT}/db/migrations/0001_auth.sql" <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.admin_users (
  email TEXT PRIMARY KEY,
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  note TEXT,
  source TEXT NOT NULL
);
SQL
  # backend_app is cluster-wide; reporting_readonly is deliberately never created here.
  cat > "${ROOT}/db/migrations/0002_roles.sql" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backend_app') THEN
    CREATE ROLE backend_app LOGIN;
  END IF;
END
$$;
SQL
  echo "CREATE OR REPLACE VIEW public.health AS SELECT now() AS checked_at;" > "${ROOT}/db/views/health.sql"
}

migrate() { PGDATABASE="$DB" bash "${ROOT}/scripts/deploy/migrate.sh"; }

history() { q "SELECT string_agg(filename, ',' ORDER BY filename) FROM public.schema_migrations"; }

if [[ "$(psql -d postgres -XAtq -c "SELECT count(*) FROM pg_roles WHERE rolname = 'reporting_readonly'")" != "0" ]]; then
  echo "Precondition: role reporting_readonly must not exist on this server (missing-role case)." >&2
  exit 2
fi

echo "== invalid ADMIN_EMAILS fails the run and changes nothing"
new_case admin
ADMIN_EMAILS="first-admin@example.invalid" migrate > "${WORK}/admin-1.log" 2>&1
set +e
ADMIN_EMAILS="second-admin@example.invalid,typo-no-at" migrate > "${WORK}/admin-2.log" 2>&1
rc=$?
set -e
state="$(q "SELECT string_agg(email || ':' || (revoked_at IS NULL), ',' ORDER BY email) FROM auth.admin_users")"
if [[ $rc -ne 0 && "$state" == "first-admin@example.invalid:true" ]] \
  && grep -q 'invalid email values' "${WORK}/admin-2.log" && ! grep -q 'Migrations complete' "${WORK}/admin-2.log"; then
  pass "invalid admin exit=$rc, grants unchanged ($state)"
else
  fail "invalid admin exit=$rc state=$state"; cat "${WORK}/admin-2.log"
fi

echo "== runtime role passwords"
new_case roles
set +e
BACKEND_DB_PASSWORD=pw-backend REPORTING_DB_PASSWORD=pw-reporting MIGRATE_REQUIRE_RUNTIME_ROLES=1 \
  migrate > "${WORK}/roles-required.log" 2>&1
rc_required=$?
BACKEND_DB_PASSWORD=pw-backend REPORTING_DB_PASSWORD=pw-reporting migrate > "${WORK}/roles-default.log" 2>&1
rc_default=$?
MIGRATE_REQUIRE_RUNTIME_ROLES=yes migrate > "${WORK}/roles-bad-flag.log" 2>&1
rc_flag=$?
set -e
if [[ $rc_required -ne 0 ]] && grep -q 'runtime role reporting_readonly does not exist' "${WORK}/roles-required.log"; then
  pass "missing role with MIGRATE_REQUIRE_RUNTIME_ROLES=1 exit=$rc_required"
else
  fail "missing required role exit=$rc_required"; cat "${WORK}/roles-required.log"
fi
if [[ $rc_default -eq 0 ]]; then pass "missing role skipped by default (exit 0)"; else fail "default role skip exit=$rc_default"; fi
if [[ $rc_flag -ne 0 ]]; then pass "invalid MIGRATE_REQUIRE_RUNTIME_ROLES exit=$rc_flag"; else fail "bad flag accepted"; fi
if [[ "$(q "SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = 'backend_app'")" == "t" ]]; then
  pass "backend_app password set"
else
  fail "backend_app password not set"
fi

echo "== a failing file rolls back with no history row"
new_case failfile
cat > "${ROOT}/db/migrations/0003_partial.sql" <<'SQL'
CREATE TABLE public.partial_table (id INT);
SELECT 1 / 0;
SQL
set +e
migrate > "${WORK}/failfile.log" 2>&1
rc=$?
set -e
if [[ $rc -ne 0 && "$(q "SELECT to_regclass('public.partial_table') IS NULL")" == "t" \
  && "$(history)" == "0001_auth.sql,0002_roles.sql" ]]; then
  pass "failing file exit=$rc, table absent, history $(history)"
else
  fail "failing file exit=$rc history=$(history)"; cat "${WORK}/failfile.log"
fi

echo "== a client killed mid-file leaves neither the file's effects nor its row"
new_case kill
cat > "${ROOT}/db/migrations/0003_slow.sql" <<'SQL'
CREATE TABLE public.slow_table (id INT);
SELECT pg_sleep(4);
SQL
setsid bash -c "PGDATABASE='$DB' exec bash '${ROOT}/scripts/deploy/migrate.sh'" > "${WORK}/kill-1.log" 2>&1 &
victim=$!
for _ in $(seq 1 50); do
  [[ "$(q "SELECT count(*) FROM pg_stat_activity WHERE datname = '${DB}' AND query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid()")" == "1" ]] && break
  sleep 0.1
done
kill -KILL -- "-${victim}"
wait "$victim" 2>/dev/null || true
after_kill="$(q "SELECT to_regclass('public.slow_table') IS NULL")|$(history)"
migrate > "${WORK}/kill-2.log" 2>&1
after_rerun="$(q "SELECT to_regclass('public.slow_table') IS NOT NULL")|$(history)"
if [[ "$after_kill" == "t|0001_auth.sql,0002_roles.sql" && "$after_rerun" == "t|0001_auth.sql,0002_roles.sql,0003_slow.sql" ]]; then
  pass "after kill: $after_kill; rerun: $after_rerun"
else
  fail "after kill: $after_kill; rerun: $after_rerun"; cat "${WORK}/kill-1.log" "${WORK}/kill-2.log"
fi

echo "== concurrent runs apply each file once"
new_case concurrent
cat > "${ROOT}/db/migrations/0003_slow_create.sql" <<'SQL'
SELECT pg_sleep(2);
CREATE TABLE public.created_once (id INT);
SQL
migrate > "${WORK}/concurrent-a.log" 2>&1 &
pid_a=$!
migrate > "${WORK}/concurrent-b.log" 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; rc_a=$?
wait "$pid_b"; rc_b=$?
set -e
if [[ $rc_a -eq 0 && $rc_b -eq 0 && "$(history)" == "0001_auth.sql,0002_roles.sql,0003_slow_create.sql" ]]; then
  pass "both runs exit 0, history $(history)"
else
  fail "concurrent exit a=$rc_a b=$rc_b history=$(history)"; cat "${WORK}/concurrent-a.log" "${WORK}/concurrent-b.log"
fi

echo "== runtime role passwords stay out of psql arguments and output"
# Every psql the driver starts goes through a wrapper that records its arguments, NUL-separated.
# Passwords are compared against those records and the logs, never printed.
new_case secrets
REAL_PSQL="$(command -v psql)"
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/psql" <<WRAP
#!/usr/bin/env bash
printf '%s\0' "\$@" >> "${WORK}/secrets-argv"
printf '\n\0' >> "${WORK}/secrets-argv"
exec "${REAL_PSQL}" "\$@"
WRAP
chmod +x "${WORK}/bin/psql"
cat > "${ROOT}/db/migrations/0003_auth_role.sql" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_app') THEN
    CREATE ROLE auth_app LOGIN;
  END IF;
END
$$;
SQL
# Synthetic values covering psql and SQL metacharacters: quotes, backslashes, psql variable
# syntax, format() specifiers, an option-like prefix, a newline and non-ASCII text.
pw_backend="synthBK7 it's \"q\" \\x \$HOME :'role_name' :{?x} %s %L; -- -v role_pass=1"
pw_auth="-synthAU9');ALTER ROLE backend_app NOSUPERUSER;--
second-line-synthAU9 pässwörd ✓"
pw_reporting="synthRP3-never-applied"
set +e
PATH="${WORK}/bin:${PATH}" BACKEND_DB_PASSWORD="$pw_backend" AUTH_DB_PASSWORD="$pw_auth" \
  migrate > "${WORK}/secrets-ok.log" 2>&1
rc_ok=$?
admins_before="$(q "SELECT count(*) FROM auth.admin_users")"
PATH="${WORK}/bin:${PATH}" BACKEND_DB_PASSWORD="$pw_backend" AUTH_DB_PASSWORD="$pw_auth" \
  REPORTING_DB_PASSWORD="$pw_reporting" MIGRATE_REQUIRE_RUNTIME_ROLES=1 \
  ADMIN_EMAILS="secrets-admin@example.invalid" migrate > "${WORK}/secrets-missing.log" 2>&1
rc_missing=$?
set -e
login_as() {
  PGPASSWORD="$2" "$REAL_PSQL" -d "$DB" -U "$1" -XAtq -c 'SELECT current_user' 2>/dev/null
}
if [[ $rc_ok -eq 0 ]]; then pass "varied passwords applied (exit 0)"; else fail "varied passwords exit=$rc_ok"; cat "${WORK}/secrets-ok.log"; fi
if [[ "$(login_as backend_app "$pw_backend")" == "backend_app" && "$(login_as auth_app "$pw_auth")" == "auth_app" ]]; then
  pass "both roles log in with their exact passwords"
else
  fail "a role could not log in with its exact password"
fi
if [[ -z "$(login_as backend_app "wrong-${pw_backend}")" ]]; then
  pass "server enforces passwords (a wrong one is refused)"
else
  fail "a wrong password was accepted: the server does not check passwords, so the login check proves nothing"
fi
if [[ -s "${WORK}/secrets-argv" ]] && grep -q 'role_name=backend_app' "${WORK}/secrets-argv"; then
  pass "argument recorder saw the role steps ($(tr -cd '\n' < "${WORK}/secrets-argv" | wc -c) psql calls)"
else
  fail "argument recorder saw no role step"
fi
leaks=0
for pw in "$pw_backend" "$pw_auth" "$pw_reporting" synthBK7 synthAU9 synthRP3; do
  for f in "${WORK}/secrets-argv" "${WORK}/secrets-ok.log" "${WORK}/secrets-missing.log"; do
    if grep -aqF -- "$pw" "$f"; then leaks=$((leaks + 1)); echo "  secret material found in $(basename "$f")"; fi
  done
done
if [[ $leaks -eq 0 ]]; then pass "no password material in psql arguments or driver output"; else fail "${leaks} password leak(s)"; fi
admins_after="$(q "SELECT count(*) FROM auth.admin_users")"
if [[ $rc_missing -ne 0 && "$admins_after" == "$admins_before" ]] \
  && grep -q 'runtime role reporting_readonly does not exist' "${WORK}/secrets-missing.log" \
  && [[ "$(login_as backend_app "$pw_backend")" == "backend_app" ]]; then
  pass "missing required role exit=$rc_missing: earlier role steps kept, admin step not run (admins $admins_after)"
else
  fail "missing required role exit=$rc_missing admins $admins_before -> $admins_after"; cat "${WORK}/secrets-missing.log"
fi

echo "logs: ${WORK}"
if [[ $FAILURES -ne 0 ]]; then
  echo "${FAILURES} failure(s)"
  exit 1
fi
echo "all passed"
