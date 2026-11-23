#!/usr/bin/env bash
# Bounded local test of private-ingress.Caddyfile with a throwaway lab CA: the real pinned Caddy
# listens on loopback only, an echo upstream stands in for the gateway. It proves the template's
# Host/path pass-through, PROXY-header client address, SNI/Host strictness and loopback bind. It
# does not prove anything about a tailnet, Tailscale Services or a real certificate.
#
#   bash infra/selfhost/tests/private-ingress.sh <absolute empty scratch directory>
# shellcheck disable=SC2016  # bash -c bodies are single-quoted on purpose; arguments come as $0..$n
set -uo pipefail

TEMPLATE="$(cd "$(dirname "$0")/.." && pwd -P)/private-ingress.Caddyfile"
IMAGE=caddy:2.10.2-alpine
WORK="${1:?usage: private-ingress.sh <absolute empty scratch directory>}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd -P)"
BASE=study.example.test
HOSTS=(app api auth mcp media)
passes=0
failures=0
check() { local name="$1"; shift; if "$@"; then echo "PASS $name"; passes=$((passes + 1)); else echo "FAIL $name"; failures=$((failures + 1)); fi; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

# Lab CA and one leaf for the five names; nothing here is trusted outside this directory.
mkdir -m 0700 "$WORK/pki" "$WORK/certs"
san="$(printf 'DNS:%s.'"$BASE"',' "${HOSTS[@]}")"; san="${san%,}"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=nibomo lab CA" \
  -keyout "$WORK/pki/ca.key" -out "$WORK/pki/ca.pem" -addext basicConstraints=critical,CA:TRUE \
  -addext keyUsage=critical,keyCertSign > /dev/null 2>&1 || { echo "openssl CA failed"; exit 1; }
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=app.$BASE" \
  -keyout "$WORK/certs/privkey.pem" -out "$WORK/pki/leaf.csr" > /dev/null 2>&1 || { echo "openssl CSR failed"; exit 1; }
openssl x509 -req -in "$WORK/pki/leaf.csr" -CA "$WORK/pki/ca.pem" -CAkey "$WORK/pki/ca.key" -days 1 \
  -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san") \
  -out "$WORK/certs/fullchain.pem" > /dev/null 2>&1 || { echo "openssl sign failed"; exit 1; }
chmod 0444 "$WORK/certs/fullchain.pem" "$WORK/certs/privkey.pem"

# Echo upstream: returns the Host, raw path+query and X-Forwarded-For it received.
cat > "$WORK/echo.py" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"host": self.headers.get("Host"), "path": self.path,
                           "xff": self.headers.get("X-Forwarded-For"),
                           "cf": self.headers.get("Cf-Connecting-Ip")}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
UP="$(free_port)"; IN="$(free_port)"
python3 -I "$WORK/echo.py" "$UP" & echo_pid=$!
name="nibomo-private-ingress-test-$$"
cleanup() { docker rm -f "$name" > /dev/null 2>&1; kill "$echo_pid" 2> /dev/null; }
trap cleanup EXIT

env_args=()
for h in "${HOSTS[@]}"; do env_args+=(-e "NIBOMO_${h^^}_HOST=$h.$BASE"); done
# The image's caddy binary carries cap_net_bind_service, so exec needs it in the bounding set.
uid="$(id -u):$(id -g)"
docker run -d --name "$name" --network host --read-only --user "$uid" --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges --tmpfs "/config:uid=$(id -u),mode=0700" --tmpfs "/data:uid=$(id -u),mode=0700" "${env_args[@]}" -e "NIBOMO_INGRESS_PORT=$IN" -e "NIBOMO_GATEWAY_PORT=$UP" \
  -v "$TEMPLATE:/etc/caddy/Caddyfile:ro" -v "$WORK/certs:/certs:ro" \
  "$IMAGE" caddy run --config /etc/caddy/Caddyfile > /dev/null || { echo "docker run failed"; exit 1; }
for _ in $(seq 50); do ss -ltnH "sport = :$IN" | grep -q . && break; sleep 0.1; done
ss -ltnH "sport = :$IN" | grep -q . || { echo "ingress did not start"; docker logs "$name" 2>&1 | tail -n 20; exit 1; }

req() { # host [extra curl args...]: GET through the ingress with a PROXY v1 header naming 100.64.0.7
  local host="$1"; shift
  curl -sS --max-time 5 --cacert "$WORK/pki/ca.pem" --resolve "$host:$IN:127.0.0.1" \
    --haproxy-protocol --haproxy-clientip 100.64.0.7 "$@" "https://$host:$IN/o/k?X-Amz-Signature=a%2Fb&x=1"
}
for h in "${HOSTS[@]}"; do
  out="$(req "$h.$BASE" -H 'Cf-Connecting-Ip: 6.6.6.6' -H 'X-Forwarded-For: 6.6.6.6' 2> "$WORK/err")"
  check "$h: Host, path and query reach the gateway unchanged" \
    python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(not (d["host"]==sys.argv[2] and d["path"]=="/o/k?X-Amz-Signature=a%2Fb&x=1"))' \
    "$out" "$h.$BASE"
  check "$h: client address from the PROXY header, client headers dropped" \
    python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(not (d["xff"]=="100.64.0.7" and d["cf"] is None))' "$out"
done
check "connection without a PROXY header is refused" \
  bash -c '! curl -sS --max-time 5 --cacert "$0" --resolve "app.$1:$2:127.0.0.1" "https://app.$1:$2/" > /dev/null 2>&1' \
  "$WORK/pki/ca.pem" "$BASE" "$IN"
check "unknown server name gets no certificate" \
  bash -c '! curl -sS --max-time 5 -k --haproxy-protocol --resolve "other.$0:$1:127.0.0.1" "https://other.$0:$1/" > /dev/null 2>&1' \
  "$BASE" "$IN"
check "Host differing from the TLS server name is refused (421)" \
  bash -c '[[ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 --cacert "$0" --haproxy-protocol --resolve "app.$1:$2:127.0.0.1" -H "Host: api.$1" "https://app.$1:$2/")" == 421 ]]' \
  "$WORK/pki/ca.pem" "$BASE" "$IN"
check "certificate is not trusted without the lab CA" \
  bash -c '! curl -sS --max-time 5 --haproxy-protocol --resolve "app.$0:$1:127.0.0.1" "https://app.$0:$1/" > /dev/null 2>&1' \
  "$BASE" "$IN"
check "the only ingress socket is on 127.0.0.1" \
  bash -c '[[ "$(ss -ltnH "sport = :$0" | awk "{print \$4}")" == "127.0.0.1:$0" ]]' "$IN"
docker exec "$name" caddy adapt --config /etc/caddy/Caddyfile > "$WORK/adapted.json" 2> /dev/null
check "adapted config: admin off, one server listening only on 127.0.0.1:$IN" \
  python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); s=c["apps"]["http"]["servers"]
sys.exit(not (c["admin"]["disabled"] and [v["listen"] for v in s.values()]==[["127.0.0.1:"+sys.argv[2]]]))' \
  "$WORK/adapted.json" "$IN"
echo "passes=$passes failures=$failures"
(( failures == 0 ))
