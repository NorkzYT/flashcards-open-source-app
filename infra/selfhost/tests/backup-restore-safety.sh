#!/usr/bin/env bash
# Synthetic safety test of compose.sh, backup.sh and restore.sh against fake-docker.py: refusals,
# exactly which Docker/Compose calls are made, service-state restore and positive backup/restore.
# It never reaches a Docker daemon: the fake answers only on its own scratch socket.
#
#   bash infra/selfhost/tests/backup-restore-safety.sh <absolute empty scratch directory>
set -uo pipefail

SELFHOST="$(cd "$(dirname "$0")/.." && pwd -P)"
FAKE="${SELFHOST}/tests/fake-docker.py"
WORK="${1:?usage: backup-restore-safety.sh <absolute empty scratch directory>}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
chmod 0700 "$WORK"
LATEST="$(find "${SELFHOST}/../../db/migrations" -name '0*.sql' -printf '%f\n' | LC_ALL=C sort | tail -n 1)"
SECRET_VALUE="s3cr3t-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
passes=0
failures=0

ok() { echo "PASS $1"; passes=$((passes + 1)); }
bad() { echo "FAIL $1"; failures=$((failures + 1)); [[ -f "${T:-/nonexistent}/out" ]] && sed 's/^/    | /' "$T/out" | tail -n 15; }
expect() { # <name> <command...>: the command must succeed
  local name="$1"; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

calls() { jq -r '.argv | join(" ")' "$T/calls.log" 2>/dev/null; }
# Compose calls with the global binding flags removed: "<subcommand> <args>".
compose_calls() { jq -r 'select(.argv[0]=="compose") | .argv[1:] as $a | [range(0; $a|length) as $i | select(($i == 0 or ($a[$i-1] | IN("-p","--env-file","-f","--profile") | not)) and ($a[$i] | IN("-p","--env-file","-f","--profile") | not)) | $a[$i]] | join(" ")' "$T/calls.log" 2>/dev/null; }
state() { jq -r "$1" "$T/state.json"; }
svc_state() { state ".containers[] | select(.project==\"$1\" and .service==\"$2\") | .state"; }

COUNTS="ai.chat_runs|1
auth.local_identities|2
auth.user_identities|2
content.cards|3
content.media_assets|1
content.media_blobs|1
content.review_events|5
org.workspace_memberships|2
org.workspaces|2
public.schema_migrations|200
public.schema_migrations.latest|${LATEST}"

# A fresh fake host: socket + state, a source instance nbsrc with every service running.
new_case() {
  T="$(mktemp -d "${WORK}/c.XXXXXX")"
  [[ ${#T} -le 90 ]] || { echo "scratch path too long for a Unix socket: ${T}" >&2; exit 2; }
  chmod 0700 "$T"
  mkdir -m 0700 "$T/bin" "$T/backups"
  printf '#!/bin/sh\nexec python3 -I %s "$@"\n' "$FAKE" > "$T/bin/docker"
  chmod 0755 "$T/bin/docker"
  python3 -I -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$T/docker.sock"
  SOCK="unix://${T}/docker.sock"
  INST="$T/inst"
  mkdir -m 0700 "$INST" "$INST/secrets"
  local name
  for name in db_owner_password db_backend_password db_auth_password session_encryption_key \
    local_auth_signing_key.pem local_auth_public_key.pem objectstore_root_access_key \
    objectstore_root_secret_key objectstore_media_access_key objectstore_media_secret_key smtp_password openai_api_key chat_live_auth_secret; do
    printf '%s-%s\n' "$SECRET_VALUE" "$name" > "$INST/secrets/$name"
    chmod 0444 "$INST/secrets/$name"
  done
  cat > "$INST/.env" <<EOF
NIBOMO_INSTANCE_DIR=${INST}
NIBOMO_COMPOSE_PROJECT=nbsrc
NIBOMO_DOCKER_HOST=${SOCK}
NIBOMO_IMAGE_TAG=test
NIBOMO_GATEWAY_PORT=18088
NIBOMO_AI_PROVIDER=none
EOF
  mkdir -p "$T/volumes/nbsrc_pgdata/18/docker" "$T/volumes/nbsrc_objectdata/.rustfs.sys" "$T/volumes/nbsrc_objectdata/nibomo-media/u1"
  echo 18 > "$T/volumes/nbsrc_pgdata/18/docker/PG_VERSION"
  echo meta > "$T/volumes/nbsrc_objectdata/.rustfs.sys/format.json"
  head -c 2048 /dev/urandom > "$T/volumes/nbsrc_objectdata/nibomo-media/u1/img one.bin"
  echo xl > "$T/volumes/nbsrc_objectdata/nibomo-media/u1/xl.meta"
  : > "$T/calls.log"
  CFILES="${SELFHOST}/compose.yml"
  COUNTS="$COUNTS" python3 -I - "$T" "$CFILES" "$INST/.env" <<'PY'
import json, os, sys
t, cfiles, env = sys.argv[1:]
containers = []
def add(svc, state, health=None, mounts=(), oneoff="False", project="nbsrc", cf=cfiles):
    containers.append({"id": "%012x" % (0xA0000 + len(containers)), "project": project, "service": svc,
        "state": state, "health": health, "mounts": list(mounts), "oneoff": oneoff,
        "image": "sha256:" + svc, "config_files": cf, "env_file": env})
add("postgres", "running", "healthy", ["nbsrc_pgdata"])
add("objectstore", "running", "healthy", ["nbsrc_objectdata"])
for svc in ("auth", "backend", "gateway", "worker", "mcp", "maintenance", "mailpit"):
    add(svc, "running", "healthy" if svc != "mailpit" else None)
add("migrate", "exited"); add("objectstore-init", "exited")
lab = lambda k, v: {"com.docker.compose.project": "nbsrc", "com.docker.compose.%s" % k: v}
st = {"containers": containers,
      "volumes": {"nbsrc_pgdata": {"labels": lab("volume", "pgdata")}, "nbsrc_objectdata": {"labels": lab("volume", "objectdata")}},
      "networks": {"nbsrc_%s" % n: {"labels": lab("network", n), "internal": n in ("internal", "app", "storage"), "subnets": ["172.30.%d.0/24" % i]}
                   for i, n in enumerate(("internal", "app", "storage", "edge", "egress"))},
      "behavior": {}, "db": {"nbsrc": {"counts": os.environ["COUNTS"] + "\n", "fresh": "0|0|0|0", "clients": "0"}}}
st["networks"]["bridge"] = {"labels": {}, "internal": False, "subnets": ["172.17.0.0/16"]}
json.dump(st, open(os.path.join(t, "state.json"), "w"), indent=1)
PY
}
set_state() { local tmp="$T/state.tmp"; jq "$1" "$T/state.json" > "$tmp" && mv "$tmp" "$T/state.json"; }

# Runs a script with the fake first in PATH and no ambient Docker variables; extra env as NAME=value.
run() {
  local script="$1"; shift
  local envs=()
  while [[ $# -gt 0 && "$1" == *=* && "$1" != /* ]]; do envs+=("$1"); shift; done
  env -u DOCKER_HOST -u DOCKER_CONTEXT SELFHOST_TEST_MAX_WAIT=2 PATH="$T/bin:$PATH" PLANTED_SHELL_SECRET="$SECRET_VALUE" "${envs[@]}" \
    bash "${SELFHOST}/${script}" "$@" > "$T/out" 2>&1
  RC=$?
}
refused() { [[ "$RC" != 0 ]] && grep -q "$1" "$T/out"; }
no_calls_matching() { ! calls | grep -qE "$1"; }
no_docker_calls() { [[ ! -s "$T/calls.log" ]]; }
# Refused with <message> (fixed string) and no call matching the jq <select> was made.
refused_without() { [[ "$RC" != 0 ]] && grep -qF -- "$1" "$T/out" && ! jq -e "select($2)" "$T/calls.log" >/dev/null; }

all_running_as_before() {
  local svc
  for svc in postgres objectstore auth backend gateway worker mcp maintenance mailpit; do
    [[ "$(svc_state nbsrc "$svc")" == running ]] || { echo "    $svc is $(svc_state nbsrc "$svc")"; return 1; }
  done
  [[ "$(svc_state nbsrc migrate)" == exited && "$(svc_state nbsrc objectstore-init)" == exited ]]
}

echo "== compose.sh binding"
new_case
run compose.sh "$INST" ps
expect "compose: positive call uses exact project, env file, file list and endpoint" bash -c "
  [[ $RC == 0 ]] && jq -e --arg h '$SOCK' --arg e '$INST/.env' --arg f '$SELFHOST/compose.yml' \
    'select(.argv[0]==\"compose\") | .docker_host==\$h and .argv[1:7]==[\"-p\",\"nbsrc\",\"--env-file\",\$e,\"-f\",\$f] and .argv[7]==\"ps\"' '$T/calls.log' >/dev/null"
expect "compose: Docker runs with a scrubbed environment (no NIBOMO_/COMPOSE_/planted vars)" bash -c "
  ! jq -r '.env[]' '$T/calls.log' | grep -qE '^(NIBOMO_|COMPOSE_|PLANTED_|DOCKER_CONTEXT|DOCKER_CONFIG)'"

for bad_env in NIBOMO_INSTANCE_DIR=/elsewhere COMPOSE_PROFILES=ai COMPOSE_FILE=/x.yml DOCKER_CONTEXT=remote DOCKER_CONFIG=/tmp NIBOMO_IMAGE_TAG=other; do
  new_case
  run compose.sh "$bad_env" "$INST" ps
  expect "compose: shell ${bad_env%%=*} refused before any Docker call" bash -c "[[ $RC != 0 ]] && grep -q 'shell variable ${bad_env%%=*}' '$T/out' && [[ ! -s '$T/calls.log' ]]"
done
new_case
run compose.sh DOCKER_HOST=unix:///var/run/docker.sock "$INST" ps
expect "compose: shell DOCKER_HOST differing from the instance endpoint refused, real daemon never called" \
  bash -c "[[ $RC != 0 ]] && grep -q 'differs from the instance endpoint' '$T/out' && [[ ! -s '$T/calls.log' ]]"
new_case
sed -i "s|^NIBOMO_DOCKER_HOST=.*|NIBOMO_DOCKER_HOST=tcp://10.0.0.5:2375|" "$INST/.env"
run compose.sh "$INST" ps
expect "compose: TCP endpoint refused" bash -c "[[ $RC != 0 ]] && grep -q 'remote or TCP endpoints are refused' '$T/out'"
new_case
echo "NIBOMO_COMPOSE_PROJECT=nibomo" >> "$INST/.env"
run compose.sh "$INST" ps
expect "compose: duplicate NIBOMO_COMPOSE_PROJECT refused" bash -c "[[ $RC != 0 ]] && grep -q 'appears 2 times' '$T/out' && [[ ! -s '$T/calls.log' ]]"
new_case
sed -i 's|^NIBOMO_COMPOSE_PROJECT=.*|export NIBOMO_COMPOSE_PROJECT=nibomo|' "$INST/.env"
run compose.sh "$INST" ps
expect "compose: 'export KEY=' form refused" bash -c "[[ $RC != 0 ]] && grep -q 'plain NIBOMO_COMPOSE_PROJECT=value' '$T/out'"
new_case
echo "NIBOMO_COMPOSE_NETWORK_FILE=/x.yml" >> "$INST/.env"
run compose.sh "$INST" ps
expect "compose: NIBOMO_COMPOSE_NETWORK_FILE in .env refused" bash -c "[[ $RC != 0 ]] && grep -q 'per-host shell setting' '$T/out'"
new_case
set_state '(.containers[] | select(.service=="gateway")).config_files = "/other/checkout/infra/selfhost/compose.yml"'
run compose.sh "$INST" up -d
expect "compose: project created from another checkout refused, no compose call" bash -c "
  [[ $RC != 0 ]] && grep -q 'was created with Compose files' '$T/out' && ! jq -e 'select(.argv[0]==\"compose\")' '$T/calls.log' >/dev/null"
new_case
set_state '(.containers[] | select(.service=="auth")).env_file = "/opt/docker/containers/nibomo/.env"'
run compose.sh "$INST" ps
expect "compose: container bound to another instance .env refused" bash -c "[[ $RC != 0 ]] && grep -q 'belongs to env file' '$T/out'"
new_case
set_state '.networks.nbsrc_internal.internal = false'
run compose.sh "$INST" ps
expect "compose: weakened (non-internal) project network refused" bash -c "[[ $RC != 0 ]] && grep -q 'refusing to use a weakened network' '$T/out'"

echo "== network overlay"
write_overlay() {
  OV="$T/net/ipam.yml"
  mkdir -p "$T/net"
  chmod 0755 "$T/net"
  cat > "$OV"
  chmod 0644 "$OV"
}
overlay_case() { # fresh project with no containers/networks yet
  new_case
  set_state '.containers = [] | .networks = {"bridge": {"labels": {}, "internal": false, "subnets": ["172.17.0.0/16"]}, "other_net": {"labels": {}, "internal": false, "subnets": ["10.247.80.0/24"]}}'
}
GOOD_OVERLAY='# fixture overlay
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.70.0/24
  storage:
    ipam:
      config:
        - subnet: 10.247.71.0/24'
overlay_case
write_overlay <<<"$GOOD_OVERLAY"
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" create
expect "overlay: valid file is added as the last -f and the variable is not passed to Docker" bash -c "
  [[ $RC == 0 ]] && jq -e --arg ov '$OV' 'select(.argv[0]==\"compose\") | (.argv | index(\"create\")) as \$i | .argv[\$i-2:\$i] == [\"-f\", \$ov]' '$T/calls.log' >/dev/null \
  && ! jq -r '.env[]' '$T/calls.log' | grep -q NIBOMO_COMPOSE_NETWORK_FILE"
run compose.sh "$INST" ps
expect "overlay: omitting the overlay for a project created with it is refused (-f consistency)" bash -c "[[ $RC != 0 ]] && grep -q 'was created with Compose files' '$T/out'"
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" ps
expect "overlay: same overlay again is accepted" bash -c "[[ $RC == 0 ]]"

bad_overlay() { # <name> <expected message> <<< content
  local name="$1" msg="$2"
  overlay_case
  write_overlay
  run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" up -d
  expect "overlay: $name refused" refused_without "$msg" '.argv[0]=="compose"'
}
bad_overlay "internal: false override" "only 'ipam:' is allowed" <<'EOF'
networks:
  storage:
    internal: false
EOF
bad_overlay "driver override" "only 'config:' is allowed under ipam" <<'EOF'
networks:
  app:
    ipam:
      driver: host
EOF
bad_overlay "services section" "must start with 'networks:'" <<'EOF'
services:
  gateway:
    networks: [internal]
EOF
bad_overlay "unknown network" "unknown network" <<'EOF'
networks:
  host:
    ipam:
      config:
        - subnet: 10.247.70.0/24
EOF
bad_overlay "public subnet" "is not inside 10/8" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 8.8.8.0/24
EOF
bad_overlay "misaligned CIDR" "not an aligned IPv4 CIDR" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.70.5/24
EOF
bad_overlay "second subnet / gateway entry" "expected '  <network>:'" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.70.0/24
          gateway: 10.247.70.1
EOF
bad_overlay "duplicate network" "listed twice" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.70.0/24
  app:
    ipam:
      config:
        - subnet: 10.247.72.0/24
EOF
bad_overlay "overlapping subnets" "overlap" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.0.0/16
  storage:
    ipam:
      config:
        - subnet: 10.247.71.0/24
EOF
bad_overlay "subnet colliding with an existing Docker network" "overlaps network other_net" <<'EOF'
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.80.0/24
EOF
overlay_case
write_overlay <<<"$GOOD_OVERLAY"
chmod 0664 "$OV"
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" ps
expect "overlay: group-writable file refused" bash -c "[[ $RC != 0 ]] && grep -q 'group- or world-writable' '$T/out'"
overlay_case
write_overlay <<<"$GOOD_OVERLAY"
ln -s "$OV" "$T/net/link.yml"
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$T/net/link.yml" "$INST" ps
expect "overlay: symlink refused" bash -c "[[ $RC != 0 ]] && grep -q 'not a symlink' '$T/out'"
overlay_case
write_overlay <<<"$GOOD_OVERLAY"
chmod 0777 "$T/net"
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" ps
expect "overlay: world-writable parent directory refused" bash -c "[[ $RC != 0 ]] && grep -q 'group- or world-writable' '$T/out'"
new_case
write_overlay <<<"$GOOD_OVERLAY"
set_state '(.containers[]).config_files += ",'"$OV"'"'
run compose.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$INST" ps
expect "overlay: existing project network whose subnet differs from the overlay refused" bash -c "[[ $RC != 0 ]] && grep -q 'the overlay says' '$T/out'"

echo "== backup"
new_case
run backup.sh "$INST" "$T/backups"
B1="$(find "$T/backups" -mindepth 1 -maxdepth 1 -name 'nibomo-backup-nbsrc-*' -type d)"
B1_OBJECTS="$T/volumes/nbsrc_objectdata"
expect "backup: positive run succeeds and publishes one final directory, no .partial" bash -c "[[ $RC == 0 && -n '$B1' ]] && [[ -z \$(find '$T/backups' -name '*.partial') ]]"
SS="$(compose_calls | grep -E '^(stop|start) ')"
WANT_SS="stop auth backend gateway mailpit maintenance mcp worker
stop objectstore
start objectstore
start auth backend gateway mailpit maintenance mcp worker"
expect "backup: every running non-data service (incl. mcp, maintenance, mailpit) stopped, then exactly those started, objectstore first" \
  test "$SS" == "$WANT_SS"
expect "backup: final service states equal the initial ones (jobs untouched)" all_running_as_before
expect "backup: files 0600, directory 0700, checksums verify" bash -c "
  [[ \$(stat -c %a '$B1') == 700 ]] && [[ -z \$(find '$B1' -type f ! -perm 0600) ]] && (cd '$B1' && sha256sum --quiet --strict -c SHA256SUMS)"
expect "backup: manifest records quiescence evidence, endpoint and files" bash -c "
  grep -qx 'quiesced_services=auth backend gateway mailpit maintenance mcp worker' '$B1/manifest.env' \
  && grep -qx 'docker_host=$SOCK' '$B1/manifest.env' && grep -qx 'pg_other_client_sessions_during_dump=0' '$B1/manifest.env' \
  && grep -qx 'latest_migration=$LATEST' '$B1/manifest.env' && grep -qx 'objectstore_file_count=3' '$B1/manifest.env'"
expect "backup: object archive is real and per-file sums match the volume" bash -c "
  tar -tf '$B1/objectstore.tar' | grep -q 'nibomo-media/u1/img one.bin' && (cd '$T/volumes/nbsrc_objectdata' && sha256sum --quiet -c '$B1/objectstore.files.sha256')"
expect "backup: no secret value in any Docker argument, environment or script output" bash -c "
  ! grep -q '$SECRET_VALUE' '$T/calls.log' '$T/out'"
expect "backup: every docker run is --network none and the data volume is mounted read-only" bash -c "
  ! jq -e 'select(.argv[0]==\"run\") | (.argv|index(\"--network\")) as \$i | .argv[\$i+1] != \"none\" or ((.argv | map(select(test(\":/data\"))) | .[0]) | endswith(\":ro\") | not)' '$T/calls.log' >/dev/null"

new_case
set_state '.behavior.fail_start = ["backend"]'
run backup.sh "$INST" "$T/backups"
expect "backup: a failed restart exits non-zero and names the service" bash -c "
  [[ $RC != 0 ]] && grep -q 'NOT restored to their previous running state: .*backend' '$T/out'"
expect "backup: the other stopped services are still started" bash -c "
  for s in auth gateway worker mcp maintenance mailpit objectstore; do [[ \$(jq -r --arg s \$s '.containers[]|select(.service==\$s).state' '$T/state.json') == running ]] || exit 1; done"

new_case
set_state '.db.nbsrc.clients = "1"'
run backup.sh "$INST" "$T/backups"
expect "backup: a remaining PostgreSQL client session refuses the backup (shown) and services are restored" bash -c "
  [[ $RC != 0 ]] && grep -q 'unknown writer is connected' '$T/out' && grep -q 'app=fake-writer' '$T/out' \
  && [[ -z \$(find '$T/backups' -maxdepth 1 -name 'nibomo-backup-*') ]] && ! jq -e 'select(.argv[0]==\"compose\" and (.argv|index(\"pg_dump\")))' '$T/calls.log' >/dev/null"
expect "backup: ... and all services run again" all_running_as_before

new_case
set_state '.behavior.counts_change_during_dump = true'
run backup.sh "$INST" "$T/backups"
expect "backup: counts changing during the dump fail the backup, services restored" bash -c "[[ $RC != 0 ]] && grep -q 'row counts changed during the dump' '$T/out'"
expect "backup: ... services restored after the failure" all_running_as_before

refuse_before_stop() { # <name> <message> <jq state edit>
  new_case
  set_state "$3"
  run backup.sh "$INST" "$T/backups"
  expect "backup: $1 refused before stopping anything" refused_without "$2" '.argv[0]=="compose" and (.argv|index("stop"))'
}
refuse_before_stop "foreign container mounting the object volume" "mounted by containers other than" \
  '.containers += [{"id":"ffff00000001","project":"other","service":"rclone","state":"exited","mounts":["nbsrc_objectdata"],"oneoff":"False"}]'
refuse_before_stop "running one-off container" "one-off container" \
  '.containers += [.containers[0] | .id = "ffff00000002" | .service = "backend" | .oneoff = "True" | .mounts = []]'
refuse_before_stop "running migrate job" "job migrate is running" '(.containers[]|select(.service=="migrate")).state = "running"'
refuse_before_stop "paused service" "is paused" '(.containers[]|select(.service=="worker")).state = "paused"'
refuse_before_stop "stopped objectstore" "objectstore of project nbsrc is not running" '(.containers[]|select(.service=="objectstore")).state = "exited"'
refuse_before_stop "unlabelled / misnamed data volume" "expected exactly one volume nbsrc_pgdata" '.volumes.nbsrc_pgdata.labels = {}'
new_case
ln -s /etc/hostname "$INST/secrets/extra"
run backup.sh "$INST" "$T/backups"
expect "backup: symlink in secrets/ refused before any Docker call" bash -c "[[ $RC != 0 ]] && grep -q 'hold only regular files' '$T/out' && [[ ! -s '$T/calls.log' ]]"
new_case
chmod 0777 "$T/backups"
run backup.sh "$INST" "$T/backups"
expect "backup: world-writable backup parent refused" bash -c "[[ $RC != 0 ]] && grep -q 'group- or world-writable' '$T/out'"
new_case
ln -s /etc/passwd "$T/volumes/nbsrc_objectdata/nibomo-media/link"
run backup.sh "$INST" "$T/backups"
expect "backup: symlink inside the object volume fails the backup, services restored" bash -c "[[ $RC != 0 ]] && grep -q 'unsupported non-regular entries' '$T/out' && [[ -z \$(find '$T/backups' -maxdepth 1 -name 'nibomo-backup-*') ]]"
expect "backup: ... services restored after the failure" all_running_as_before

# RustFS hardlinks a multipart part and its .meta into .rustfs.sys/tmp/.trash; both paths are data.
new_case
HL="$T/volumes/nbsrc_objectdata"
mkdir -p "$HL/nibomo-media/u1/obj/upl" "$HL/.rustfs.sys/tmp/.trash/t1"
head -c 4096 /dev/urandom > "$HL/nibomo-media/u1/obj/upl/part.1"
echo part-meta > "$HL/nibomo-media/u1/obj/upl/part.1.meta"
ln "$HL/nibomo-media/u1/obj/upl/part.1" "$HL/.rustfs.sys/tmp/.trash/t1/part.1"
ln "$HL/nibomo-media/u1/obj/upl/part.1.meta" "$HL/.rustfs.sys/tmp/.trash/t1/part.1.meta"
run backup.sh "$INST" "$T/backups"
B2="$(find "$T/backups" -mindepth 1 -maxdepth 1 -name 'nibomo-backup-nbsrc-*' -type d)"
B2_OBJECTS="$HL"
expect "backup: hardlinked object files back up; every path is a full regular member, no link members" bash -c "
  [[ $RC == 0 && -n '$B2' ]] && grep -qx 'objectstore_file_count=7' '$B2/manifest.env' \
  && ! tar -tvf '$B2/objectstore.tar' | grep -qv '^[-d]' \
  && [[ \$(tar -tvf '$B2/objectstore.tar' | grep -c '^-') == 7 ]] \
  && [[ \$(tar -xOf '$B2/objectstore.tar' ./.rustfs.sys/tmp/.trash/t1/part.1 | sha256sum) == \$(sha256sum < '$HL/nibomo-media/u1/obj/upl/part.1') ]] \
  && (cd '$HL' && sha256sum --quiet --strict -c '$B2/objectstore.files.sha256')"
expect "backup: ... the source volume keeps its hardlinks (read-only archive)" bash -c "
  [[ \$(stat -c %h '$HL/nibomo-media/u1/obj/upl/part.1') == 2 && \$(stat -c %i '$HL/nibomo-media/u1/obj/upl/part.1') == \$(stat -c %i '$HL/.rustfs.sys/tmp/.trash/t1/part.1') ]]"
expect "backup: ... services restored" all_running_as_before

new_case
ln "$T/volumes/nbsrc_objectdata/nibomo-media/u1/xl.meta" "$T/volumes/nbsrc_objectdata/.rustfs.sys/xl.link"
set_state '.behavior.tar_without_hard_dereference = true'
run backup.sh "$INST" "$T/backups"
expect "backup: an archiver without --hard-dereference fails the backup, nothing published, services restored" bash -c "
  [[ $RC != 0 ]] && grep -q 'unrecognized option' '$T/out' && [[ -z \$(find '$T/backups' -maxdepth 1 -name 'nibomo-backup-*' ! -name '*.partial') ]]"
expect "backup: ... services restored after the failure" all_running_as_before

echo "== restore"
# Copies backup B1 into the current case so each restore has its own fake host.
copy_backup() {
  BK="$T/backups/$(basename "$B1")"
  cp -a "$B1" "$BK"
}
restore_case() { new_case; copy_backup; NEW="$T/restored"; }

restore_case
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: positive run verifies objects and rows and starts only postgres" bash -c "
  [[ $RC == 0 ]] && grep -q 'Object-store files match the backup (3 files)' '$T/out' && grep -q 'Row counts match the backup' '$T/out' \
  && [[ \$(jq -r '[.containers[]|select(.project==\"nbnew\" and .state==\"running\").service]|join(\",\")' '$T/state.json') == postgres ]] \
  && ! jq -e 'select(.argv[0]==\"compose\" and (.argv|index(\"up\")))' '$T/calls.log' >/dev/null"
expect "restore: restored object files are byte-identical" bash -c "diff -r '$B1_OBJECTS' '$T/volumes/nbnew_objectdata'"
expect "restore: .env rebound to the new instance, project and endpoint; secrets kept private" bash -c "
  grep -qx 'NIBOMO_INSTANCE_DIR=$NEW' '$NEW/.env' && grep -qx 'NIBOMO_COMPOSE_PROJECT=nbnew' '$NEW/.env' && grep -qx 'NIBOMO_DOCKER_HOST=$SOCK' '$NEW/.env' \
  && [[ \$(stat -c %a '$NEW') == 700 && \$(stat -c %a '$NEW/secrets') == 700 ]] && [[ -z \$(find '$NEW/secrets' -type f ! -perm 0444) ]]"
expect "restore: source project untouched (no stop/start/exec against nbsrc)" bash -c "
  ! jq -e 'select(.argv[0]==\"compose\" and .argv[2]==\"nbsrc\")' '$T/calls.log' >/dev/null"
expect "restore: no secret value in Docker arguments or output" bash -c "! grep -q '$SECRET_VALUE' '$T/calls.log' '$T/out'"

restore_refused() { # <name> <message> [extra restore args]
  local name="$1" msg="$2"; shift 2
  run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK" "$@"
  expect "restore: $name refused, nothing created" refused_without "$msg" '.argv[0]=="compose" or .argv[0]=="run"'
}
restore_case; mkdir -m 0700 "$NEW"; restore_refused "existing instance directory" "already exists; restore needs a new instance directory"
restore_case; set_state '.containers += [{"id":"eeee00000001","project":"nbnew","service":"gateway","state":"exited","mounts":[],"oneoff":"False"}]'
restore_refused "project with containers" "already has containers"
restore_case; set_state '.volumes.nbnew_pgdata = {"labels": {}}'; restore_refused "unlabelled volume with the project's name" "volume nbnew_pgdata already exists"
restore_case; set_state '.networks.nbnew_internal = {"labels": {}, "internal": true, "subnets": []}'; restore_refused "network with the project's name" "network nbnew_internal already exists"
restore_case; echo x >> "$BK/database.dump"; restore_refused "tampered file" "checksum verification failed"
restore_case; ( umask 077; echo x > "$BK/extra.txt" ); restore_refused "unexpected extra file" "must contain exactly"
restore_case; sed -i '/roles.sql/d' "$BK/SHA256SUMS"; restore_refused "SHA256SUMS missing an entry" "does not list exactly"
restore_case; chmod 0644 "$BK/roles.sql"; restore_refused "group/world-readable backup file" "readable or writable by others"
resign() { (cd "$BK" && sha256sum -- manifest.env roles.sql database.dump verify-counts.txt objectstore.tar objectstore.files.sha256 instance.tar > SHA256SUMS); }
restore_case
mkdir -p "$T/evil/secrets" && ln -s /etc/shadow "$T/evil/secrets/db_owner_password" && cp "$INST/.env" "$T/evil/.env"
( umask 077; tar -C "$T/evil" -cf "$BK/instance.tar" .env secrets ); resign
restore_refused "instance.tar with a symlink" "links, devices or other special members"
restore_case
( cd "$T" && umask 077 && mkdir -p x && echo pwn > x/f && tar -cf "$BK/instance.tar" --transform 's|^x/f|../escape|' x/f ); resign
restore_refused "instance.tar with a .. member" ".. member"
restore_case
( cd "$T" && umask 077 && mkdir -p y && echo z > y/a && tar -cf "$BK/instance.tar" -C y a ); resign
restore_refused "instance.tar with an unexpected member" "unexpected member"
restore_case
( cd "$T" && umask 077 && mkdir -p o && echo z > o/a && tar -cf "$BK/objectstore.tar" --transform 's|^o/a|../../a|' o/a ); resign
restore_refused "objectstore.tar with a .. member" ".. member"
restore_case
( cd "$T" && umask 077 && mkdir -p h && echo z > h/a && ln h/a h/b && tar -cf "$BK/objectstore.tar" -C h a b ); resign
restore_refused "objectstore.tar with a hardlink member" "links, devices or other special members"
restore_case
( cd "$T" && umask 077 && mkdir -p e && echo z > e/a && ln e/a e/b \
  && tar -cf "$BK/objectstore.tar" -C e --transform 's|^a$|../../etc/passwd|' a b ); resign
restore_refused "objectstore.tar with a hardlink to an escaping name" "links, devices or other special members"
restore_case
( cd "$T" && umask 077 && mkdir -p s && ln -s /etc/shadow s/l && tar -cf "$BK/objectstore.tar" -C s l ); resign
restore_refused "objectstore.tar with a symlink member" "links, devices or other special members"

new_case; BK="$T/backups/$(basename "$B2")"; cp -a "$B2" "$BK"; NEW="$T/restored"
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: hardlink-materialised backup restores byte-identical independent files" bash -c "
  [[ $RC == 0 ]] && grep -q 'Object-store files match the backup (7 files)' '$T/out' \
  && diff -r '$B2_OBJECTS' '$T/volumes/nbnew_objectdata' \
  && [[ -z \$(find '$T/volumes/nbnew_objectdata' -type f -links +1) && -z \$(find '$T/volumes/nbnew_objectdata' ! -type f ! -type d) ]]"

restore_case
run restore.sh "$BK" "$NEW" nbsrc --docker-host "$SOCK"
expect "restore: source project name refused without --allow-source-project-name" bash -c "[[ $RC != 0 ]] && grep -q 'restore into a separate project' '$T/out'"
restore_case; restore_refused "--start with --allow-source-project-name" "refused with --allow-source-project-name" --allow-source-project-name --start --gateway-port 19000
restore_case; restore_refused "--start without --gateway-port" "requires --gateway-port" --start
restore_case; restore_refused "--start on the source's gateway port" "is the source instance's port" --start --gateway-port 18088
restore_case; run restore.sh DOCKER_HOST=unix:///var/run/docker.sock "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: shell DOCKER_HOST differing from --docker-host refused before any Docker call" bash -c "[[ $RC != 0 ]] && grep -q 'differs from the instance endpoint' '$T/out' && [[ ! -s '$T/calls.log' ]]"

restore_case
set_state '.behavior.preseed_new_volume = ["objectdata"]'
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: a new volume that already holds files is refused before extraction" bash -c "
  [[ $RC != 0 ]] && grep -q 'already holds files' '$T/out' && ! jq -e 'select(.argv[0]==\"run\" and (.argv|index(\"-xpf\")))' '$T/calls.log' >/dev/null"
restore_case
set_state '.behavior.corrupt_extract = true'
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: object files differing after extraction stop the restore before PostgreSQL" bash -c "
  [[ $RC != 0 ]] && grep -q 'restored object-store files differ' '$T/out' && ! jq -e 'select(.argv[0]==\"compose\" and (.argv|index(\"start\")))' '$T/calls.log' >/dev/null"
restore_case
set_state '.db.nbnew = {"counts": "", "fresh": "1|0|0|0", "clients": "0"}'
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: a non-pristine cluster is refused before roles and pg_restore" bash -c "
  [[ $RC != 0 ]] && grep -q 'not pristine' '$T/out' && ! jq -e 'select(.argv[0]==\"compose\" and (.argv|index(\"pg_restore\")) and (.argv|index(\"-l\")|not))' '$T/calls.log' >/dev/null"
restore_case
set_state '.behavior.restore_counts_mismatch = true'
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK" --start --gateway-port 19088
expect "restore: row-count mismatch fails and --start never starts consumers" bash -c "
  [[ $RC != 0 ]] && grep -q 'row counts differ' '$T/out' && ! jq -e 'select(.argv[0]==\"compose\" and (.argv|index(\"up\")))' '$T/calls.log' >/dev/null"
restore_case
run restore.sh "$BK" "$NEW" nbnew --docker-host "$SOCK" --start --gateway-port 19088
expect "restore: --start runs 'up' only after every verification, on the new project and port" bash -c "
  [[ $RC == 0 ]] && grep -qx 'NIBOMO_GATEWAY_PORT=19088' '$NEW/.env' \
  && T='$T' && last_up=\$(grep -n '\"up\"' '$T/calls.log' | cut -d: -f1) && last_verify=\$(grep -n 'schema_migrations.latest' '$T/calls.log' | tail -n1 | cut -d: -f1) \
  && [[ -n \$last_up && \$last_up -gt \$last_verify ]] && [[ \$(jq -r 'select(.argv|index(\"up\")) | .argv[2]' '$T/calls.log') == nbnew ]]"
expect "restore: ... and the source project's containers were never addressed" bash -c "! jq -e 'select(.argv[0]==\"compose\" and .argv[2]==\"nbsrc\")' '$T/calls.log' >/dev/null"

restore_case
write_overlay <<'EOF'
networks:
  internal:
    ipam:
      config:
        - subnet: 172.30.0.0/24
EOF
run restore.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: overlay subnet colliding with the source's network is refused before create" bash -c "
  [[ $RC != 0 ]] && grep -q 'overlaps network nbsrc_internal' '$T/out' && ! jq -e 'select(.argv[0]==\"compose\")' '$T/calls.log' >/dev/null"
restore_case
write_overlay <<'EOF'
networks:
  internal:
    ipam:
      config:
        - subnet: 10.247.90.0/24
EOF
run restore.sh NIBOMO_COMPOSE_NETWORK_FILE="$OV" "$BK" "$NEW" nbnew --docker-host "$SOCK"
expect "restore: with a free overlay every compose call carries the overlay" bash -c "
  [[ $RC == 0 ]] && [[ \$(jq -r --arg ov '$OV' 'select(.argv[0]==\"compose\") | (.argv|index(\$ov)) != null' '$T/calls.log' | sort -u) == true ]]"

echo
echo "passed: ${passes}  failed: ${failures}"
[[ "$failures" == 0 ]]
