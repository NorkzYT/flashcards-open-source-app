#!/usr/bin/env bash
# Restores a backup.sh backup into a NEW instance directory and a NEW, empty Compose project. It never
# touches an existing project, volume, network or instance directory: it refuses instead.
#
#   bash sourc/infra/selfhost/restore.sh <backup-dir> <new-instance-dir> <new-project> \
#     [--gateway-port <port>] [--docker-host unix:///path] [--allow-source-project-name] [--start]
#
# Before anything is created it verifies: the backup directory holds exactly the expected private
# files, every checksum, the manifest, archive members (no links, devices, absolute or .. paths;
# instance.tar only .env and secrets/<file>), that this checkout knows the backup's latest migration,
# and that the project has no containers, volumes or networks (labelled or merely named like it).
# Then: copy .env and secrets/ (the same signing key and credentials, so sessions, API keys and media
# stay valid); `create` only postgres and objectstore; require both new volumes to hold no files;
# load the object-store archive and compare every file's SHA-256 with the backup; start postgres
# alone, require a pristine cluster, restore roles and the dump, and compare row counts. No consumer
# (gateway, auth, backend, worker, ...) is started unless --start is given AND every check passed.
# --start also requires --gateway-port different from the source's port, and is refused together
# with --allow-source-project-name (recovery under the source name is started by hand after review).
# The restored stack keeps the source's hosts, SMTP and AI settings: review .env before starting.
# --allow-source-project-name permits reusing the backup's project name (disaster recovery on another
# host), still only when nothing of that project exists on this Docker endpoint.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
# shellcheck source=compose-lib.sh
. "${SCRIPT_DIR}/compose-lib.sh"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

