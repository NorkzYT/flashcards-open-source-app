#!/usr/bin/env bash
# Backup of a standalone instance: PostgreSQL, the RustFS object store and the instance configuration
# (.env plus secrets/, which holds the identity signing key, the session encryption key and the
# database and object-store credentials).
#
#   bash sourc/infra/selfhost/backup.sh /opt/docker/containers/nibomo /opt/docker/containers/nibomo-backups
#
# Quiescence: every running service of the project except postgres and objectstore is stopped (not a
# fixed list, so services added later are covered), and the backup refuses to start while a one-off
# or job container (migrate, objectstore-init) runs, a container is paused/restarting, or a container
# outside the project mounts the data volumes. With the writers stopped it requires zero other
# PostgreSQL client sessions, dumps, and requires identical row counts before and after the dump.
# RustFS is then stopped and its volume archived as files with a per-file SHA-256 list (object
# metadata carries the upload-ownership proof). Exactly the services it stopped are started again,
# also after a failure, and each must be running (healthy where it has a health check) within a
# bound; otherwise the script exits non-zero and names them. The manifest records this evidence; it
# is not a claim about writes from outside Docker.
#
# Output: <backup-parent>/nibomo-backup-<project>-<UTC time>/ (0700, files 0600), written as a
# .partial directory and renamed only after its checksums and archives verify. It contains live
# credentials: keep it off the source checkout and store a copy offline. Restore with restore.sh.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
# shellcheck source=compose-lib.sh
. "${SCRIPT_DIR}/compose-lib.sh"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

INSTANCE_DIR="${1:?usage: backup.sh <absolute-instance-dir> <absolute-backup-parent-dir>}"
BACKUP_PARENT="${2:?usage: backup.sh <absolute-instance-dir> <absolute-backup-parent-dir>}"
[[ $# == 2 ]] || die "usage: backup.sh <absolute-instance-dir> <absolute-backup-parent-dir>"
require_safe_path "$INSTANCE_DIR"
require_safe_path "$BACKUP_PARENT"
INSTANCE_DIR="${INSTANCE_DIR%/}"

nb_check_shell_env
[[ -f "${INSTANCE_DIR}/.env" && ! -L "${INSTANCE_DIR}/.env" ]] || die ".env must be a regular file"
[[ -d "${INSTANCE_DIR}/secrets" && ! -L "${INSTANCE_DIR}/secrets" ]] || die "secrets/ must be a directory"
odd="$(find "${INSTANCE_DIR}/secrets" -mindepth 1 ! -type f | head -n 5)"
[[ -z "$odd" ]] || die "secrets/ may hold only regular files; found: ${odd}"
nb_resolve_instance "$INSTANCE_DIR"
nb_check_binding
PROJECT="$NB_PROJECT"

require_private_dir "$BACKUP_PARENT"
BACKUP_PARENT="$(cd "$BACKUP_PARENT" && pwd -P)"
INSTANCE_REAL="$(cd "$INSTANCE_DIR" && pwd -P)"
case "${BACKUP_PARENT}/" in
  "${REPO_ROOT}/"* | "${INSTANCE_REAL}/secrets/"*) die "backups must not be written inside the source checkout or secrets/" ;;
esac
# --- Inventory: decide everything before touching any service -------------------------------------
inventory="$(D ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
  --format '{{.ID}}|{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Label "com.docker.compose.oneoff"}}')"
declare -A service_ids=()
pg_id="" os_id=""
while IFS='|' read -r id service state oneoff; do
  [[ -n "$id" ]] || continue
  [[ "$service" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || die "container ${id} has an invalid service label"
  case "$state" in
    running | exited | created) ;;
    *) die "container ${id} (${service}) is ${state}; resolve it before a backup" ;;
  esac
  [[ "$state" == running ]] || continue
  [[ "$oneoff" != True ]] || die "one-off container ${id} (${service}) is running; wait for it or stop it first"
  case "$service" in
    migrate | objectstore-init) die "job ${service} is running; wait for it to finish" ;;
    postgres)
      [[ -z "$pg_id" ]] || die "more than one postgres container is running"
      pg_id="$id"
      ;;
    objectstore)
      [[ -z "$os_id" ]] || die "more than one objectstore container is running"
      os_id="$id"
      ;;
    *) service_ids[$service]="${service_ids[$service]:-} ${id}" ;;
  esac
done <<<"$inventory"
[[ -n "$pg_id" ]] || die "service postgres of project ${PROJECT} is not running"
[[ -n "$os_id" ]] || die "service objectstore of project ${PROJECT} is not running"
mapfile -t quiesce < <(printf '%s\n' "${!service_ids[@]}" | LC_ALL=C sort | sed '/^$/d')
quiesce_ids=()
for service in "${quiesce[@]}"; do
  # shellcheck disable=SC2206
  quiesce_ids+=(${service_ids[$service]})
done

