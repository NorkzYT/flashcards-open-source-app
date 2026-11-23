# shellcheck shell=bash disable=SC2034
# Shared by compose.sh, backup.sh and restore.sh (sourced, not executed). It binds every Docker and
# Compose call to one explicit identity: the instance directory and its .env, the Compose project,
# the Docker endpoint (a local Unix socket) and the exact Compose file list, and refuses anything
# that could silently point a command somewhere else.
#
# Precedence rules this file enforces:
# - Settings come only from <instance>/.env. Docker Compose lets shell variables override the env
#   file, so any NIBOMO_* (except NIBOMO_COMPOSE_NETWORK_FILE), COMPOSE_*, DOCKER_CONTEXT or
#   DOCKER_CONFIG variable in the calling shell is refused, and Docker runs with a scrubbed
#   environment (PATH, HOME, locale, TERM, TMPDIR and the resolved DOCKER_HOST only).
# - The Docker endpoint is NIBOMO_DOCKER_HOST from .env (default unix:///var/run/docker.sock). A
#   shell DOCKER_HOST that differs from it is refused, never silently replaced.
# - Existing containers of the project must carry exactly this file list and env file in their
#   Compose labels; a project started from another checkout, instance or overlay is refused.
# - NIBOMO_COMPOSE_NETWORK_FILE (shell only, optional): absolute path to a network overlay that
#   only assigns private IPv4 subnets to the stack's networks, for hosts whose default Docker
#   address pools are exhausted. See docs/self-hosting.md ("Explicit network subnets").

NB_DEFAULT_DOCKER_HOST="unix:///var/run/docker.sock"
# Compose network keys and whether each must be an internal (no outbound route) network.
declare -A NB_NETWORK_INTERNAL=([internal]=true [app]=true [storage]=true [edge]=false [egress]=false [ai]=true)
# Derived settings handed to Compose next to the scrubbed environment (nb_resolve_instance); never read
# from the calling shell, which nb_check_shell_env already refuses for NIBOMO_*.
NB_COMPOSE_ENV=()

nb_die() {
  echo "ERROR: $*" >&2
  exit 2
}

