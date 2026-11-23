#!/usr/bin/env bash
# Idempotent instance setup for the standalone stack: creates <instance>/.env from env.example and
# generates missing secrets once. Existing files are never overwritten, so keys and passwords
# survive re-runs, upgrades and container recreation. Requires bash and openssl only.
#
#   bash sourc/infra/selfhost/setup.sh /opt/docker/containers/nibomo
#   bash sourc/infra/selfhost/setup.sh --check /opt/docker/containers/nibomo
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=compose-lib.sh
. "${SCRIPT_DIR}/compose-lib.sh"
CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
  shift
fi
INSTANCE_DIR="${1:?usage: setup.sh [--check] <absolute-instance-dir>}"
if [[ "$INSTANCE_DIR" != /* || ! "$INSTANCE_DIR" =~ ^[A-Za-z0-9/._-]+$ ]]; then
  echo "ERROR: instance directory must be an absolute path of letters, digits, / . _ -" >&2
  exit 2
fi
SECRETS_DIR="${INSTANCE_DIR}/secrets"
ENV_FILE="${INSTANCE_DIR}/.env"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 is required" >&2; exit 2; }
}

# Files are world-readable so container users can read their bind-mounted copy; the 0700 directory
# keeps other host users out.
gen_hex() { openssl rand -hex 32; }
# RustFS access keys are 20 and secret keys 40 characters (S3 credential length limits).
gen_access_key() { openssl rand -hex 10; }
gen_storage_secret() { openssl rand -hex 20; }
gen_signing_key() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 2>/dev/null; }
gen_public_key() { openssl pkey -in "${SECRETS_DIR}/local_auth_signing_key.pem" -pubout 2>/dev/null; }
# Raw random bytes; the services derive the personal-key sealing key from this file (32-4096 bytes).
gen_chat_credential_key() { openssl rand 48; }
gen_instance_id() { echo "nibomo-$(openssl rand -hex 16)"; }

write_new_secret() {
  local path="$1"
  local generator="$2"
  if [[ -e "$path" ]]; then
    echo "  kept      ${path#"$INSTANCE_DIR"/}"
    return
  fi
  ( umask 077; "$generator" > "${path}.tmp" )
  [[ -s "${path}.tmp" ]] || { rm -f "${path}.tmp"; echo "ERROR: could not generate ${path}" >&2; exit 1; }
  chmod 0444 "${path}.tmp"
  mv "${path}.tmp" "$path"
  echo "  created   ${path#"$INSTANCE_DIR"/}"
}

write_placeholder() {
  local path="${SECRETS_DIR}/$1"
  if [[ ! -e "$path" ]]; then
    ( umask 077; : > "$path" )
    chmod 0444 "$path"
    echo "  created   secrets/$1 (empty; $2)"
  fi
}

setup_instance() {
  require_command openssl
  mkdir -p "$INSTANCE_DIR"
  install -d -m 0700 "$SECRETS_DIR"
  chmod 0700 "$SECRETS_DIR"

  echo "Secrets in ${SECRETS_DIR}:"
  write_new_secret "${SECRETS_DIR}/db_owner_password" gen_hex
  write_new_secret "${SECRETS_DIR}/db_backend_password" gen_hex
  write_new_secret "${SECRETS_DIR}/db_auth_password" gen_hex
  write_new_secret "${SECRETS_DIR}/session_encryption_key" gen_hex
  # Browser session CSRF HMAC key for the API; its own key, never shared with the session key.
  write_new_secret "${SECRETS_DIR}/backend_csrf_secret" gen_hex
  write_new_secret "${SECRETS_DIR}/local_auth_signing_key.pem" gen_signing_key
  write_new_secret "${SECRETS_DIR}/local_auth_public_key.pem" gen_public_key
  # MCP OAuth id_token key; auth refuses to reuse the session identity key above.
  write_new_secret "${SECRETS_DIR}/oidc_signing_key.pem" gen_signing_key
  write_new_secret "${SECRETS_DIR}/objectstore_root_access_key" gen_access_key
  write_new_secret "${SECRETS_DIR}/objectstore_root_secret_key" gen_storage_secret
  write_new_secret "${SECRETS_DIR}/objectstore_media_access_key" gen_access_key
  write_new_secret "${SECRETS_DIR}/objectstore_media_secret_key" gen_storage_secret
  write_new_secret "${SECRETS_DIR}/chat_credential_key" gen_chat_credential_key
  # HMAC key for the run-scoped AI chat live-stream tokens the backend issues and verifies.
  write_new_secret "${SECRETS_DIR}/chat_live_auth_secret" gen_hex
  # Placeholders so the Compose secrets always resolve; fill them only when needed.
  write_placeholder smtp_password "fill it if SMTP needs a password"
  write_placeholder openai_api_key "fill it and set NIBOMO_AI_PROVIDER=openai to enable AI chat"

  if [[ -e "$ENV_FILE" ]]; then
    echo "Kept existing ${ENV_FILE}"
    # Instances created before personal-key sealing: append the one generated setting they lack.
    if ! grep -qE '^NIBOMO_INSTANCE_ID=' "$ENV_FILE"; then
      [[ -z "$(tail -c 1 "$ENV_FILE")" ]] || echo >> "$ENV_FILE"
      printf 'NIBOMO_INSTANCE_ID=%s\n' "$(gen_instance_id)" >> "$ENV_FILE"
      echo "  appended  NIBOMO_INSTANCE_ID to ${ENV_FILE}"
    fi
  else
    local client_id
    client_id="nibomo_$(openssl rand -hex 16)"
    ( umask 077; sed -e "s#^NIBOMO_INSTANCE_DIR=.*#NIBOMO_INSTANCE_DIR=${INSTANCE_DIR}#" \
      -e "s#^NIBOMO_LOCAL_AUTH_CLIENT_ID=.*#NIBOMO_LOCAL_AUTH_CLIENT_ID=${client_id}#" \
      -e "s#^NIBOMO_INSTANCE_ID=.*#NIBOMO_INSTANCE_ID=$(gen_instance_id)#" \
      "${SCRIPT_DIR}/env.example" > "${ENV_FILE}.tmp" )
    mv "${ENV_FILE}.tmp" "$ENV_FILE"
    echo "Created ${ENV_FILE}; edit the hosts, allowlist and SMTP settings, then run --check."
  fi
}

check_instance() {
  local failed=0
  local key value
  for key in db_owner_password db_backend_password db_auth_password session_encryption_key backend_csrf_secret \
      local_auth_signing_key.pem local_auth_public_key.pem oidc_signing_key.pem smtp_password objectstore_root_access_key \
      objectstore_root_secret_key objectstore_media_access_key objectstore_media_secret_key openai_api_key chat_credential_key chat_live_auth_secret; do
    [[ -f "${SECRETS_DIR}/${key}" ]] || { echo "MISSING secrets/${key}"; failed=1; }
  done
  if [[ -f "${SECRETS_DIR}/backend_csrf_secret" ]]; then
    value="$(tr -d '[:space:]' < "${SECRETS_DIR}/backend_csrf_secret" | wc -c)"
    (( value >= 32 )) \
      || { echo "secrets/backend_csrf_secret must hold at least 32 characters (delete it and re-run setup.sh)"; failed=1; }
  fi
  [[ -f "$ENV_FILE" ]] || { echo "MISSING .env"; exit 1; }
  # Read settings without sourcing the file, so it cannot run commands.
  get() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
  for key in NIBOMO_INSTANCE_DIR NIBOMO_IMAGE_TAG NIBOMO_BASE_DOMAIN NIBOMO_APP_HOST NIBOMO_API_HOST \
      NIBOMO_AUTH_HOST NIBOMO_MCP_HOST NIBOMO_MEDIA_HOST NIBOMO_MEDIA_BUCKET NIBOMO_LOCAL_AUTH_CLIENT_ID NIBOMO_SMTP_HOST \
      NIBOMO_SMTP_PORT NIBOMO_SMTP_FROM; do
    value="$(get "$key")"
    if [[ -z "$value" || "$value" == replace-with-* || "$value" == generated-by-setup ]]; then
      echo "UNSET $key"; failed=1
    fi
  done
  [[ "$(get NIBOMO_INSTANCE_DIR)" == "$INSTANCE_DIR" ]] || { echo "NIBOMO_INSTANCE_DIR does not match ${INSTANCE_DIR}"; failed=1; }
  local base; base="$(get NIBOMO_BASE_DOMAIN)"
  # Lower-case DNS names: the services compare issuer, Origin and MCP resource strings exactly.
  for key in NIBOMO_BASE_DOMAIN NIBOMO_MCP_ALTERNATE_HOST; do
    value="$(get "$key")"
    [[ -z "$value" && "$key" == NIBOMO_MCP_ALTERNATE_HOST ]] && continue
    [[ "$value" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
      || { echo "$key must be a lower-case DNS name without scheme, port or path"; failed=1; }
  done
  # Session and refresh cookies are scoped to the base. ts.net is a public suffix, so <tailnet>.ts.net
  # is one registrable domain holding every device, Service and Funnel name of that tailnet; names
  # below it are assigned by Tailscale, not by the operator.
  if [[ "$base" == ts.net || "$base" =~ ^[^.]+\.ts\.net$ ]]; then
    echo "NIBOMO_BASE_DOMAIN must not be a tailnet's ts.net domain: session cookies would reach every device, Service and Funnel host in it (docs/self-hosting-private-tailnet.md)"; failed=1
  elif [[ "$base" == *.ts.net ]]; then
    echo "NIBOMO_BASE_DOMAIN must not be under ts.net, whose names Tailscale assigns: use a base domain whose app., api., auth., mcp. and media names you control (docs/self-hosting-private-tailnet.md)"; failed=1
  fi
  for key in APP API AUTH MCP; do
    value="$(get "NIBOMO_${key}_HOST")"
    [[ "$value" == "${key,,}.${base}" ]] || { echo "NIBOMO_${key}_HOST must be ${key,,}.${base} (client host derivation)"; failed=1; }
  done
  value="$(get NIBOMO_MEDIA_HOST)"
  if [[ "$value" == "$base" || "$value" == "$(get NIBOMO_APP_HOST)" || "$value" == "$(get NIBOMO_API_HOST)" \
      || "$value" == "$(get NIBOMO_AUTH_HOST)" || "$value" == "$(get NIBOMO_MCP_HOST)" ]]; then
    echo "NIBOMO_MEDIA_HOST must be its own host name (e.g. media.${base})"; failed=1
  fi
  [[ "$(get NIBOMO_MEDIA_BUCKET)" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] \
    || { echo "NIBOMO_MEDIA_BUCKET must be 3-63 lowercase letters, digits or hyphens"; failed=1; }
  value="$(get NIBOMO_MCP_ALTERNATE_HOST)"
  if [[ -n "$value" && ( "$value" == "$base" || "$value" == "$(get NIBOMO_APP_HOST)" || "$value" == "$(get NIBOMO_API_HOST)" \
      || "$value" == "$(get NIBOMO_AUTH_HOST)" || "$value" == "$(get NIBOMO_MCP_HOST)" || "$value" == "$(get NIBOMO_MEDIA_HOST)" ) ]]; then
    echo "NIBOMO_MCP_ALTERNATE_HOST must be its own host name"; failed=1
  fi
  local origin origins=()
  IFS=, read -r -a origins <<< "$(get NIBOMO_MCP_ALLOWED_ORIGINS)"
  for origin in "${origins[@]}"; do
    origin="${origin// /}"
    [[ -z "$origin" || "$origin" =~ ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] \
      || { echo "NIBOMO_MCP_ALLOWED_ORIGINS entries must be exact lower-case https origins"; failed=1; }
  done
  value="$(get NIBOMO_COMPOSE_PROJECT)"
  [[ -z "$value" || "$value" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "NIBOMO_COMPOSE_PROJECT is invalid"; failed=1; }
  local sealing=false
  case "$(get NIBOMO_AI_PROVIDER)" in
    "" | none) ;;
    openai) [[ -s "${SECRETS_DIR}/openai_api_key" ]] \
      || { echo "NIBOMO_AI_PROVIDER=openai but secrets/openai_api_key is empty"; failed=1; } ;;
    # Personal keys only, always sealed; secrets/openai_api_key is not mounted in this mode.
    user-key)
      sealing=true
      [[ -z "$(get NIBOMO_AI_PERSONAL_KEYS)" || "$(get NIBOMO_AI_PERSONAL_KEYS)" == sealed ]] \
        || { echo "NIBOMO_AI_PROVIDER=user-key always seals personal keys; leave NIBOMO_AI_PERSONAL_KEYS empty or sealed"; failed=1; } ;;
    *) echo "NIBOMO_AI_PROVIDER must be none, openai or user-key"; failed=1 ;;
  esac
  case "$(get NIBOMO_AI_PERSONAL_KEYS)" in
    "") ;;
    sealed)
      sealing=true
      [[ "$(get NIBOMO_AI_PROVIDER)" == openai || "$(get NIBOMO_AI_PROVIDER)" == user-key ]] \
        || { echo "NIBOMO_AI_PERSONAL_KEYS=sealed needs NIBOMO_AI_PROVIDER=openai or user-key"; failed=1; } ;;
    *) echo "NIBOMO_AI_PERSONAL_KEYS must be empty (refused) or sealed"; failed=1 ;;
  esac
  if [[ "$sealing" == true ]]; then
    value="$(get NIBOMO_INSTANCE_ID)"
    [[ "$value" =~ ^[A-Za-z0-9._:-]{1,200}$ && "$value" != generated-by-setup ]] \
      || { echo "NIBOMO_INSTANCE_ID must be 1-200 letters, digits, . _ : - (setup.sh generates it)"; failed=1; }
    value="$(wc -c < "${SECRETS_DIR}/chat_credential_key" 2>/dev/null || echo 0)"
    (( value >= 32 && value <= 4096 )) \
      || { echo "secrets/chat_credential_key must hold 32-4096 random bytes"; failed=1; }
  fi
  local project
  project="$(get NIBOMO_COMPOSE_PROJECT)"
  value="$(nb_ai_proxy_problem "$(get NIBOMO_AI_PROVIDER)" "$(get NIBOMO_AI_PERSONAL_KEYS)" "${project:-nibomo}" \
    "$(get NIBOMO_AI_PROXY_BASE_URL)" "$(get NIBOMO_AI_PROXY_NETWORK)" "$(get NIBOMO_AI_PROXY_NETWORK_EGRESS)" \
    "$(get NIBOMO_AI_MODEL)")"
  [[ -z "$value" ]] || { echo "$value"; failed=1; }
  value="$(get NIBOMO_AI_MONTHLY_MESSAGES)"
  # The digit-only regex runs before any arithmetic, so untrusted text never reaches (( )); 10# keeps
  # leading zeros decimal (08 is 8, not invalid octal).
  if [[ -n "$value" ]] && ! { [[ "$value" =~ ^[0-9]{1,6}$ ]] && (( 10#$value >= 1 && 10#$value <= 100000 )); }; then
    echo "NIBOMO_AI_MONTHLY_MESSAGES must be 1-100000"; failed=1
  fi
  if [[ -z "$(get NIBOMO_ALLOWED_EMAILS)" && -z "$(get NIBOMO_ALLOWED_EMAIL_DOMAINS)" ]]; then
    echo "UNSET NIBOMO_ALLOWED_EMAILS or NIBOMO_ALLOWED_EMAIL_DOMAINS"; failed=1
  fi
  if [[ -n "$(get NIBOMO_SMTP_USER)" && ! -s "${SECRETS_DIR}/smtp_password" ]]; then
    echo "NIBOMO_SMTP_USER is set but secrets/smtp_password is empty"; failed=1
  fi
  # Cleartext SMTP carries sign-in codes, so it is accepted only as the captured development mailbox
  # of compose.devmail.yml: its own Compose project, the overlay's mailpit service, no SMTP login and a
  # loopback-only gateway. Every other instance needs starttls or implicit TLS.
  case "$(get NIBOMO_DEV_MAILBOX)" in
    "" | false) ;;
    true)
      value="$(get NIBOMO_COMPOSE_PROJECT)"
      [[ -n "$value" && "$value" != nibomo ]] \
        || { echo "NIBOMO_DEV_MAILBOX=true needs its own NIBOMO_COMPOSE_PROJECT, never nibomo"; failed=1; }
      [[ "$(get NIBOMO_SMTP_HOST)" == mailpit && "$(get NIBOMO_SMTP_PORT)" == 1025 ]] \
        || { echo "NIBOMO_DEV_MAILBOX=true needs NIBOMO_SMTP_HOST=mailpit and NIBOMO_SMTP_PORT=1025 (the overlay's mailbox)"; failed=1; }
      [[ "$(get NIBOMO_SMTP_TLS_MODE)" == none ]] \
        || { echo "NIBOMO_DEV_MAILBOX=true needs NIBOMO_SMTP_TLS_MODE=none"; failed=1; }
      [[ -z "$(get NIBOMO_SMTP_USER)" ]] \
        || { echo "NIBOMO_DEV_MAILBOX=true must not set NIBOMO_SMTP_USER"; failed=1; }
      [[ "$(get NIBOMO_GATEWAY_BIND)" == "" || "$(get NIBOMO_GATEWAY_BIND)" == 127.0.0.1 ]] \
        || { echo "NIBOMO_DEV_MAILBOX=true needs NIBOMO_GATEWAY_BIND=127.0.0.1"; failed=1; } ;;
    *) echo "NIBOMO_DEV_MAILBOX must be true, false or empty"; failed=1 ;;
  esac
  if [[ "$(get NIBOMO_SMTP_TLS_MODE)" == none && "$(get NIBOMO_DEV_MAILBOX)" != true ]]; then
    echo "NIBOMO_SMTP_TLS_MODE=none is for the isolated development mailbox only (NIBOMO_DEV_MAILBOX=true)"; failed=1
  fi
  if [[ "$failed" == 0 ]]; then echo "Instance configuration OK"; fi
  return "$failed"
}

if [[ "$CHECK_ONLY" == true ]]; then
  check_instance
else
  setup_instance
fi