pgdata_volume="$(project_volume "$PROJECT" pgdata)"
objectdata_volume="$(project_volume "$PROJECT" objectdata)"
# Only the project's own data service may mount each data volume, in any state.
for pair in "${pgdata_volume}:${pg_id}" "${objectdata_volume}:${os_id}"; do
  users="$(D ps -a --filter "volume=${pair%%:*}" --format '{{.ID}}')"
  [[ "$users" == "${pair#*:}" ]] || die "volume ${pair%%:*} is mounted by containers other than ${pair#*:}: $(tr '\n' ' ' <<<"$users")"
done
pg_image="$(D inspect -f '{{.Image}}' "$pg_id")"
objectstore_image="$(D inspect -f '{{.Image}}' "$os_id")"
daemon_id="$(D info -f '{{.ID}}')"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_DIR="${BACKUP_PARENT}/nibomo-backup-${PROJECT}-${STAMP}"
WORK_DIR="${BACKUP_PARENT}/.nibomo-backup-${PROJECT}-${STAMP}.partial"
[[ ! -e "$FINAL_DIR" && ! -e "$WORK_DIR" ]] || die "${FINAL_DIR} already exists"
mkdir -m 0700 "$WORK_DIR"
echo "Backing up project ${PROJECT} (Docker ${NB_DOCKER_HOST}) into ${WORK_DIR}"

# --- Service state restore ------------------------------------------------------------------------
stopped_services=()
stopped_ids=()
objectstore_stopped=false
restore_failures=()