usage="usage: restore.sh <backup-dir> <new-instance-dir> <new-project> [--gateway-port <port>] [--docker-host unix:///path] [--allow-source-project-name] [--start]"
[[ $# -ge 3 ]] || die "$usage"
BACKUP_DIR="$1"
INSTANCE_DIR="${2%/}"
PROJECT="$3"
shift 3
GATEWAY_PORT=""
DOCKER_ENDPOINT="$NB_DEFAULT_DOCKER_HOST"
ALLOW_SOURCE_NAME=false
START=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-port) [[ $# -ge 2 ]] || die "$usage"; GATEWAY_PORT="$2"; shift 2 ;;
    --docker-host) [[ $# -ge 2 ]] || die "$usage"; DOCKER_ENDPOINT="$2"; shift 2 ;;
    --allow-source-project-name) ALLOW_SOURCE_NAME=true; shift ;;
    --start) START=true; shift ;;
    *) die "$usage" ;;
  esac
done
require_safe_path "$BACKUP_DIR"
require_safe_path "$INSTANCE_DIR"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid project name ${PROJECT}"
if [[ -n "$GATEWAY_PORT" ]]; then
  [[ "$GATEWAY_PORT" =~ ^[1-9][0-9]{0,4}$ && "$GATEWAY_PORT" -le 65535 ]] || die "invalid --gateway-port"
fi
if [[ "$START" == true ]]; then
  [[ "$ALLOW_SOURCE_NAME" != true ]] \
    || die "--start is refused with --allow-source-project-name; review the restored .env and start it by hand"
  [[ -n "$GATEWAY_PORT" ]] || die "--start requires --gateway-port, so the restore cannot take the source's listener"
fi

nb_check_shell_env
nb_set_docker_host "$DOCKER_ENDPOINT"

# --- The backup directory -------------------------------------------------------------------------
echo "Verifying ${BACKUP_DIR}"
require_private_dir "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"
expected="$(printf '%s\n' SHA256SUMS "${BACKUP_FILES[@]}" | LC_ALL=C sort)"
actual="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
[[ "$actual" == "$expected" ]] || die "${BACKUP_DIR} must contain exactly: $(tr '\n' ' ' <<<"$expected")"
for file in SHA256SUMS "${BACKUP_FILES[@]}"; do
  path="${BACKUP_DIR}/${file}"
  [[ -f "$path" && ! -L "$path" ]] || die "${file} is not a regular file"
  [[ "$(stat -c %u "$path")" == "$(id -u)" ]] || die "${file} is not owned by you"
  (((8#$(stat -c %a "$path") & 8#077) == 0)) || die "${file} is readable or writable by others; backups are 0600"
done
# SHA256SUMS must name every data file exactly once and nothing else.
sums_names="$(sed -nE 's/^[0-9a-f]{64}  ([A-Za-z0-9._-]+)$/\1/p' "${BACKUP_DIR}/SHA256SUMS" | LC_ALL=C sort)"
[[ "$(wc -l < "${BACKUP_DIR}/SHA256SUMS")" == "${#BACKUP_FILES[@]}" \
  && "$sums_names" == "$(printf '%s\n' "${BACKUP_FILES[@]}" | LC_ALL=C sort)" ]] \
  || die "SHA256SUMS does not list exactly the backup files"
(cd "$BACKUP_DIR" && sha256sum --quiet --strict -c SHA256SUMS) || die "checksum verification failed"

MANIFEST="${BACKUP_DIR}/manifest.env"
[[ "$(env_get "$MANIFEST" format)" == "$BACKUP_FORMAT" ]] || die "unsupported backup format (expected ${BACKUP_FORMAT})"
SOURCE_PROJECT="$(env_get "$MANIFEST" source_project)"
BACKUP_LATEST="$(env_get "$MANIFEST" latest_migration)"
SOURCE_PORT="$(env_get "$MANIFEST" source_gateway_port)"
SOURCE_COMMIT="$(env_get "$MANIFEST" source_commit)"
[[ "$SOURCE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "manifest has an invalid source_project"
[[ "$BACKUP_LATEST" =~ ^[A-Za-z0-9._-]+\.sql$ ]] || die "manifest has an invalid latest_migration"
[[ "$SOURCE_PORT" =~ ^[0-9]{1,5}$ ]] || die "manifest has an invalid source_gateway_port"
[[ "$(latest_migration_in_counts "${BACKUP_DIR}/verify-counts.txt")" == "$BACKUP_LATEST" ]] \
  || die "manifest and verify-counts.txt disagree on the latest migration"
if [[ "$PROJECT" == "$SOURCE_PROJECT" && "$ALLOW_SOURCE_NAME" != true ]]; then
  die "restore into a separate project, not ${SOURCE_PROJECT} (see --allow-source-project-name)"
fi
if [[ "$START" == true && "$GATEWAY_PORT" == "$SOURCE_PORT" ]]; then
  die "--gateway-port ${GATEWAY_PORT} is the source instance's port; pick another"
fi
# This checkout must know every migration the backup has applied, or its services cannot run it.
[[ -f "${REPO_ROOT}/db/migrations/${BACKUP_LATEST}" ]] \
  || die "this source checkout lacks migration ${BACKUP_LATEST}; check out commit ${SOURCE_COMMIT} or newer"
validate_tar_members "${BACKUP_DIR}/instance.tar" instance
validate_tar_members "${BACKUP_DIR}/objectstore.tar" objectstore
grep -qvE '^[0-9a-f]{64}  \./' "${BACKUP_DIR}/objectstore.files.sha256" \
  && die "objectstore.files.sha256 is malformed"

# --- The target must not exist in any form ---------------------------------------------------------
[[ ! -e "$INSTANCE_DIR" && ! -L "$INSTANCE_DIR" ]] || die "${INSTANCE_DIR} already exists; restore needs a new instance directory"
parent="$(dirname "$INSTANCE_DIR")"
require_private_dir "$parent"
parent_real="$(cd "$parent" && pwd -P)"
case "${parent_real}/" in
  "${REPO_ROOT}/"* | "${BACKUP_DIR}/"*) die "the instance directory must be outside the source checkout and the backup" ;;
esac
# Every listing is captured first, so a failing Docker call aborts instead of reading as "none".
label="label=com.docker.compose.project=${PROJECT}"
found="$(D ps -aq --filter "$label")"
[[ -z "$found" ]] || die "project ${PROJECT} already has containers"
found="$(D volume ls -q --filter "$label")"
[[ -z "$found" ]] || die "project ${PROJECT} already has volumes"
found="$(D network ls -q --filter "$label")"
[[ -z "$found" ]] || die "project ${PROJECT} already has networks"
all_volumes="$(D volume ls -q)"
for volume in pgdata objectdata; do
  if grep -qxF "${PROJECT}_${volume}" <<<"$all_volumes"; then die "volume ${PROJECT}_${volume} already exists"; fi
done
all_networks="$(D network ls --format '{{.Name}}')"
for network in "${!NB_NETWORK_INTERNAL[@]}"; do
  if grep -qxF "${PROJECT}_${network}" <<<"$all_networks"; then die "network ${PROJECT}_${network} already exists"; fi
done

# --- Instance directory ---------------------------------------------------------------------------
echo "Creating ${INSTANCE_DIR}"
mkdir -m 0700 "$INSTANCE_DIR"
tar -C "$INSTANCE_DIR" --no-same-owner -xpf "${BACKUP_DIR}/instance.tar"
ENV_FILE="${INSTANCE_DIR}/.env"
set_env() {
  local tmp="${ENV_FILE}.tmp"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}
set_env NIBOMO_INSTANCE_DIR "$INSTANCE_DIR"
set_env NIBOMO_COMPOSE_PROJECT "$PROJECT"
set_env NIBOMO_DOCKER_HOST "$NB_DOCKER_HOST"
if [[ -n "$GATEWAY_PORT" ]]; then set_env NIBOMO_GATEWAY_PORT "$GATEWAY_PORT"; fi

nb_resolve_instance "$INSTANCE_DIR"
[[ "$NB_PROJECT" == "$PROJECT" && "$NB_DOCKER_HOST" == "$DOCKER_ENDPOINT" ]] || die "internal: restored .env does not resolve to ${PROJECT}"
nb_check_binding

# --- Volumes: new and empty -------------------------------------------------------------------------
echo "Creating project ${PROJECT} data services (not started)"
C create postgres objectstore
pgdata_volume="$(project_volume "$PROJECT" pgdata)"
objectdata_volume="$(project_volume "$PROJECT" objectdata)"
pg_container="$(C ps -aq postgres)"
os_container="$(C ps -aq objectstore)"
[[ "$pg_container" =~ ^[0-9a-f]+$ && "$os_container" =~ ^[0-9a-f]+$ ]] || die "expected exactly one postgres and one objectstore container"
pg_image="$(D inspect -f '{{.Image}}' "$pg_container")"
os_image="$(D inspect -f '{{.Image}}' "$os_container")"
[[ "$os_image" == "$(env_get "$MANIFEST" objectstore_image)" ]] \
  || echo "WARNING: the object-store image differs from the one that wrote this backup" >&2
for volume in "$pgdata_volume" "$objectdata_volume"; do
  # shellcheck disable=SC2016
  D run --rm --network none -v "${volume}:/data:ro" --entrypoint sh "$pg_image" \
    -c '[ -z "$(find /data -mindepth 1 ! -type d | head -n 1)" ]' \
    || die "new volume ${volume} already holds files; refusing to restore over it"
done

echo "Loading the object store into ${objectdata_volume}"
D run --rm -i --network none -v "${objectdata_volume}:/data" --entrypoint tar "$pg_image" \
  --numeric-owner -C /data -xpf - < "${BACKUP_DIR}/objectstore.tar"
D run --rm --network none -v "${objectdata_volume}:/data:ro" --entrypoint sh "$pg_image" \
  -c "$OBJECT_SUMS_SCRIPT" > "${INSTANCE_DIR}/restore-objectstore.files.sha256"
cmp -s "${BACKUP_DIR}/objectstore.files.sha256" "${INSTANCE_DIR}/restore-objectstore.files.sha256" \
  || die "restored object-store files differ from the backup; project ${PROJECT} is left as is for inspection"
echo "Object-store files match the backup ($(wc -l < "${BACKUP_DIR}/objectstore.files.sha256") files)."

# --- Database ---------------------------------------------------------------------------------------
echo "Restoring PostgreSQL"
C start postgres
wait_containers running 120 "$pg_container" || die "postgres did not become healthy"
fresh="$(pg_query "$FRESH_DB_SQL")"
[[ "$fresh" == "0|0|0|0" ]] || die "the new cluster is not pristine (schemas|public tables|roles|databases = ${fresh})"
# The bootstrap owner already exists in the fresh cluster; every other role comes from the backup.
grep -vx 'CREATE ROLE flashcards_owner;' "${BACKUP_DIR}/roles.sql" \
  | pg_exec psql -h 127.0.0.1 -U flashcards_owner -d postgres -v ON_ERROR_STOP=1 -q
pg_exec pg_restore -h 127.0.0.1 -U flashcards_owner -d flashcards --exit-on-error --single-transaction \
  < "${BACKUP_DIR}/database.dump"

echo "Verifying restored rows"
pg_query "$VERIFY_SQL" > "${INSTANCE_DIR}/restore-verify-counts.txt"
if ! diff -u "${BACKUP_DIR}/verify-counts.txt" "${INSTANCE_DIR}/restore-verify-counts.txt"; then
  die "restored row counts differ from the backup; project ${PROJECT} is left as is for inspection"
fi
echo "Row counts match the backup."

if [[ "$START" == true ]]; then
  echo "All checks passed; starting project ${PROJECT}"
  C up -d --build
  C ps
else
  echo "Data restored and verified; only postgres is running. Review hosts, SMTP, AI and the gateway"
  echo "port in ${ENV_FILE}, then start the stack with:"
  echo "  bash ${SCRIPT_DIR}/compose.sh ${INSTANCE_DIR} up -d --build"
fi
