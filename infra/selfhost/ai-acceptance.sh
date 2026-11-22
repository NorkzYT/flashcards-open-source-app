#!/usr/bin/env bash
# TEST ONLY: AI chat acceptance (error, labeled SIMULATED card-creation turn, retry, cancel, exact lease,
# worker stop/kill + restart, personal-key sealing) on a disposable instance with the synthetic provider
# (compose.ai-test.yml, ai-test-provider.mjs), consuming the live SSE stream like the clients do. It
# creates fixture accounts and cards; with --allow-worker-stop it also stops, kills and restarts that
# instance's worker, and SIGKILLs and restarts its backend once mid-stream. It never runs
# `down`, removes containers or volumes, or reaches a real provider.
#
#   bash sourc/infra/selfhost/ai-acceptance.sh <absolute-test-instance-dir> [--build] [--allow-worker-stop]
#     [--fixture-compose=<absolute-file>]
#
# --fixture-compose appends one test-only Compose file last, e.g. explicit `networks.<name>.ipam` subnets
# when the Docker default address pools are exhausted; it may not define services, volumes or secrets.
#
# Funding follows the instance .env: NIBOMO_AI_PROVIDER=openai (operator funding; NIBOMO_AI_PERSONAL_KEYS
# =sealed and secrets/openai_api_key a synthetic sk-nibomo-test-operator-<uuid>) or user-key (no operator
# key: secrets/openai_api_key absent or empty; secrets/chat_credential_key and NIBOMO_INSTANCE_ID set).
# Always refused unless NIBOMO_COMPOSE_PROJECT is a test project (not nibomo), NIBOMO_DEV_MAILBOX=true,
# the gateway binds loopback and NIBOMO_ALLOWED_EMAIL_DOMAINS lists a test domain.
# Requires docker compose, sha256sum and node >= 22 on the host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_DIR="${1:?usage: ai-acceptance.sh <absolute-test-instance-dir> [--build] [--allow-worker-stop] [--fixture-compose=<absolute-file>]}"
shift
BUILD=()
ALLOW_WORKER_STOP=no
FIXTURE_COMPOSE=()
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=(--build) ;;
    --allow-worker-stop) ALLOW_WORKER_STOP=yes ;;
    --fixture-compose=/*)
      fixture="${arg#--fixture-compose=}"
      [[ -f "$fixture" && "$fixture" =~ ^[A-Za-z0-9/._-]+$ ]] || { echo "ERROR: fixture compose file ${fixture} not found" >&2; exit 2; }
      ! grep -qE '^(services|volumes|secrets|configs|include):' "$fixture" \
        || { echo "ERROR: the fixture compose file may only define networks" >&2; exit 2; }
      FIXTURE_COMPOSE=(-f "$fixture")
      ;;
    *) echo "ERROR: unknown argument ${arg}" >&2; exit 2 ;;
  esac
done
[[ "$INSTANCE_DIR" == /* && "$INSTANCE_DIR" =~ ^[A-Za-z0-9/._-]+$ ]] \
  || { echo "ERROR: instance directory must be an absolute path of letters, digits, / . _ -" >&2; exit 2; }
ENV_FILE="${INSTANCE_DIR}/.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} not found" >&2; exit 2; }
get() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
refuse() { echo "REFUSED: $*" >&2; exit 2; }

PROJECT="$(get NIBOMO_COMPOSE_PROJECT)"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ && "$PROJECT" != nibomo ]] || refuse "NIBOMO_COMPOSE_PROJECT must be a test project, not nibomo"
[[ "$(get NIBOMO_INSTANCE_DIR)" == "$INSTANCE_DIR" ]] || refuse "NIBOMO_INSTANCE_DIR does not match ${INSTANCE_DIR}"
[[ "$(get NIBOMO_DEV_MAILBOX)" == true ]] || refuse "NIBOMO_DEV_MAILBOX=true is required (disposable test instance)"
BIND="$(get NIBOMO_GATEWAY_BIND)"
[[ -z "$BIND" || "$BIND" == 127.0.0.1 ]] || refuse "the gateway must bind 127.0.0.1"
EMAIL_DOMAIN="$(get NIBOMO_ALLOWED_EMAIL_DOMAINS | cut -d, -f1)"
[[ -n "$EMAIL_DOMAIN" ]] || refuse "NIBOMO_ALLOWED_EMAIL_DOMAINS must list a test domain"
[[ -s "${INSTANCE_DIR}/secrets/chat_credential_key" ]] || refuse "secrets/chat_credential_key is missing (run setup.sh)"

OPERATOR_KEY_FILE="${INSTANCE_DIR}/secrets/openai_api_key"
case "$(get NIBOMO_AI_PROVIDER)" in
  openai)
    FUNDING=operator
    AI_OVERLAY="${SCRIPT_DIR}/compose.ai.yml"
    [[ "$(get NIBOMO_AI_PERSONAL_KEYS)" == sealed ]] || refuse "NIBOMO_AI_PERSONAL_KEYS=sealed is required with operator funding"
    OPERATOR_KEY="$(cat "$OPERATOR_KEY_FILE")"
    [[ "$OPERATOR_KEY" =~ ^sk-nibomo-test-operator-[0-9a-f-]{36}$ ]] \
      || refuse "secrets/openai_api_key must be a synthetic sk-nibomo-test-operator-<uuid> key"
    OPERATOR_KEY_SHA256="$(printf '%s' "$OPERATOR_KEY" | sha256sum | cut -d' ' -f1)"
    ;;
  user-key)
    FUNDING=user-key
    AI_OVERLAY="${SCRIPT_DIR}/compose.ai-user-key.yml"
    [[ -z "$(get NIBOMO_AI_PERSONAL_KEYS)" || "$(get NIBOMO_AI_PERSONAL_KEYS)" == sealed ]] \
      || refuse "NIBOMO_AI_PERSONAL_KEYS must be empty or sealed with user-key funding"
    [[ "$(get NIBOMO_INSTANCE_ID)" =~ ^[A-Za-z0-9._:-]{1,200}$ ]] || refuse "NIBOMO_INSTANCE_ID is required with user-key funding"
    [[ ! -s "$OPERATOR_KEY_FILE" ]] || refuse "user-key funding must have no operator key (secrets/openai_api_key is non-empty)"
    OPERATOR_KEY=""
    OPERATOR_KEY_SHA256=none
    ;;
  *) refuse "NIBOMO_AI_PROVIDER must be openai or user-key" ;;
esac

compose=(compose -p "$PROJECT" --env-file "$ENV_FILE" -f "${SCRIPT_DIR}/compose.yml" -f "$AI_OVERLAY"
  -f "${SCRIPT_DIR}/compose.devmail.yml" -f "${SCRIPT_DIR}/compose.ai-test.yml" "${FIXTURE_COMPOSE[@]}" --profile ai)

# Interpolated into compose.ai-test.yml by every compose call, here and in ai-acceptance.mjs.
export AI_TEST_FUNDING="$FUNDING" AI_TEST_OPERATOR_KEY_SHA256="$OPERATOR_KEY_SHA256"

docker "${compose[@]}" up -d --wait --wait-timeout 300 "${BUILD[@]}"

# Backend and worker must have no route to a real provider: only the internal test network.
for service in backend worker; do
  networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
    "$(docker "${compose[@]}" ps -q "$service")")"
  [[ " $networks" != *" ${PROJECT}_egress "* ]] || { echo "FAIL: ${service} is attached to ${PROJECT}_egress" >&2; exit 1; }
  echo "${service} networks: ${networks}"
done

compose_json="$(printf '"%s",' "${compose[@]}")"
AI_TEST_COMPOSE="[${compose_json%,}]" \
AI_TEST_GATEWAY="http://127.0.0.1:$(get NIBOMO_GATEWAY_PORT | grep -E '^[0-9]+$' || echo 8088)" \
AI_TEST_BASE_DOMAIN="$(get NIBOMO_BASE_DOMAIN)" \
AI_TEST_APP_HOST="$(get NIBOMO_APP_HOST)" \
AI_TEST_MAILBOX="http://127.0.0.1:$(get NIBOMO_DEVMAIL_UI_PORT | grep -E '^[0-9]+$' || echo 18025)" \
AI_TEST_EMAIL_DOMAIN="$EMAIL_DOMAIN" \
AI_TEST_OPERATOR_KEY="$OPERATOR_KEY" \
AI_TEST_ALLOW_WORKER_STOP="$ALLOW_WORKER_STOP" \
  exec node "${SCRIPT_DIR}/ai-acceptance.mjs"
