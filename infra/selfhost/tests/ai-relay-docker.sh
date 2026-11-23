#!/usr/bin/env bash
# Real-Docker fixture of the AI proxy boundary (compose.ai-proxy.yml): starts the real ai-relay through
# compose.sh for a disposable project, a synthetic proxy (tests/ai-relay-fixture/fake-proxy.mjs) on a new
# internal network, a stand-in listener on the project's `ai` network where backend/worker live, and two
# probes (probe.mjs). Proves: the OpenAI SDK streams a Responses tool call through the relay, TLS keeps the
# proxy's own name, redirects and every other destination fail, and nothing on the proxy network can
# reach the stack. Synthetic key and data only; never touches project nibomo or any network it did not
# create, and removes only what it created.
#
#   bash infra/selfhost/tests/ai-relay-docker.sh <absolute empty scratch dir> <backend image> <ai /24> <proxy /24>
# <backend image>: any built nibomo-selfhost-backend image (it supplies Node and the pinned openai SDK).
# The two subnets must be free private ranges (explicit because hosts often exhaust Docker's pools).
set -uo pipefail

SELFHOST="$(cd "$(dirname "$0")/.." && pwd -P)"
FIXTURE="${SELFHOST}/tests/ai-relay-fixture"
WORK="${1:?usage: ai-relay-docker.sh <empty scratch dir> <backend image> <ai subnet> <proxy subnet>}"
BACKEND_IMAGE="${2:?backend image}"
AI_SUBNET="${3:?ai subnet}"
PROXY_SUBNET="${4:?proxy subnet}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd -P)"
chmod 0755 "$WORK"
version="$(docker compose version --short)"
IFS=. read -r major minor _ <<<"${version#v}"
(( major > 2 || (major == 2 && minor >= 36) )) || { echo "docker compose ${version}: need 2.36+" >&2; exit 2; }

P="nbrelayfx-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PROXY_NET="${P}-proxy"
SYNTHETIC_KEY="sk-synthetic-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
LABEL="com.nibomo.test=ai-relay-fixture-${P}"
passes=0
failures=0
ok() { echo "PASS $1"; passes=$((passes + 1)); }
bad() { echo "FAIL $1"; failures=$((failures + 1)); }
count() { passes=$((passes + $(grep -c '^PASS' "$1"))); failures=$((failures + $(grep -c '^FAIL' "$1"))); cat "$1"; }

I="$WORK/inst"
# Only what this run created: its own containers first (the stub holds the ai network), then the project.
cleanup() {
  docker rm -f "fx-${P}-proxy" "fx-${P}-backend-stub" >/dev/null 2>&1
  [[ -f "$I/.env" ]] && NIBOMO_COMPOSE_NETWORK_FILE="$WORK/networks.yml" \
    bash "${SELFHOST}/compose.sh" "$I" down --remove-orphans >/dev/null 2>&1
  docker network rm "$PROXY_NET" >/dev/null 2>&1
  docker ps -aq --filter "label=com.docker.compose.project=${P}" | grep -q . && echo "WARN: leftover containers of ${P}" >&2
  docker network ls -q --filter "name=^${P}" | grep -q . && echo "WARN: leftover networks of ${P}" >&2
  return 0
}
trap cleanup EXIT
echo "fixture project ${P}"

# --- synthetic instance -----------------------------------------------------------------------------
bash "${SELFHOST}/setup.sh" "$I" > "$WORK/setup.out" 2>&1 || { cat "$WORK/setup.out"; exit 1; }
chmod 0644 "$I/secrets/openai_api_key"; printf '%s\n' "$SYNTHETIC_KEY" > "$I/secrets/openai_api_key"
set_env() { grep -v "^${1%%=*}=" "$I/.env" > "$I/.env.tmp"; printf '%s\n' "$1" >> "$I/.env.tmp"; mv "$I/.env.tmp" "$I/.env"; }
for kv in NIBOMO_COMPOSE_PROJECT="$P" NIBOMO_IMAGE_TAG=fixture NIBOMO_AI_PROVIDER=openai \
    NIBOMO_BASE_DOMAIN=study.example.test NIBOMO_APP_HOST=app.study.example.test NIBOMO_API_HOST=api.study.example.test \
    NIBOMO_AUTH_HOST=auth.study.example.test NIBOMO_MCP_HOST=mcp.study.example.test NIBOMO_MEDIA_HOST=media.study.example.test \
    NIBOMO_ALLOWED_EMAIL_DOMAINS=example.test NIBOMO_AI_PROXY_BASE_URL=http://fxproxy:8317/v1 NIBOMO_AI_PROXY_NETWORK="$PROXY_NET"; do
  set_env "$kv"
done
printf 'networks:\n  ai:\n    ipam:\n      config:\n        - subnet: %s\n' "$AI_SUBNET" > "$WORK/networks.yml"
chmod 0644 "$WORK/networks.yml"

# --- synthetic proxy on a new internal network --------------------------------------------------------
mkdir -m 0755 "$WORK/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=fxproxy" -addext "subjectAltName=DNS:fxproxy" \
  -keyout "$WORK/tls/key.pem" -out "$WORK/tls/cert.pem" >/dev/null 2>&1 || { echo "openssl failed" >&2; exit 1; }
chmod 0444 "$WORK/tls/key.pem" "$WORK/tls/cert.pem"
docker network create --internal --subnet "$PROXY_SUBNET" --label "$LABEL" "$PROXY_NET" >/dev/null || exit 1
docker run -d --name "fx-${P}-proxy" --label "$LABEL" --network "$PROXY_NET" --network-alias fxproxy --read-only \
  -e FAKE_PROXY_KEY="$SYNTHETIC_KEY" -v "$FIXTURE:/fixture-src:ro" -v "$WORK/tls:/fixture/tls:ro" \
  --entrypoint node "$BACKEND_IMAGE" /fixture-src/fake-proxy.mjs >/dev/null || exit 1