restore_services() {
  if [[ "$objectstore_stopped" == true ]]; then
    if C start objectstore && wait_containers running 120 "$os_id"; then
      objectstore_stopped=false
    else
      restore_failures+=(objectstore)
    fi
  fi
  if [[ ${#stopped_services[@]} -gt 0 ]]; then
    echo "Starting again: ${stopped_services[*]}"
    C start "${stopped_services[@]}" || echo "ERROR: compose start reported a failure" >&2
    if ! wait_containers running 300 "${stopped_ids[@]}"; then
      restore_failures+=("${stopped_services[@]}")
    fi
    stopped_services=()
  fi
  [[ ${#restore_failures[@]} == 0 ]]
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$objectstore_stopped" == true || ${#stopped_services[@]} -gt 0 ]]; then
    restore_services || true
  fi
  if [[ ${#restore_failures[@]} -gt 0 ]]; then
    echo "ERROR: services of project ${PROJECT} were NOT restored to their previous running state: ${restore_failures[*]}" >&2
    echo "ERROR: inspect with: bash ${SCRIPT_DIR}/compose.sh ${INSTANCE_DIR} ps" >&2
    [[ "$status" != 0 ]] || status=1
  fi
  if [[ -d "$WORK_DIR" ]]; then
    echo "ERROR: backup failed; incomplete ${WORK_DIR} is kept for inspection (it holds secrets; delete it when done)" >&2
    [[ "$status" != 0 ]] || status=1
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- Quiesce --------------------------------------------------------------------------------------
if [[ ${#quiesce[@]} -gt 0 ]]; then
  echo "Stopping every other running service: ${quiesce[*]}"
  stopped_services=("${quiesce[@]}")
  stopped_ids=("${quiesce_ids[@]}")
  C stop "${quiesce[@]}"
  wait_containers stopped 60 "${quiesce_ids[@]}" || die "services did not stop"
fi
running_now="$(D ps --filter "label=com.docker.compose.project=${PROJECT}" --filter status=running --format '{{.ID}}' | LC_ALL=C sort)"
[[ "$running_now" == "$(printf '%s\n' "$pg_id" "$os_id" | LC_ALL=C sort)" ]] \
  || die "unexpected running containers in project ${PROJECT} after quiescing: $(tr '\n' ' ' <<<"$running_now")"

echo "Waiting for PostgreSQL client sessions to end"
clients=""
for _ in $(seq 1 "$(bounded 30)"); do
  clients="$(pg_query "$PG_CLIENTS_SQL")"
  [[ "$clients" == 0 ]] && break
  sleep 1
done
if [[ "$clients" != 0 ]]; then
  echo "Sessions still connected:" >&2
  pg_query "$PG_CLIENTS_DETAIL_SQL" >&2 || true
  die "${clients} PostgreSQL client session(s) remain after quiescing; an unknown writer is connected"
fi

# --- Database -------------------------------------------------------------------------------------
echo "Dumping PostgreSQL"
pg_query "$VERIFY_SQL" > "${WORK_DIR}/verify-counts.txt"
pg_exec pg_dumpall -h 127.0.0.1 -U flashcards_owner --roles-only --no-role-passwords > "${WORK_DIR}/roles.sql"
pg_exec pg_dump -h 127.0.0.1 -U flashcards_owner -d flashcards --format=custom > "${WORK_DIR}/database.dump"
pg_query "$VERIFY_SQL" > "${WORK_DIR}/verify-counts.after"
cmp -s "${WORK_DIR}/verify-counts.txt" "${WORK_DIR}/verify-counts.after" \
  || die "row counts changed during the dump; something is still writing"
rm -f "${WORK_DIR}/verify-counts.after"
[[ "$(pg_query "$PG_CLIENTS_SQL")" == 0 ]] || die "a PostgreSQL client connected during the dump"
C exec -T postgres pg_restore -l < "${WORK_DIR}/database.dump" > /dev/null || die "the database dump is not readable by pg_restore"
pg_server_version="$(pg_query 'SHOW server_version')"
latest_migration="$(latest_migration_in_counts "${WORK_DIR}/verify-counts.txt")"
[[ "$latest_migration" =~ ^[A-Za-z0-9._-]+\.sql$ ]] || die "unexpected latest migration ${latest_migration}"

# --- Object store ---------------------------------------------------------------------------------
echo "Archiving the object store (${objectdata_volume})"
objectstore_stopped=true
C stop objectstore
wait_containers stopped 60 "$os_id" || die "objectstore did not stop"
still_mounted="$(D ps -q --filter "volume=${objectdata_volume}" --filter status=running)"
[[ -z "$still_mounted" ]] \
  || die "a running container still mounts ${objectdata_volume}"
# The postgres image (already present, GNU tar/coreutils) reads the volume; RustFS stays stopped.
D run --rm --network none -v "${objectdata_volume}:/data:ro" --entrypoint sh "$pg_image" \
  -c "$OBJECT_SUMS_SCRIPT" > "${WORK_DIR}/objectstore.files.sha256"
# RustFS hardlinks its own files (a part and its .rustfs.sys/tmp/.trash copy); --hard-dereference
# stores every path as a full regular file, so the archive holds no link members for restore to refuse.
D run --rm --network none -v "${objectdata_volume}:/data:ro" --entrypoint tar "$pg_image" \
  --numeric-owner --hard-dereference -C /data -cf - . > "${WORK_DIR}/objectstore.tar"
object_files="$(wc -l < "${WORK_DIR}/objectstore.files.sha256")"
validate_tar_members "${WORK_DIR}/objectstore.tar" objectstore
archived_files="$(tar -tvf "${WORK_DIR}/objectstore.tar" | grep -c '^-')" || true
[[ "$archived_files" == "$object_files" ]] \
  || die "objectstore.tar holds ${archived_files} files but the volume listed ${object_files}"

restore_services || die "services were not restored"

# --- Configuration --------------------------------------------------------------------------------
echo "Copying instance configuration and secrets"
tar -C "$INSTANCE_DIR" -cf "${WORK_DIR}/instance.tar" .env secrets

network_file_sha="none"
if [[ -n "$NB_NETWORK_FILE" ]]; then network_file_sha="$(sha256sum < "$NB_NETWORK_FILE" | cut -d' ' -f1)"; fi
gateway_port="$(env_get "${INSTANCE_DIR}/.env" NIBOMO_GATEWAY_PORT)"
image_tag="$(env_get "${INSTANCE_DIR}/.env" NIBOMO_IMAGE_TAG)"
{
  echo "format=${BACKUP_FORMAT}"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source_project=${PROJECT}"
  echo "source_instance_dir=${INSTANCE_DIR}"
  echo "source_commit=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "source_gateway_port=${gateway_port:-8088}"
  echo "image_tag=${image_tag}"
  echo "docker_host=${NB_DOCKER_HOST}"
  echo "docker_daemon_id=${daemon_id}"
  echo "compose_files=${NB_CONFIG_FILES}"
  echo "network_file_sha256=${network_file_sha}"
  echo "postgres_server_version=${pg_server_version}"
  echo "postgres_image=${pg_image}"
  echo "objectstore_image=${objectstore_image}"
  echo "pgdata_volume=${pgdata_volume}"
  echo "objectdata_volume=${objectdata_volume}"
  echo "objectstore_file_count=${object_files}"
  echo "latest_migration=${latest_migration}"
  echo "quiesced_services=${quiesce[*]:-}"
  echo "pg_other_client_sessions_during_dump=0"
  echo "row_counts_stable_across_dump=yes"
  echo "objectstore_stopped_during_archive=yes"
} > "${WORK_DIR}/manifest.env"

(cd "$WORK_DIR" && sha256sum -- "${BACKUP_FILES[@]}" > SHA256SUMS)
chmod 0600 "${WORK_DIR}"/*

# --- Self-check before the backup is published ----------------------------------------------------
(cd "$WORK_DIR" && sha256sum --quiet --strict -c SHA256SUMS) || die "checksum self-check failed"
validate_tar_members "${WORK_DIR}/instance.tar" instance
validate_tar_members "${WORK_DIR}/objectstore.tar" objectstore
[[ -s "${WORK_DIR}/database.dump" && -s "${WORK_DIR}/roles.sql" && -s "${WORK_DIR}/verify-counts.txt" ]] \
  || die "a database file is empty"
mv -T "$WORK_DIR" "$FINAL_DIR"

echo "Backup complete: ${FINAL_DIR}"
echo "It contains the signing key and credentials. Keep it private and keep a copy offline."