nb_safe_abs_path() {
  [[ "$1" == /* && "$1" =~ ^[A-Za-z0-9/._-]+$ && "$1" != *..* && "$1" != *//* ]]
}

# Refuse shell variables that Docker Compose would let override the instance .env or that select
# another Docker endpoint.
nb_check_shell_env() {
  local name
  while IFS= read -r name; do
    case "$name" in
      NIBOMO_COMPOSE_NETWORK_FILE) ;;
      NIBOMO_* | COMPOSE_* | DOCKER_CONTEXT | DOCKER_CONFIG)
        nb_die "shell variable ${name} is set; it would override the instance .env or the Docker endpoint. Unset it (settings belong in <instance>/.env)"
        ;;
    esac
  done < <(compgen -e)
}

# One setting from an env file. Refuses a key that appears more than once or in any form other than
# a plain KEY=value line (Compose also reads `export KEY=`, spaces and quotes).
nb_env_get() {
  local file="$1" key="$2" matches
  matches="$(grep -cE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" || true)"
  [[ "$matches" -le 1 ]] || nb_die "${key} appears ${matches} times in ${file}; keep exactly one"
  if [[ "$matches" == 1 ]]; then
    grep -qE "^${key}=" "$file" || nb_die "${key} in ${file} must be a plain ${key}=value line"
    grep -E "^${key}=" "$file" | cut -d= -f2-
  fi
}

nb_validate_docker_host() {
  local value="$1" socket
  [[ "$value" =~ ^unix:///[A-Za-z0-9/._-]+$ && "$value" != *..* ]] \
    || nb_die "Docker endpoint ${value} must be unix:///<absolute socket path>; remote or TCP endpoints are refused"
  socket="${value#unix://}"
  [[ -S "$socket" && ! -L "$socket" ]] || nb_die "Docker endpoint ${socket} is not a Unix socket"
  local owner
  owner="$(stat -c %u "$socket")"
  [[ "$owner" == 0 || "$owner" == "$(id -u)" ]] || nb_die "Docker socket ${socket} is owned by uid ${owner}, not root or you"
  if [[ -n "${DOCKER_HOST:-}" && "$DOCKER_HOST" != "$value" ]]; then
    nb_die "shell DOCKER_HOST=${DOCKER_HOST} differs from the instance endpoint ${value}; unset it or set NIBOMO_DOCKER_HOST in .env"
  fi
}

nb_set_docker_host() {
  nb_validate_docker_host "$1"
  NB_DOCKER_HOST="$1"
}

# Docker with a scrubbed environment and the one resolved endpoint.
nb_docker() {
  [[ -n "${NB_DOCKER_HOST:-}" ]] || nb_die "internal: Docker endpoint not resolved"
  env -i PATH="$PATH" HOME="${HOME:-/nonexistent}" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
    TMPDIR="${TMPDIR:-/tmp}" DOCKER_HOST="$NB_DOCKER_HOST" "${NB_COMPOSE_ENV[@]}" docker "$@"
}

nb_compose() {
  [[ ${#NB_COMPOSE_ARGS[@]} -gt 0 ]] || nb_die "internal: instance not resolved"
  nb_docker compose "${NB_COMPOSE_ARGS[@]}" "$@"
}

# --- IPv4 helpers for the network overlay ---------------------------------------------------------

nb_ip_to_int() {
  local IFS=. octet value=0
  # shellcheck disable=SC2206
  local -a octets=($1)
  [[ ${#octets[@]} == 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ && "$octet" -le 255 ]] || return 1
    value=$(((value << 8) | octet))
  done
  printf '%s' "$value"
}

# "<first> <last>" for an aligned IPv4 CIDR; fails for anything else (including IPv6).
nb_cidr_range() {
  [[ "$1" =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || return 1
  local base prefix="${BASH_REMATCH[2]}" size
  base="$(nb_ip_to_int "${BASH_REMATCH[1]}")" || return 1
  [[ "$prefix" -le 32 ]] || return 1
  size=$((1 << (32 - prefix)))
  ((base % size == 0)) || return 1
  printf '%s %s' "$base" "$((base + size - 1))"
}

nb_ranges_overlap() { (($1 <= $4 && $3 <= $2)); }

nb_cidr_is_private() {
  local range first last private pf pl
  range="$(nb_cidr_range "$1")" || return 1
  read -r first last <<<"$range"
  for private in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    read -r pf pl <<<"$(nb_cidr_range "$private")"
    if ((first >= pf && last <= pl)); then return 0; fi
  done
  return 1
}

# --- Network overlay ------------------------------------------------------------------------------

# Validates the overlay file and fills NB_NETWORK_SUBNETS[<network key>]=<cidr>. The only accepted
# shape (comments and blank lines aside) is, per network, exactly:
#   networks:
#     <internal|app|storage|edge|egress|ai>:
#       ipam:
#         config:
#           - subnet: <private IPv4 CIDR, /16 to /28>
# Anything else (driver, internal, external, name, driver_opts, gateway, services, ...) is refused, so
# the overlay cannot change isolation, attachments or project identity.
declare -A NB_NETWORK_SUBNETS=()
nb_load_network_file() {
  local path="$1" instance_dir="$2"
  nb_safe_abs_path "$path" || nb_die "NIBOMO_COMPOSE_NETWORK_FILE must be an absolute path of letters, digits, / . _ -"
  [[ ! -L "$path" && -f "$path" ]] || nb_die "NIBOMO_COMPOSE_NETWORK_FILE ${path} must be a regular file, not a symlink"
  case "$path" in
    "${instance_dir}/secrets/"*) nb_die "the network overlay must not live in secrets/" ;;
  esac
  local target owner mode
  for target in "$path" "$(dirname "$path")"; do
    owner="$(stat -c %u "$target")"
    mode="$(stat -c %a "$target")"
    [[ "$owner" == 0 || "$owner" == "$(id -u)" ]] || nb_die "${target} must be owned by root or you (uid ${owner})"
    (((8#$mode & 8#022) == 0)) || nb_die "${target} is group- or world-writable (mode ${mode}); use chmod go-w"
  done

  NB_NETWORK_SUBNETS=()
  local line state=start current="" lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    case "$state" in
      start)
        [[ "$line" == "networks:" ]] || nb_die "${path}:${lineno}: the overlay must start with 'networks:' and contain nothing else"
        state=network
        ;;
      network)
        [[ "$line" =~ ^\ \ ([a-z]+):$ ]] || nb_die "${path}:${lineno}: expected '  <network>:'"
        current="${BASH_REMATCH[1]}"
        [[ -n "${NB_NETWORK_INTERNAL[$current]:-}" ]] \
          || nb_die "${path}:${lineno}: unknown network ${current} (allowed: ${!NB_NETWORK_INTERNAL[*]})"
        [[ -z "${NB_NETWORK_SUBNETS[$current]:-}" ]] || nb_die "${path}:${lineno}: network ${current} listed twice"
        state=ipam
        ;;
      ipam)
        [[ "$line" == "    ipam:" ]] || nb_die "${path}:${lineno}: only 'ipam:' is allowed under ${current}"
        state=config
        ;;
      config)
        [[ "$line" == "      config:" ]] || nb_die "${path}:${lineno}: only 'config:' is allowed under ipam"
        state=subnet
        ;;
      subnet)
        [[ "$line" =~ ^\ \ \ \ \ \ \ \ -\ subnet:\ ([0-9./]+)$ ]] \
          || nb_die "${path}:${lineno}: only one '- subnet: <cidr>' entry is allowed per network"
        local cidr="${BASH_REMATCH[1]}" prefix
        nb_cidr_range "$cidr" >/dev/null || nb_die "${path}:${lineno}: ${cidr} is not an aligned IPv4 CIDR"
        prefix="${cidr#*/}"
        [[ "$prefix" -ge 16 && "$prefix" -le 28 ]] || nb_die "${path}:${lineno}: ${cidr}: prefix must be /16 to /28"
        nb_cidr_is_private "$cidr" || nb_die "${path}:${lineno}: ${cidr} is not inside 10/8, 172.16/12 or 192.168/16"
        NB_NETWORK_SUBNETS[$current]="$cidr"
        state=network
        ;;
    esac
  done < "$path"
  [[ "$state" == network && ${#NB_NETWORK_SUBNETS[@]} -gt 0 ]] || nb_die "${path}: incomplete or empty network overlay"

  local a b ra rb
  for a in "${!NB_NETWORK_SUBNETS[@]}"; do
    for b in "${!NB_NETWORK_SUBNETS[@]}"; do
      [[ "$a" < "$b" ]] || continue
      ra="$(nb_cidr_range "${NB_NETWORK_SUBNETS[$a]}")"
      rb="$(nb_cidr_range "${NB_NETWORK_SUBNETS[$b]}")"
      # shellcheck disable=SC2086
      if nb_ranges_overlap $ra $rb; then nb_die "${path}: subnets of ${a} and ${b} overlap"; fi
    done
  done
}

# --- AI proxy settings ----------------------------------------------------------------------------

# Prints the first problem with the AI model/proxy settings, or nothing when they are valid. Shared by
# compose.sh (enforced on every call) and `setup.sh --check`. The backend re-validates both values at start.
#   nb_ai_proxy_problem <provider> <personal_keys> <project> <base_url> <network> <egress> <model>
nb_ai_proxy_problem() {
  local provider="$1" personal="$2" project="$3" url="$4" network="$5" egress="$6" model="$7"
  if [[ -n "$model" && ! "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]]; then
    echo "NIBOMO_AI_MODEL must be 1-128 letters, digits and . _ : / - starting with a letter or digit"; return
  fi
  if [[ -z "$url" ]]; then
    [[ -z "$network" && -z "$egress" ]] \
      || echo "NIBOMO_AI_PROXY_NETWORK and NIBOMO_AI_PROXY_NETWORK_EGRESS need NIBOMO_AI_PROXY_BASE_URL"
    return
  fi
  # A proxy receives every key the API forwards, so it is limited to the operator's own key.
  [[ "$provider" == openai ]] || { echo "NIBOMO_AI_PROXY_BASE_URL needs NIBOMO_AI_PROVIDER=openai"; return; }
  [[ -z "$personal" ]] \
    || { echo "NIBOMO_AI_PROXY_BASE_URL needs NIBOMO_AI_PERSONAL_KEYS empty: personal keys would be sent to the proxy"; return; }
  # No credentials, query or fragment: the URL lands in container config and worker logs.
  [[ "$url" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*/?$ ]] \
    || { echo "NIBOMO_AI_PROXY_BASE_URL must be http(s)://host[:port][/path] without credentials, query or fragment"; return; }
  # ai-relay answers under this name on the project's `ai` network and dials <host>.<network>, which
  # Docker DNS resolves only for a container on that network: a single label, not a project service.
  local host port
  host="$(nb_ai_proxy_host "$url")"; port="$(nb_ai_proxy_port "$url")"
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ && ! "$host" =~ ^[0-9]+$ ]] \
    || { echo "NIBOMO_AI_PROXY_BASE_URL host must be the proxy container's name on NIBOMO_AI_PROXY_NETWORK (one DNS label, no dots or IP address)"; return; }
  case "$host" in
    localhost | ai-relay | backend | worker | postgres | objectstore | objectstore-init | migrate | auth | mcp | media-maintenance | gateway | mailpit)
      echo "NIBOMO_AI_PROXY_BASE_URL host ${host} is reserved by this stack; use the proxy container's own name"; return ;;
  esac
  (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo "NIBOMO_AI_PROXY_BASE_URL port must be 1-65535"; return; }
  [[ "$network" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
    || { echo "NIBOMO_AI_PROXY_BASE_URL needs NIBOMO_AI_PROXY_NETWORK, the existing Docker network the proxy is on"; return; }
  [[ "$network" != "${project}_"* ]] \
    || { echo "NIBOMO_AI_PROXY_NETWORK must not be one of project ${project}'s own networks"; return; }
  [[ -z "$egress" || "$egress" == accepted ]] || echo "NIBOMO_AI_PROXY_NETWORK_EGRESS must be empty or accepted"
}

# Host and port of an already validated proxy URL (port defaults to the scheme's).
nb_ai_proxy_host() { local rest="${1#*://}"; rest="${rest%%/*}"; printf '%s' "${rest%%:*}"; }
nb_ai_proxy_port() {
  local rest="${1#*://}"; rest="${rest%%/*}"
  if [[ "$rest" == *:* ]]; then printf '%s' "$((10#${rest##*:}))"
  elif [[ "$1" == https://* ]]; then printf 443; else printf 80; fi
}

# --- Instance resolution --------------------------------------------------------------------------

# Sets NB_INSTANCE_DIR, NB_ENV_FILE, NB_PROJECT, NB_DOCKER_HOST, NB_COMPOSE_ARGS and NB_CONFIG_FILES
# (the comma-joined -f list Compose records in its labels).
nb_resolve_instance() {
  local selfhost_dir instance_dir="$1"
  selfhost_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  nb_safe_abs_path "$instance_dir" \
    || nb_die "instance directory must be an absolute path of letters, digits, / . _ - (no .., no //)"
  instance_dir="${instance_dir%/}"
  NB_INSTANCE_DIR="$instance_dir"
  NB_ENV_FILE="${instance_dir}/.env"
  [[ -f "$NB_ENV_FILE" && ! -L "$NB_ENV_FILE" ]] || nb_die "${NB_ENV_FILE} not found (or is a symlink); run setup.sh first"

  # Read every setting into a variable first: a refusal inside $(...) must stop the script.
  local env_instance env_network env_project env_docker_host env_ai env_mailbox env_personal env_model problem
  env_instance="$(nb_env_get "$NB_ENV_FILE" NIBOMO_INSTANCE_DIR)"
  env_network="$(nb_env_get "$NB_ENV_FILE" NIBOMO_COMPOSE_NETWORK_FILE)"
  env_project="$(nb_env_get "$NB_ENV_FILE" NIBOMO_COMPOSE_PROJECT)"
  env_docker_host="$(nb_env_get "$NB_ENV_FILE" NIBOMO_DOCKER_HOST)"
  env_ai="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_PROVIDER)"
  env_mailbox="$(nb_env_get "$NB_ENV_FILE" NIBOMO_DEV_MAILBOX)"
  env_personal="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_PERSONAL_KEYS)"
  env_model="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_MODEL)"
  NB_AI_PROXY_BASE_URL="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_PROXY_BASE_URL)"
  NB_AI_PROXY_NETWORK="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_PROXY_NETWORK)"
  NB_AI_PROXY_EGRESS="$(nb_env_get "$NB_ENV_FILE" NIBOMO_AI_PROXY_NETWORK_EGRESS)"
  [[ "$env_instance" == "$instance_dir" ]] \
    || nb_die "NIBOMO_INSTANCE_DIR in ${NB_ENV_FILE} does not match ${instance_dir}"
  [[ -z "$env_network" ]] \
    || nb_die "NIBOMO_COMPOSE_NETWORK_FILE is a per-host shell setting; remove it from ${NB_ENV_FILE}"
  NB_PROJECT="$env_project"
  NB_PROJECT="${NB_PROJECT:-nibomo}"
  [[ "$NB_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || nb_die "invalid NIBOMO_COMPOSE_PROJECT"

  nb_set_docker_host "${env_docker_host:-$NB_DEFAULT_DOCKER_HOST}"

  [[ -s "${instance_dir}/secrets/chat_live_auth_secret" ]] \
    || nb_die "secrets/chat_live_auth_secret is missing (AI chat live-stream key); run setup.sh"
  local files=("${selfhost_dir}/compose.yml") profiles=()
  case "$env_ai" in
    "" | none) ;;
    openai)
      [[ -s "${instance_dir}/secrets/openai_api_key" ]] \
        || nb_die "NIBOMO_AI_PROVIDER=openai but secrets/openai_api_key is empty"
      files+=("${selfhost_dir}/compose.ai.yml")
      profiles+=(--profile ai)
      ;;
    user-key)
      [[ -s "${instance_dir}/secrets/chat_credential_key" ]] \
        || nb_die "NIBOMO_AI_PROVIDER=user-key requires secrets/chat_credential_key; run setup.sh"
      files+=("${selfhost_dir}/compose.ai-user-key.yml")
      profiles+=(--profile ai)
      ;;
    *) nb_die "NIBOMO_AI_PROVIDER must be none, openai or user-key" ;;
  esac
  problem="$(nb_ai_proxy_problem "$env_ai" "$env_personal" "$NB_PROJECT" "$NB_AI_PROXY_BASE_URL" \
    "$NB_AI_PROXY_NETWORK" "$NB_AI_PROXY_EGRESS" "$env_model")"
  [[ -z "$problem" ]] || nb_die "$problem"
  NB_COMPOSE_ENV=()
  if [[ -n "$NB_AI_PROXY_BASE_URL" ]]; then
    files+=("${selfhost_dir}/compose.ai-proxy.yml")
    NB_COMPOSE_ENV=("NIBOMO_AI_RELAY_HOST=$(nb_ai_proxy_host "$NB_AI_PROXY_BASE_URL")"
      "NIBOMO_AI_RELAY_PORT=$(nb_ai_proxy_port "$NB_AI_PROXY_BASE_URL")" "NIBOMO_AI_RELAY_AI_NETWORK=${NB_PROJECT}_ai")
  fi
  if [[ "$env_mailbox" == "true" ]]; then
    [[ "$NB_PROJECT" != "nibomo" ]] \
      || nb_die "the development mailbox is for isolated test projects, never project nibomo"
    files+=("${selfhost_dir}/compose.devmail.yml")
  fi
  NB_NETWORK_FILE="${NIBOMO_COMPOSE_NETWORK_FILE:-}"
  NB_NETWORK_SUBNETS=()
  if [[ -n "$NB_NETWORK_FILE" ]]; then
    nb_load_network_file "$NB_NETWORK_FILE" "$instance_dir"
    files+=("$NB_NETWORK_FILE")
  fi

  NB_COMPOSE_ARGS=(-p "$NB_PROJECT" --env-file "$NB_ENV_FILE")
  local file
  for file in "${files[@]}"; do NB_COMPOSE_ARGS+=(-f "$file"); done
  NB_COMPOSE_ARGS+=("${profiles[@]}")
  NB_CONFIG_FILES="$(IFS=,; printf '%s' "${files[*]}")"
}

# Refuses a project whose existing containers or networks do not belong to exactly this resolution,
# and an overlay subnet that collides with an existing Docker network.
nb_check_binding() {
  # Every listing is captured before parsing, so a failing Docker call stops the script instead of
  # reading as "nothing found".
  local project="$NB_PROJECT" listing id config_files env_file
  listing="$(nb_docker ps -a --filter "label=com.docker.compose.project=${project}" \
    --format '{{.ID}}	{{.Label "com.docker.compose.project.config_files"}}	{{.Label "com.docker.compose.project.environment_file"}}')"
  while IFS=$'\t' read -r id config_files env_file; do
    [[ -n "$id" ]] || continue
    [[ "$config_files" == "$NB_CONFIG_FILES" ]] || nb_die "project ${project} container ${id} was created with Compose files
  ${config_files}
but this command would use
  ${NB_CONFIG_FILES}
Use the same checkout, AI/mailbox settings and NIBOMO_COMPOSE_NETWORK_FILE that created it."
    [[ -z "$env_file" || "$env_file" == "$NB_ENV_FILE" ]] \
      || nb_die "project ${project} container ${id} belongs to env file ${env_file}, not ${NB_ENV_FILE}"
  done <<<"$listing"

  local -A existing=()
  local ids name key internal subnets
  ids="$(nb_docker network ls -q --filter "label=com.docker.compose.project=${project}")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    listing="$(nb_docker network inspect -f \
      '{{.Name}}	{{index .Labels "com.docker.compose.network"}}	{{.Internal}}	{{range .IPAM.Config}}{{.Subnet}},{{end}}' $ids)"
    while IFS=$'\t' read -r name key internal subnets; do
      [[ -n "$name" ]] || continue
      [[ -n "${NB_NETWORK_INTERNAL[$key]:-}" ]] || continue
      [[ "$name" == "${project}_${key}" ]] || nb_die "network ${name} is labelled ${project}/${key} but is not named ${project}_${key}"
      [[ "$internal" == "${NB_NETWORK_INTERNAL[$key]}" ]] \
        || nb_die "network ${name} has internal=${internal}, expected ${NB_NETWORK_INTERNAL[$key]}; refusing to use a weakened network"
      if [[ -n "${NB_NETWORK_SUBNETS[$key]:-}" && "${subnets%,}" != "${NB_NETWORK_SUBNETS[$key]}" ]]; then
        nb_die "network ${name} has subnet ${subnets%,}, the overlay says ${NB_NETWORK_SUBNETS[$key]}"
      fi
      existing[$key]=1
    done <<<"$listing"
  fi

  [[ -z "${NB_AI_PROXY_BASE_URL:-}" ]] || nb_check_ai_proxy_network

  local missing=()
  for key in "${!NB_NETWORK_SUBNETS[@]}"; do
    [[ -n "${existing[$key]:-}" ]] || missing+=("$key")
  done
  [[ ${#missing[@]} -gt 0 ]] || return 0
  ids="$(nb_docker network ls -q)"
  [[ -n "$ids" ]] || return 0
  # shellcheck disable=SC2086
  listing="$(nb_docker network inspect -f '{{.Name}}	{{range .IPAM.Config}}{{.Subnet}},{{end}}' $ids)"
  local subnet other_range ours
  while IFS=$'\t' read -r name subnets; do
    [[ -n "$name" ]] || continue
    for subnet in ${subnets//,/ }; do
      other_range="$(nb_cidr_range "$subnet")" || continue
      for key in "${missing[@]}"; do
        ours="$(nb_cidr_range "${NB_NETWORK_SUBNETS[$key]}")"
        # shellcheck disable=SC2086
        if nb_ranges_overlap $ours $other_range; then
          nb_die "overlay subnet ${NB_NETWORK_SUBNETS[$key]} for ${key} overlaps network ${name} (${subnet}); pick a free range"
        fi
      done
    done
  done <<<"$listing"
}

# The proxy network is the operator's: it must exist, not be this project's own, hold no container of
# this project except ai-relay (anything else there could be reached around the gateway), and have no
# outbound route unless NIBOMO_AI_PROXY_NETWORK_EGRESS=accepted.
# Read-only; it never creates, connects or changes anything.
nb_check_ai_proxy_network() {
  local name="$NB_AI_PROXY_NETWORK" info owner internal containers c
  info="$(nb_docker network inspect -f \
    '{{index .Labels "com.docker.compose.project"}}|{{.Internal}}|{{range .Containers}}{{.Name}} {{end}}' "$name" 2>/dev/null)" \
    || nb_die "NIBOMO_AI_PROXY_NETWORK ${name} does not exist; create it and attach the proxy (docs/self-hosting.md)"
  # '|', not a tab: IFS whitespace would collapse an empty (unlabelled) first field.
  IFS='|' read -r owner internal containers <<<"$info"
  [[ "$owner" != "$NB_PROJECT" ]] || nb_die "NIBOMO_AI_PROXY_NETWORK ${name} is one of project ${NB_PROJECT}'s own networks"
  local service
  for c in $containers; do
    [[ "$c" == "${NB_PROJECT}-"* ]] || continue
    service="${c#"${NB_PROJECT}"-}"
    service="${service%-[0-9]*}"
    case "$service" in
      postgres | objectstore | objectstore-init | migrate | auth | backend | mcp | worker | media-maintenance | gateway | mailpit)
        nb_die "NIBOMO_AI_PROXY_NETWORK ${name} already holds ${c}; disconnect it, only ${NB_PROJECT}-ai-relay may be on the proxy network" ;;
    esac
  done
  if [[ "$internal" != true && "${NB_AI_PROXY_EGRESS:-}" != accepted ]]; then
    nb_die "NIBOMO_AI_PROXY_NETWORK ${name} has an outbound route, so backend and worker could reach any host. Use an internal network (docker network create --internal) or set NIBOMO_AI_PROXY_NETWORK_EGRESS=accepted"
  fi
}
