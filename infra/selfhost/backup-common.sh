# shellcheck shell=bash disable=SC2034,SC2016
# Shared by backup.sh and restore.sh (sourced, not executed). Needs compose-lib.sh.

# 2: objectstore.files.sha256, quiescence evidence and the exact file set below.
BACKUP_FORMAT=2
# Every file of a backup directory; restore refuses a directory with anything else.
BACKUP_FILES=(manifest.env roles.sql database.dump verify-counts.txt objectstore.tar objectstore.files.sha256 instance.tar)

# Row counts compared after a restore; the owner is a superuser, so row-level security does not hide
# rows. Ordered output, one `name|value` per line.
VERIFY_SQL="
SELECT name, value FROM (
  SELECT 'public.schema_migrations' AS name, count(*)::text AS value FROM public.schema_migrations
  UNION ALL SELECT 'public.schema_migrations.latest', max(filename) FROM public.schema_migrations
  UNION ALL SELECT 'auth.user_identities', count(*)::text FROM auth.user_identities
  UNION ALL SELECT 'auth.local_identities', count(*)::text FROM auth.local_identities
  UNION ALL SELECT 'org.workspaces', count(*)::text FROM org.workspaces
  UNION ALL SELECT 'org.workspace_memberships', count(*)::text FROM org.workspace_memberships
  UNION ALL SELECT 'content.cards', count(*)::text FROM content.cards
  UNION ALL SELECT 'content.review_events', count(*)::text FROM content.review_events
  UNION ALL SELECT 'content.media_assets', count(*)::text FROM content.media_assets
  UNION ALL SELECT 'content.media_blobs', count(*)::text FROM content.media_blobs
  UNION ALL SELECT 'ai.chat_runs', count(*)::text FROM ai.chat_runs
) AS counts ORDER BY name;
"

# Client sessions other than the one asking; any of them is a writer this script does not control.
PG_CLIENTS_SQL="SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"
PG_CLIENTS_DETAIL_SQL="SELECT coalesce(usename, '?') || ' app=' || coalesce(application_name, '') || ' addr=' || coalesce(client_addr::text, 'local') FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"

# A freshly initialised cluster: no application schema, no table in public, no role but the bootstrap
# owner, no extra database. Output must be exactly 0|0|0|0.
FRESH_DB_SQL="SELECT
  (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pg_toast')
     AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%') || '|' ||
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') || '|' ||
  (SELECT count(*) FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> 'flashcards_owner') || '|' ||
  (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', 'flashcards'))"

# Run inside a container with the volume at /data. Lists every regular file with its SHA-256 and
# refuses symlinks, devices and other special entries (restore never extracts them).
OBJECT_SUMS_SCRIPT='set -eu
cd /data
odd="$(find . -mindepth 1 ! -type f ! -type d | head -n 5)"
if [ -n "$odd" ]; then echo "unsupported non-regular entries in the object store volume:" >&2; echo "$odd" >&2; exit 3; fi
find . -type f -print0 | LC_ALL=C sort -z | xargs -0r sha256sum'

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_safe_path() {
  nb_safe_abs_path "$1" || die "$1 must be an absolute path of letters, digits, / . _ - (no .., no //)"
}

# A directory only you (or root) can change.
require_private_dir() {
  [[ -d "$1" && ! -L "$1" ]] || die "$1 is not a directory (or is a symlink)"
  local owner mode
  owner="$(stat -c %u "$1")"
  mode="$(stat -c %a "$1")"
  [[ "$owner" == "$(id -u)" || "$owner" == 0 ]] || die "$1 is owned by uid ${owner}, not you or root"
  (((8#$mode & 8#022) == 0)) || die "$1 is group- or world-writable (mode ${mode})"
}

env_get() { nb_env_get "$@"; }

D() { nb_docker "$@"; }
C() { nb_compose "$@"; }

# The one named volume Compose created for <project>/<volume>, named <project>_<volume>.
project_volume() {
  local names
  names="$(D volume ls -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.volume=$2")"
  [[ "$names" == "$1_$2" ]] || die "expected exactly one volume $1_$2 labelled for project $1, found: ${names:-none}"
  printf '%s' "$names"
}

# No secret ever appears in an argument: the password is read from the mounted secret file.
pg_exec() {
  C exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/db_owner_password)" exec "$@"' sh "$@"
}
pg_query() { pg_exec psql -h 127.0.0.1 -U flashcards_owner -d flashcards -v ON_ERROR_STOP=1 -At -c "$1"; }

latest_migration_in_counts() {
  grep -E '^public\.schema_migrations\.latest\|' "$1" | cut -d'|' -f2
}

# Refuses absolute names, `..` components and every member type but regular files and directories.
# mode `instance` also limits members to .env and secrets/<file>.
validate_tar_members() {
  local archive="$1" mode="$2" listing verbose name
  listing="$(tar -tf "$archive")" || die "cannot list ${archive}"
  verbose="$(tar -tvf "$archive")" || die "cannot list ${archive}"
  if grep -qvE '^[-d]' <<<"$verbose"; then
    die "${archive} contains links, devices or other special members"
  fi
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ "$name" != /* ]] || die "${archive} contains an absolute member ${name}"
    case "/${name}/" in */../*) die "${archive} contains a .. member ${name}" ;; esac
    if [[ "$mode" == instance ]]; then
      [[ "$name" =~ ^(\./)?(\.env|secrets/?|secrets/[A-Za-z0-9._-]+)$ ]] \
        || die "${archive} contains an unexpected member ${name}"
    fi
  done <<<"$listing"
}

# Test harness only: SELFHOST_TEST_MAX_WAIT (seconds) can shorten, never lengthen, every wait bound.
bounded() {
  local cap="${SELFHOST_TEST_MAX_WAIT:-}"
  if [[ "$cap" =~ ^[0-9]+$ && "$cap" -lt "$1" ]]; then printf '%s' "$cap"; else printf '%s' "$1"; fi
}

# Waits up to <seconds> until every container ID is in <state> (running: also healthy when it has a
# health check). Prints the containers that did not get there and fails.
wait_containers() {
  local want="$1" seconds
  seconds="$(bounded "$2")"
  shift 2
  local deadline=$((SECONDS + seconds)) pending id status
  while :; do
    pending=()
    for id in "$@"; do
      status="$(D inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")" \
        || status="unknown/unknown"
      case "$want" in
        running) [[ "$status" == running/healthy || "$status" == running/none ]] || pending+=("${id}=${status}") ;;
        stopped) [[ "$status" != running/* && "$status" != restarting/* && "$status" != paused/* ]] || pending+=("${id}=${status}") ;;
      esac
    done
    [[ ${#pending[@]} -gt 0 ]] || return 0
    if ((SECONDS >= deadline)); then
      echo "ERROR: not ${want} after ${seconds}s: ${pending[*]}" >&2
      return 1
    fi
    sleep 1
  done
}
