#!/usr/bin/env bash
# Synthetic test of `setup.sh --check`: the per-instance CSRF secret, and cleartext SMTP accepted only
# for the isolated development mailbox. Runs the real setup.sh against a throwaway instance; no Docker.
#
#   bash infra/selfhost/tests/setup-check.sh <absolute empty scratch directory>
# shellcheck disable=SC2016  # bash -c bodies are single-quoted on purpose; arguments come as $0..$n
set -uo pipefail

SETUP="$(cd "$(dirname "$0")/.." && pwd -P)/setup.sh"
WORK="${1:?usage: setup-check.sh <absolute empty scratch directory>}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd -P)"
I="$WORK/inst"
passes=0
failures=0

bash "$SETUP" "$I" > "$WORK/setup.out" 2>&1 || { cat "$WORK/setup.out"; exit 1; }
cp "$I/.env" "$WORK/env.base"

# A valid production-shaped .env, then the dev-mailbox shape, each edited per case.
configure() {
  sed -e 's#^NIBOMO_IMAGE_TAG=.*#NIBOMO_IMAGE_TAG=test#' \
    -e 's#^NIBOMO_BASE_DOMAIN=.*#NIBOMO_BASE_DOMAIN=study.example.test#' \
    -e 's#^NIBOMO_APP_HOST=.*#NIBOMO_APP_HOST=app.study.example.test#' \
    -e 's#^NIBOMO_API_HOST=.*#NIBOMO_API_HOST=api.study.example.test#' \
    -e 's#^NIBOMO_AUTH_HOST=.*#NIBOMO_AUTH_HOST=auth.study.example.test#' \
    -e 's#^NIBOMO_MCP_HOST=.*#NIBOMO_MCP_HOST=mcp.study.example.test#' \
    -e 's#^NIBOMO_MEDIA_HOST=.*#NIBOMO_MEDIA_HOST=media.study.example.test#' \
    -e 's#^NIBOMO_ALLOWED_EMAIL_DOMAINS=.*#NIBOMO_ALLOWED_EMAIL_DOMAINS=example.test#' \
    "$WORK/env.base" > "$I/.env"
  local kv key
  for kv in "$@"; do
    key="${kv%%=*}"
    if grep -q "^${key}=" "$I/.env"; then
      grep -v "^${key}=" "$I/.env" > "$I/.env.tmp" && mv "$I/.env.tmp" "$I/.env"
    fi
    printf '%s\n' "$kv" >> "$I/.env"
  done
}
DEV=(NIBOMO_COMPOSE_PROJECT=nibomo-selftest NIBOMO_SMTP_HOST=mailpit NIBOMO_SMTP_PORT=1025
  NIBOMO_SMTP_TLS_MODE=none NIBOMO_DEV_MAILBOX=true NIBOMO_GATEWAY_BIND=127.0.0.1)

expect() {
  local want="$1" name="$2" pattern="${3:-}" rc
  bash "$SETUP" --check "$I" > "$WORK/out" 2>&1; rc=$?
  if [[ "$want" == ok && "$rc" == 0 ]] || [[ "$want" == refuse && "$rc" != 0 && -n "$pattern" ]] \
      && { [[ -z "$pattern" ]] || grep -q -- "$pattern" "$WORK/out"; }; then
    echo "PASS $name"; passes=$((passes + 1))
  else
    echo "FAIL $name (rc=$rc)"; sed 's/^/    | /' "$WORK/out"; failures=$((failures + 1))
  fi
}

check() { local name="$1"; shift; if "$@"; then echo "PASS $name"; passes=$((passes + 1)); else echo "FAIL $name"; failures=$((failures + 1)); fi; }
check "setup generates secrets/backend_csrf_secret 0444" \
  bash -c '[[ -s "$0" && "$(stat -c %a "$0")" == 444 ]]' "$I/secrets/backend_csrf_secret"
before="$(sha256sum < "$I/secrets/backend_csrf_secret")"
bash "$SETUP" "$I" > "$WORK/setup2.out" 2>&1
check "re-run keeps the CSRF secret" bash -c '[[ "$(sha256sum < "$0")" == "$1" ]] && grep -q "kept      secrets/backend_csrf_secret" "$2"' \
  "$I/secrets/backend_csrf_secret" "$before" "$WORK/setup2.out"

configure;                                  expect ok     "production TLS instance passes"
configure "${DEV[@]}";                      expect ok     "isolated dev mailbox with cleartext SMTP passes"
configure "${DEV[@]}" NIBOMO_GATEWAY_BIND=; expect ok     "dev mailbox with default (loopback) bind passes"
configure NIBOMO_SMTP_TLS_MODE=none;        expect refuse "cleartext SMTP without dev mailbox" "isolated development mailbox only"
configure "${DEV[@]}" NIBOMO_DEV_MAILBOX=false; expect refuse "dev shape but mailbox off" "isolated development mailbox only"
configure "${DEV[@]}" NIBOMO_SMTP_HOST=smtp.example.com; expect refuse "dev mailbox to a real SMTP host" "NIBOMO_SMTP_HOST=mailpit"
configure "${DEV[@]}" NIBOMO_SMTP_PORT=25;  expect refuse "dev mailbox on another port" "NIBOMO_SMTP_PORT=1025"
configure "${DEV[@]}" NIBOMO_SMTP_TLS_MODE=starttls; expect refuse "dev mailbox with TLS mode" "NIBOMO_SMTP_TLS_MODE=none"
configure "${DEV[@]}" NIBOMO_COMPOSE_PROJECT=; expect refuse "dev mailbox in default project" "own NIBOMO_COMPOSE_PROJECT"
configure "${DEV[@]}" NIBOMO_COMPOSE_PROJECT=nibomo; expect refuse "dev mailbox in project nibomo" "own NIBOMO_COMPOSE_PROJECT"
configure "${DEV[@]}" NIBOMO_SMTP_USER=someone; expect refuse "dev mailbox with SMTP login" "must not set NIBOMO_SMTP_USER"
configure "${DEV[@]}" NIBOMO_GATEWAY_BIND=0.0.0.0; expect refuse "dev mailbox on a public bind" "NIBOMO_GATEWAY_BIND=127.0.0.1"
configure "${DEV[@]}" NIBOMO_DEV_MAILBOX=yes; expect refuse "unknown dev mailbox value" "must be true, false or empty"

configure
chmod 0644 "$I/secrets/backend_csrf_secret"; printf 'short\n' > "$I/secrets/backend_csrf_secret"
expect refuse "short CSRF secret" "backend_csrf_secret must hold at least 32"
rm -f "$I/secrets/backend_csrf_secret"
expect refuse "missing CSRF secret" "MISSING secrets/backend_csrf_secret"

echo "passes=${passes} failures=${failures}"
[[ "$failures" == 0 ]]
