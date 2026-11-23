#!/usr/bin/env bash
# Synthetic test of the optional OpenAI-compatible proxy (compose.ai-proxy.yml): `setup.sh --check` and
# compose.sh refusals against fake-docker.py, then `docker compose config` (renders only; no daemon call
# that creates, starts or changes anything) to prove which services join the proxy network. Uses only
# synthetic values; never starts a container or reaches a network.
#
#   bash infra/selfhost/tests/ai-proxy.sh <absolute empty scratch directory>
set -uo pipefail

SELFHOST="$(cd "$(dirname "$0")/.." && pwd -P)"
FAKE="${SELFHOST}/tests/fake-docker.py"
WORK="${1:?usage: ai-proxy.sh <absolute empty scratch directory>}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd -P)"
chmod 0700 "$WORK"
SYNTHETIC_KEY="sk-synthetic-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
passes=0
failures=0
ok() { echo "PASS $1"; passes=$((passes + 1)); }
bad() { echo "FAIL $1"; failures=$((failures + 1)); [[ -f "$WORK/out" ]] && sed 's/^/    | /' "$WORK/out" | tail -n 15; }

# --- setup.sh --check ------------------------------------------------------------------------------
I="$WORK/inst"
bash "${SELFHOST}/setup.sh" "$I" > "$WORK/setup.out" 2>&1 || { cat "$WORK/setup.out"; exit 1; }
cp "$I/.env" "$WORK/env.base"
chmod 0644 "$I/secrets/openai_api_key"; printf '%s\n' "$SYNTHETIC_KEY" > "$I/secrets/openai_api_key"
configure() {
  sed -e 's#^NIBOMO_IMAGE_TAG=.*#NIBOMO_IMAGE_TAG=test#' \
    -e 's#^NIBOMO_BASE_DOMAIN=.*#NIBOMO_BASE_DOMAIN=study.example.test#' \
    -e 's#^NIBOMO_APP_HOST=.*#NIBOMO_APP_HOST=app.study.example.test#' \
    -e 's#^NIBOMO_API_HOST=.*#NIBOMO_API_HOST=api.study.example.test#' \
    -e 's#^NIBOMO_AUTH_HOST=.*#NIBOMO_AUTH_HOST=auth.study.example.test#' \
    -e 's#^NIBOMO_MCP_HOST=.*#NIBOMO_MCP_HOST=mcp.study.example.test#' \
    -e 's#^NIBOMO_MEDIA_HOST=.*#NIBOMO_MEDIA_HOST=media.study.example.test#' \
    -e 's#^NIBOMO_ALLOWED_EMAIL_DOMAINS=.*#NIBOMO_ALLOWED_EMAIL_DOMAINS=example.test#' \
    -e 's#^NIBOMO_AI_PROVIDER=.*#NIBOMO_AI_PROVIDER=openai#' \
    "$WORK/env.base" > "$I/.env"
  local kv key
  for kv in "$@"; do
    key="${kv%%=*}"
    grep -v "^${key}=" "$I/.env" > "$I/.env.tmp"; mv "$I/.env.tmp" "$I/.env"
    printf '%s\n' "$kv" >> "$I/.env"
  done
}
check() { # <ok|refuse> <name> [pattern]
  local want="$1" name="$2" pattern="${3:-}" rc
  bash "${SELFHOST}/setup.sh" --check "$I" > "$WORK/out" 2>&1; rc=$?
  if { [[ "$want" == ok && "$rc" == 0 ]] || { [[ "$want" == refuse && "$rc" != 0 ]] && grep -q -- "$pattern" "$WORK/out"; }; } \
      && ! grep -q -- "$SYNTHETIC_KEY" "$WORK/out"; then ok "check: $name"; else bad "check: $name (rc=$rc)"; fi
}
PROXY=(NIBOMO_AI_PROXY_BASE_URL=http://cliproxyapi:8317/v1 NIBOMO_AI_PROXY_NETWORK=nibomo-ai-proxy)
configure;                                      check ok "no proxy (default OpenAI endpoint)"
configure NIBOMO_AI_MODEL=gpt-5.4;              check ok "model override without proxy"
configure "${PROXY[@]}" NIBOMO_AI_MODEL=gpt-5.4; check ok "proxy + model"
configure "${PROXY[@]}" NIBOMO_AI_PROXY_NETWORK_EGRESS=accepted; check ok "proxy on a routed network, accepted"
configure NIBOMO_AI_MODEL='gpt 5;rm';           check refuse "model with spaces/metacharacters" "NIBOMO_AI_MODEL must be"
configure NIBOMO_AI_PROXY_BASE_URL=http://user:pw@cliproxyapi:8317/v1 NIBOMO_AI_PROXY_NETWORK=n; check refuse "credentials in URL" "without credentials"
configure NIBOMO_AI_PROXY_BASE_URL='http://cliproxyapi:8317/v1?key=x' NIBOMO_AI_PROXY_NETWORK=n; check refuse "query in URL" "without credentials, query"
configure NIBOMO_AI_PROXY_BASE_URL=ftp://cliproxyapi/v1 NIBOMO_AI_PROXY_NETWORK=n; check refuse "non-http scheme" "http(s)://host"
configure NIBOMO_AI_PROXY_BASE_URL=http://cliproxyapi:8317/v1; check refuse "proxy without network" "needs NIBOMO_AI_PROXY_NETWORK"
configure NIBOMO_AI_PROXY_NETWORK=nibomo-ai-proxy; check refuse "network without proxy" "need NIBOMO_AI_PROXY_BASE_URL"
configure "${PROXY[@]}" NIBOMO_AI_PROXY_NETWORK=nibomo_internal; check refuse "project's own network" "own networks"
configure "${PROXY[@]}" NIBOMO_AI_PROXY_NETWORK_EGRESS=yes; check refuse "unknown egress value" "empty or accepted"
configure "${PROXY[@]}" NIBOMO_AI_PERSONAL_KEYS=sealed; check refuse "proxy with personal keys" "personal keys would be sent"
configure "${PROXY[@]}" NIBOMO_AI_PROVIDER=user-key; check refuse "proxy with user-key funding" "needs NIBOMO_AI_PROVIDER=openai"
configure "${PROXY[@]}" NIBOMO_AI_PROVIDER=none; check refuse "proxy with AI off" "needs NIBOMO_AI_PROVIDER=openai"

# --- compose.sh against fake-docker.py ------------------------------------------------------------
T="$WORK/f"; mkdir -m 0700 "$T" "$T/bin"
printf '#!/bin/sh\nexec python3 -I %s "$@"\n' "$FAKE" > "$T/bin/docker"; chmod 0755 "$T/bin/docker"
python3 -I -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$T/docker.sock"
FI="$T/inst"; mkdir -m 0700 "$FI" "$FI/secrets"
for name in chat_live_auth_secret openai_api_key; do printf '%s\n' "$SYNTHETIC_KEY" > "$FI/secrets/$name"; chmod 0444 "$FI/secrets/$name"; done
fake_env() {
  cat > "$FI/.env" <<ENV
NIBOMO_INSTANCE_DIR=${FI}
NIBOMO_COMPOSE_PROJECT=nbproxy
NIBOMO_DOCKER_HOST=unix://${T}/docker.sock
NIBOMO_AI_PROVIDER=openai
NIBOMO_AI_PROXY_BASE_URL=http://cliproxyapi:8317/v1
NIBOMO_AI_PROXY_NETWORK=nibomo-ai-proxy
ENV
  [[ $# -eq 0 ]] || printf '%s\n' "$@" >> "$FI/.env"
}
fake_net() { # <internal true|false> <compose project label or ""> <containers...>
  local internal="$1" owner="$2"; shift 2
  python3 -I - "$T/state.json" "$internal" "$owner" "$@" <<'PY'
import json, sys
path, internal, owner, *containers = sys.argv[1:]
labels = {"com.docker.compose.project": owner} if owner else {}
st = {"containers": [], "volumes": {}, "behavior": {}, "networks": {
  "nibomo-ai-proxy": {"labels": labels, "internal": internal == "true", "subnets": ["172.31.9.0/24"], "containers": containers}}}
json.dump(st, open(path, "w"))
PY
  : > "$T/calls.log"
}
wrap() { # <ok|refuse> <name> [pattern]
  local want="$1" name="$2" pattern="${3:-}" rc
  env -u DOCKER_HOST -u DOCKER_CONTEXT PATH="$T/bin:$PATH" bash "${SELFHOST}/compose.sh" "$FI" ps > "$WORK/out" 2>&1; rc=$?
  if { [[ "$want" == ok && "$rc" == 0 ]] || { [[ "$want" == refuse && "$rc" != 0 ]] && grep -q -- "$pattern" "$WORK/out"; }; } \
      && ! grep -q -- "$SYNTHETIC_KEY" "$WORK/out" "$T/calls.log"; then ok "wrapper: $name"; else bad "wrapper: $name (rc=$rc)"; fi
}
fake_env;                                        rm -f "$T/state.json"
python3 -I -c 'import json,sys; json.dump({"containers":[],"volumes":{},"networks":{},"behavior":{}}, open(sys.argv[1],"w"))' "$T/state.json"; : > "$T/calls.log"
wrap refuse "missing proxy network" "does not exist"
fake_net false "" cliproxyapi;                    wrap refuse "routed network without acceptance" "has an outbound route"
fake_net true nbproxy cliproxyapi;                wrap refuse "network labelled as this project" "own networks"
fake_net true "" cliproxyapi nbproxy-postgres-1;  wrap refuse "network already holding project postgres" "data services must stay off"
fake_net true "" cliproxyapi nbproxy-objectstore-1; wrap refuse "network already holding project objectstore" "data services must stay off"
fake_net true "" cliproxyapi;                     wrap ok "internal proxy network"
if jq -e 'select(.argv[0]=="compose") | .argv | index("'"${SELFHOST}/compose.ai-proxy.yml"'")' "$T/calls.log" >/dev/null \
    && ! jq -r '.argv[]' "$T/calls.log" | grep -qE '^(create|connect|disconnect|rm)$'; then
  ok "wrapper adds compose.ai-proxy.yml and makes no network change"
else bad "wrapper adds compose.ai-proxy.yml and makes no network change"; fi
fake_env NIBOMO_AI_PROXY_NETWORK_EGRESS=accepted; fake_net false "" cliproxyapi; wrap ok "routed network with explicit acceptance"
fake_env NIBOMO_AI_PERSONAL_KEYS=sealed;          fake_net true "" cliproxyapi; wrap refuse "wrapper refuses personal keys with proxy" "personal keys would be sent"

# --- rendered Compose model (docker compose config: parse only) -----------------------------------
if docker compose version >/dev/null 2>&1; then
  configure "${PROXY[@]}" NIBOMO_AI_MODEL=gpt-5.4 NIBOMO_COMPOSE_PROJECT=nbproxy "NIBOMO_INSTANCE_DIR=$I"
  env -u DOCKER_HOST docker compose -p nbproxy --env-file "$I/.env" -f "${SELFHOST}/compose.yml" -f "${SELFHOST}/compose.ai.yml" \
    -f "${SELFHOST}/compose.ai-proxy.yml" --profile ai config --format json > "$WORK/config.json" 2> "$WORK/out"
  # shellcheck disable=SC2016
  if jq -e '
      (.services.backend.networks | keys | sort) == ["ai-proxy","app","internal","storage"]
      and (.services.worker.networks | keys | sort) == ["ai-proxy","internal","storage"]
      and ([.services | to_entries[] | select(.key != "backend" and .key != "worker") | select(.value.networks | has("ai-proxy"))] | length) == 0
      and ([.services | to_entries[] | select(.key == "backend" or .key == "worker") | select(.value.networks | has("egress"))] | length) == 0
      and .networks["ai-proxy"].external == true and .networks["ai-proxy"].name == "nibomo-ai-proxy"
      and .services.backend.environment.OPENAI_BASE_URL == "http://cliproxyapi:8317/v1"
      and .services.worker.environment.OPENAI_BASE_URL == "http://cliproxyapi:8317/v1"
      and .services.worker.environment.NIBOMO_OPENAI_MODEL == "gpt-5.4"
      and .services.worker.environment.OPENAI_API_KEY_FILE == "/run/secrets/openai_api_key"
      and (.services.worker.environment | has("OPENAI_API_KEY") | not)' "$WORK/config.json" >/dev/null \
      && ! grep -q -- "$SYNTHETIC_KEY" "$WORK/config.json"; then
    ok "config: only backend/worker join ai-proxy, both lose egress, key stays a file"
  else bad "config: only backend/worker join ai-proxy, both lose egress, key stays a file"; fi
  # Without the proxy overlay the default AWS-style OpenAI route is unchanged: egress, no base URL.
  configure NIBOMO_COMPOSE_PROJECT=nbproxy "NIBOMO_INSTANCE_DIR=$I"
  env -u DOCKER_HOST docker compose -p nbproxy --env-file "$I/.env" -f "${SELFHOST}/compose.yml" -f "${SELFHOST}/compose.ai.yml" \
    --profile ai config --format json > "$WORK/config0.json" 2> "$WORK/out"
  if jq -e '(.services.worker.networks | has("egress")) and (.services.worker.environment | has("OPENAI_BASE_URL") | not)
      and (.services.worker.environment.NIBOMO_OPENAI_MODEL // "") == ""' "$WORK/config0.json" >/dev/null; then
    ok "config: default overlay keeps egress and no base URL"
  else bad "config: default overlay keeps egress and no base URL"; fi
else
  echo "SKIP rendered Compose model: docker compose is not installed"
fi

echo "passes=${passes} failures=${failures}"
[[ "$failures" == 0 ]]
