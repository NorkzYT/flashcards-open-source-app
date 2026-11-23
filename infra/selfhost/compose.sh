#!/usr/bin/env bash
# The one supported way to run Docker Compose for a standalone instance. It derives the project
# name, environment file, Docker endpoint and Compose files from the instance directory, so status,
# logs, updates, backup and restore always address the same project and volumes; compose-lib.sh
# holds the binding and refusal rules.
#
#   bash sourc/infra/selfhost/compose.sh /opt/docker/containers/nibomo ps
#   bash sourc/infra/selfhost/compose.sh /opt/docker/containers/nibomo up -d --build
#
# AI: NIBOMO_AI_PROVIDER=openai adds compose.ai.yml and the `ai` profile (worker), and requires a
# non-empty secrets/openai_api_key; `none` (default) leaves chat unavailable with a clear error.
# NIBOMO_AI_PROXY_BASE_URL (with `openai`) adds compose.ai-proxy.yml: backend/worker reach the proxy on
# NIBOMO_AI_PROXY_NETWORK instead of egress.
# Development mailbox: NIBOMO_DEV_MAILBOX=true adds compose.devmail.yml, refused for project nibomo.
# Network subnets: NIBOMO_COMPOSE_NETWORK_FILE=<overlay> (shell, optional) is added last.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=compose-lib.sh
. "${SCRIPT_DIR}/compose-lib.sh"

INSTANCE_DIR="${1:?usage: compose.sh <absolute-instance-dir> <docker compose arguments...>}"
shift
nb_check_shell_env
nb_resolve_instance "$INSTANCE_DIR"
nb_check_binding
nb_compose "$@"