# --- the real relay, through the wrapper --------------------------------------------------------------
if NIBOMO_COMPOSE_NETWORK_FILE="$WORK/networks.yml" bash "${SELFHOST}/compose.sh" "$I" up -d --build --no-deps --wait ai-relay \
    > "$WORK/up.out" 2>&1; then ok "compose.sh starts ai-relay"; else bad "compose.sh starts ai-relay"; tail -20 "$WORK/up.out"; exit 1; fi
RELAY="$(docker ps -q --filter "label=com.docker.compose.project=${P}" --filter "label=com.docker.compose.service=ai-relay")"
for _ in 1 2 3 4 5 6 7 8 9 10; do docker logs "$RELAY" 2>&1 | grep -q '^ai-relay: listening' && break; sleep 1; done
[[ "$(docker inspect "$RELAY" -f '{{.State.Running}} {{.RestartCount}}')" == "true 0" ]] && docker logs "$RELAY" 2>&1 | grep -q '^ai-relay: listening' \
  && ok "ai-relay is listening without restarts" || bad "ai-relay is listening without restarts"
inspect="$(docker inspect "$RELAY" --format '{{json .}}')"
if jq -e --arg ai "${P}_ai" --arg px "$PROXY_NET" '
    (.NetworkSettings.Networks | keys | sort) == ([$ai, $px] | sort)
    and (.NetworkSettings.Networks[$ai].Aliases | index("fxproxy"))
    and .HostConfig.ReadonlyRootfs == true and .HostConfig.CapDrop == ["ALL"]
    and .Config.User == "node" and (.HostConfig.PortBindings // {} | length) == 0' <<<"$inspect" >/dev/null; then
  ok "ai-relay: only ai + proxy networks, alias fxproxy on ai, read-only, no caps, non-root, no published port"
else bad "ai-relay container shape"; fi
[[ "$(docker network inspect "${P}_ai" -f '{{.Internal}}')" == true ]] && ok "project ai network is internal" || bad "project ai network is internal"
members="$(docker network inspect "$PROXY_NET" -f '{{range .Containers}}{{.Name}} {{end}}')"
[[ "$(tr ' ' '\n' <<<"$members" | grep -c "^${P}-")" == 1 && "$members" == *"${P}-ai-relay-1"* ]] \
  && ok "ai-relay is the only stack container on the proxy network" || bad "proxy network members: $members"
RELAY_PX="$(jq -r --arg px "$PROXY_NET" '.NetworkSettings.Networks[$px].IPAddress' <<<"$inspect")"

# Stand-in for backend: a listener on the ai network, as backend:8080 would be.
docker run -d --name "fx-${P}-backend-stub" --label "$LABEL" --network "${P}_ai" --network-alias backend-stub --read-only \
  --entrypoint node "$BACKEND_IMAGE" -e "require('http').createServer((q,s)=>s.end('stack')).listen(8080)" >/dev/null || exit 1
STUB="$(docker inspect "fx-${P}-backend-stub" -f "{{(index .NetworkSettings.Networks \"${P}_ai\").IPAddress}}")"
RELAY_AI="$(jq -r --arg ai "${P}_ai" '.NetworkSettings.Networks[$ai].IPAddress' <<<"$inspect")"

# --- probes ---------------------------------------------------------------------------------------------
probe() { # <role> <network> [extra docker args...]
  local role="$1" net="$2"; shift 2
  docker run --rm --label "$LABEL" --network "$net" --read-only -v "$FIXTURE:/fixture-src:ro" \
    -e PROXY_HOST=fxproxy -e PROXY_PORT=8317 -e PROXY_NETWORK="$PROXY_NET" -e SYNTHETIC_KEY="$SYNTHETIC_KEY" "$@" \
    --entrypoint node "$BACKEND_IMAGE" /fixture-src/probe.mjs "$role"
}
probe inside "${P}_ai" -v "$WORK/tls/cert.pem:/fixture/ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/fixture/ca.pem > "$WORK/inside.out" 2>&1
count "$WORK/inside.out"
probe neighbour "$PROXY_NET" -e STACK_ADDRESSES="${STUB}:8080,${RELAY_AI}:8317" -e RELAY_PROXY_ADDRESS="$RELAY_PX" > "$WORK/neighbour.out" 2>&1
count "$WORK/neighbour.out"
docker run --rm --label "$LABEL" --network "${P}_ai" --entrypoint node "$BACKEND_IMAGE" \
  -e "require('net').connect(8080,'${STUB}').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
  && ok "control: the stand-in listener is reachable on the ai network" || bad "control: stand-in listener reachable on ai"

# --- logs -------------------------------------------------------------------------------------------------
docker logs "fx-${P}-proxy" > "$WORK/fxproxy.log" 2>&1
docker logs "$RELAY" > "$WORK/relay.log" 2>&1
grep -q "responses call 2 model=synthetic-proxy-model stream=true host=fxproxy:8317" "$WORK/fxproxy.log" \
  && ok "proxy received both streamed Responses calls with the synthetic model and its own Host" || bad "proxy request log"
! grep -q -- "$SYNTHETIC_KEY" "$WORK/relay.log" "$WORK/fxproxy.log" "$WORK/up.out" "$WORK/inside.out" "$WORK/neighbour.out" \
  && ok "the synthetic key appears in no log" || bad "synthetic key leaked into a log"
sed 's/^/    relay | /' "$WORK/relay.log"

echo "passes=${passes} failures=${failures}"
[[ "$failures" == 0 ]]
