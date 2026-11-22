#!/usr/bin/env bash
# shellcheck disable=SC2016  # bash -c bodies are single-quoted on purpose; arguments come as $0..$n
# Synthetic test of the root Makefile's selfhost-* targets and the deployment-root Makefile that
# selfhost-setup installs. It runs real `make` commands against a throwaway copy of the checkout
# whose setup.sh/compose.sh are recording fakes (the setup case uses the real setup.sh), with a
# `docker` on PATH that fails if called. No Docker daemon, live instance or secret is touched.
#
#   bash infra/selfhost/tests/operator-make.sh <absolute empty scratch directory>
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd -P)"
WORK="${1:?usage: operator-make.sh <absolute empty scratch directory>}"
[[ "$WORK" == /* && -d "$WORK" && -z "$(ls -A "$WORK")" ]] || { echo "need an empty absolute directory" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd -P)"
passes=0
failures=0
ok() { echo "PASS $1"; passes=$((passes + 1)); }
bad() { echo "FAIL $1"; failures=$((failures + 1)); sed 's/^/    | /' "$WORK/out" 2>/dev/null | tail -n 12; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

LOG="$WORK/calls.log"
ENVLOG="$WORK/env.log"
mkdir -p "$WORK/bin"
printf '#!/bin/sh\necho "docker $*" >> %s\nexit 99\n' "$WORK/docker.log" > "$WORK/bin/docker"
chmod 0755 "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"
unset INSTANCE SERVICES FOLLOW MAKEFLAGS

# A recording fake of a selfhost script; `setup.sh --check` exits with the code in $WORK/check_rc.
fake_script() {
  cat > "$1" <<EOF
#!/usr/bin/env bash
{ printf '%s' "\$(basename "\$0")"; printf ' %s' "\$@"; echo; } >> '$LOG'
env | grep -E '^(NIBOMO_|COMPOSE_|DOTENV_SENTINEL)' >> '$ENVLOG' || true
if [[ "\$(basename "\$0")" == setup.sh && "\${1:-}" == --check ]]; then exit "\$(cat '$WORK/check_rc')"; fi
exit 0
EOF
}

# Checkout copy: the real Makefile and template, fake scripts unless real setup.sh is requested.
make_checkout() {
  local dst="$1" real_setup="${2:-}"
  mkdir -p "$dst/infra/selfhost"
  cp "$REPO/Makefile" "$dst/Makefile"
  cp "$REPO/infra/selfhost/Makefile.deployment" "$dst/infra/selfhost/"
  fake_script "$dst/infra/selfhost/compose.sh"
  if [[ -n "$real_setup" ]]; then
    cp "$REPO/infra/selfhost/setup.sh" "$REPO/infra/selfhost/env.example" "$dst/infra/selfhost/"
  else
    fake_script "$dst/infra/selfhost/setup.sh"
  fi
}

reset() { : > "$LOG"; : > "$ENVLOG"; echo 0 > "$WORK/check_rc"; }
# run <dir> <make args...>: exit code in $rc, output in $WORK/out
run() { local dir="$1"; shift; (cd "$dir" && make "$@") > "$WORK/out" 2>&1; rc=$?; }
calls_are() { [[ "$(cat "$LOG")" == "$1" ]]; }

D="$WORK/deploy"               # deployment root with fake scripts
make_checkout "$D/sourc"
printf 'DOTENV_SENTINEL=1\nNIBOMO_FROM_DOTENV=1\n' > "$D/.env"
DEF=/opt/docker/containers/nibomo

reset; run "$D" -f sourc/Makefile selfhost-help
check "help exits 0 and names every target" bash -c '[[ $0 == 0 ]] && grep -q selfhost-up "$1" && grep -q selfhost-logs "$1"' "$rc" "$WORK/out"
check "help calls nothing" calls_are ""

reset; run "$D" -f sourc/Makefile selfhost-check
check "check: only setup.sh --check on the default instance" bash -c '[[ $0 == 0 ]]' "$rc"
check "check call list" calls_are "setup.sh --check $DEF"

reset; run "$D" -f sourc/Makefile selfhost-up INSTANCE="$D"
check "up exits 0" test "$rc" = 0
check "up: check then compose up -d --build, nothing else" calls_are "setup.sh --check $D
compose.sh $D up -d --build"

reset; echo 1 > "$WORK/check_rc"; run "$D" -f sourc/Makefile selfhost-up INSTANCE="$D"
check "up with failing check exits non-zero" test "$rc" != 0
check "up with failing check never calls compose" calls_are "setup.sh --check $D"

reset; echo 1 > "$WORK/check_rc"; run "$D" -i -f sourc/Makefile selfhost-up INSTANCE="$D"
check "make -i still never runs compose after a failed check" calls_are "setup.sh --check $D"

reset; run "$D" -n -f sourc/Makefile selfhost-up INSTANCE="$D"
check "make -n executes nothing" calls_are ""

reset; run "$D" -f sourc/Makefile selfhost-status INSTANCE="$D"
check "status: compose ps" calls_are "compose.sh $D ps"

reset; run "$D" -f sourc/Makefile selfhost-logs INSTANCE="$D" SERVICES="auth backend" FOLLOW=1
check "logs with services and follow" calls_are "compose.sh $D logs --tail=200 -f auth backend"

reset; run "$D" -f sourc/Makefile selfhost-logs INSTANCE="$D" SERVICES='auth; touch '"$WORK"'/pwned'
check "logs refuses a shell-like SERVICES" bash -c '[[ $0 == 2 && ! -e $1 && ! -s $2 ]]' "$rc" "$WORK/pwned" "$LOG"

reset; run "$D" -f sourc/Makefile selfhost-logs INSTANCE="$D" FOLLOW=yes
check "logs refuses FOLLOW other than 1" bash -c '[[ $0 == 2 && ! -s $1 ]]' "$rc" "$LOG"

reset; run "$D" -f sourc/Makefile selfhost-up INSTANCE="/tmp/x;touch $WORK/pwned"
check "unsafe INSTANCE refused before any script" bash -c '[[ $0 == 2 && ! -e $1 && ! -s $2 ]]' "$rc" "$WORK/pwned" "$LOG"
reset; run "$D" -f sourc/Makefile selfhost-up INSTANCE=relative/dir
check "relative INSTANCE refused" bash -c '[[ $0 == 2 && ! -s $1 ]]' "$rc" "$LOG"
reset; run "$D" -f sourc/Makefile selfhost-help INSTANCE='$(touch '"$WORK"'/pwned)'
check "help does not evaluate INSTANCE" test ! -e "$WORK/pwned"

reset; (cd "$D" && INSTANCE=/somewhere/else make -f sourc/Makefile selfhost-status) > "$WORK/out" 2>&1
check "ambient INSTANCE is ignored" calls_are "compose.sh $DEF ps"
reset; (cd "$D" && INSTANCE=/somewhere/else make -e -f sourc/Makefile selfhost-status) > "$WORK/out" 2>&1; rc=$?
check "make -e with ambient INSTANCE refused" bash -c '[[ $0 == 2 && ! -s $1 ]]' "$rc" "$LOG"

reset; run "$D" -f sourc/Makefile selfhost-up INSTANCE="$D"
check "Make loads no .env and exports no NIBOMO_/COMPOSE_ variables" test ! -s "$ENVLOG"

reset; run "$WORK" -f "$D/sourc/Makefile" selfhost-status INSTANCE="$D"
check "works from an unrelated cwd" calls_are "compose.sh $D ps"

run "$D/sourc" -n
check "bare make still prints the upstream dev 'up' recipe" grep -qx 'docker compose -f infra/docker/compose.yml up -d --build' "$WORK/out"
upstream="$(git -C "$REPO" show HEAD:Makefile 2>/dev/null)" || upstream=""
if [[ -n "$upstream" ]]; then
  (cd "$D/sourc" && printf '%s\n' "$upstream" | make -f - -n up db-up down db-down dev build lint migrate migrate-aws local-app) > "$WORK/a" 2>&1
  (cd "$D/sourc" && make -n up db-up down db-down dev build lint migrate migrate-aws local-app) > "$WORK/b" 2>&1
  check "upstream targets unchanged versus HEAD" cmp -s "$WORK/a" "$WORK/b"
fi

section="$(sed -n '/^# --- Standalone self-hosting/,$p' "$REPO/Makefile"; cat "$REPO/infra/selfhost/Makefile.deployment")"
check "selfhost Make code has no docker/prune/down/force/env include" \
  bash -c '! grep -Eiq "docker (compose|run|rm|system|volume)|prune|[^a-z]down|--force|-v |include|sinclude|export NIBOMO|\.env\b[^\"]*=" <<<"$(grep -v "^\s*#\|^\s*@echo" <<<"$0")"' "$section"

# --- selfhost-setup with the real setup.sh and the deployment-root Makefile ---------------------
R="$WORK/root"
make_checkout "$R/sourc" real
reset; run "$R" -f sourc/Makefile selfhost-setup INSTANCE="$R"
check "setup exits 0" test "$rc" = 0
check "setup created .env bound to the instance" grep -qx "NIBOMO_INSTANCE_DIR=$R" "$R/.env"
check "setup created the root Makefile" grep -q "^SELFHOST_INSTANCE := $R\$" "$R/Makefile"
check "setup did not run --check or compose" bash -c '! grep -q . "$0"' "$LOG"
env_sum="$(sha256sum "$R/.env")"
mk_sum="$(sha256sum "$R/Makefile")"
secrets_sum="$(cd "$R/secrets" && sha256sum ./*)"
reset; run "$R" -f sourc/Makefile selfhost-setup INSTANCE="$R"
check "setup re-run keeps .env, root Makefile and secrets byte-identical" \
  bash -c '[[ $0 == 0 && "$(sha256sum "$1/.env")" == "$2" && "$(sha256sum "$1/Makefile")" == "$3" && "$(cd "$1/secrets" && sha256sum ./*)" == "$4" ]]' \
  "$rc" "$R" "$env_sum" "$mk_sum" "$secrets_sum"
check "no temp files left" bash -c '! ls -A "$0" | grep -q "^\.Makefile\."' "$R"

fake_script "$R/sourc/infra/selfhost/setup.sh"   # the generated .env is unfilled; fake its check
reset; run "$R" selfhost-up
check "root 'make selfhost-up' runs check then compose for this instance" calls_are "setup.sh --check $R
compose.sh $R up -d --build"
reset; run "$R"
check "bare make in the deployment root shows help only" bash -c '[[ $0 == 0 ]] && grep -q selfhost-up "$1" && [[ ! -s $2 ]]' "$rc" "$WORK/out" "$LOG"
reset; run "$R" up
check "root Makefile does not expose upstream dev targets" bash -c '[[ $0 != 0 && ! -s $1 ]]' "$rc" "$LOG"
reset; run "$R" selfhost-up INSTANCE=/other
check "root Makefile refuses another INSTANCE" bash -c '[[ $0 != 0 && ! -s $1 ]]' "$rc" "$LOG"
reset; run "$R" selfhost-logs SERVICES=auth
check "root Makefile forwards SERVICES" calls_are "compose.sh $R logs --tail=200 auth"

# Existing Makefile in the deployment root is never replaced.
K="$WORK/keep"
make_checkout "$K/sourc" real
mkdir -p "$K"; printf 'mine:\n\techo mine\n' > "$K/Makefile"
reset; run "$K" -f sourc/Makefile selfhost-setup INSTANCE="$K"
check "existing root Makefile kept" bash -c '[[ $0 == 0 && "$(cat "$1")" == "$(printf "mine:\n\techo mine")" ]]' "$rc" "$K/Makefile"

# An older .env without NIBOMO_INSTANCE_ID is refused, not appended to.
O="$WORK/old"
make_checkout "$O/sourc" real
printf 'NIBOMO_INSTANCE_DIR=%s\n' "$O" > "$O/.env"
old_sum="$(sha256sum "$O/.env")"
reset; run "$O" -f sourc/Makefile selfhost-setup INSTANCE="$O"
check "setup refuses to edit an existing .env" \
  bash -c '[[ $0 == 2 && "$(sha256sum "$1/.env")" == "$2" && ! -e $1/secrets && ! -e $1/Makefile ]]' "$rc" "$O" "$old_sum"

check "docker was never called" test ! -e "$WORK/docker.log"
echo "${passes} passed, ${failures} failed"
[[ "$failures" == 0 ]]
