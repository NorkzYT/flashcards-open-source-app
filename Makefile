COMPOSE_FILE=infra/docker/compose.yml

up:
	docker compose -f $(COMPOSE_FILE) up -d --build

db-up:
	docker compose -f $(COMPOSE_FILE) up -d postgres migrate

down:
	docker compose -f $(COMPOSE_FILE) down

db-down:
	docker compose -f $(COMPOSE_FILE) down

dev:
	docker compose -f $(COMPOSE_FILE) up --build

build:
	npm ci --prefix apps/auth
	npm run build --prefix apps/auth
	npm ci --prefix apps/backend
	npm run build --prefix apps/backend
	npm ci --prefix apps/web
	npm run build --prefix apps/web
	npm ci --prefix apps/admin
	npm run build --prefix apps/admin
	npm ci --prefix infra/aws
	npm run build --prefix infra/aws

lint:
	npm run build --prefix apps/auth
	npm run lint --prefix apps/backend
	npm run build --prefix apps/web
	npm run build --prefix apps/admin
	npm run build --prefix infra/aws

migrate:
	bash scripts/deploy/migrate.sh

migrate-aws:
	bash scripts/deploy/migrate-aws.sh

check-api-health:
	bash scripts/checks/check-api-health.sh

check-public-endpoints:
	bash scripts/checks/check-public-endpoints.sh

auth-dev:
	cd apps/auth && node --env-file=../../.env ./node_modules/tsx/dist/cli.mjs watch src/index.ts

backend-dev:
	npm run dev --prefix apps/backend

web-dev:
	cd apps/web && node --env-file=../../.env ./node_modules/vite/bin/vite.js

admin-dev:
	cd apps/admin && node --env-file=../../.env ./node_modules/vite/bin/vite.js

local-admin:
	bash scripts/local/admin-prod-readonly.sh

local-app:
	bash scripts/local/app.sh

# --- Standalone self-hosting (project nibomo on one Docker host; not the AWS deployment) ----------
# Operator commands for docs/self-hosting.md. They only call infra/selfhost/setup.sh and compose.sh,
# which hold every guard; Make reads no .env and runs no Docker itself. Works from any directory:
#   make -f sourc/Makefile selfhost-help          (from the deployment root)
# INSTANCE selects the instance directory, on the command line only; an INSTANCE environment
# variable is ignored, and refused under `make -e`.
SELFHOST_CHECKOUT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
INSTANCE = /opt/docker/containers/nibomo
SELFHOST_TARGETS := selfhost-help selfhost-setup selfhost-check selfhost-up selfhost-status selfhost-logs
.PHONY: $(SELFHOST_TARGETS)

# Values reach the recipes as environment variables, never spliced into shell text.
$(SELFHOST_TARGETS): export SELFHOST_INSTANCE := $(INSTANCE)
$(SELFHOST_TARGETS): export SELFHOST_INSTANCE_ORIGIN := $(origin INSTANCE)
$(SELFHOST_TARGETS): export SELFHOST_CHECKOUT := $(SELFHOST_CHECKOUT)
$(SELFHOST_TARGETS): export SELFHOST_SERVICES := $(SERVICES)
$(SELFHOST_TARGETS): export SELFHOST_FOLLOW := $(FOLLOW)

SELFHOST_GUARD = fail() { echo "ERROR: $$*" >&2; exit 2; }; \
	[ "$$SELFHOST_INSTANCE_ORIGIN" != "environment override" ] || fail "INSTANCE from the environment is refused; pass INSTANCE=<dir> on the make command line"; \
	case "$$SELFHOST_INSTANCE" in /*) ;; *) fail "INSTANCE must be an absolute path";; esac; \
	case "$$SELFHOST_INSTANCE" in *[!A-Za-z0-9/._-]* | *..* | *//*) fail "INSTANCE must use only letters, digits, / . _ - (no .., no //)";; esac; \
	S="$$SELFHOST_CHECKOUT/infra/selfhost"; I="$${SELFHOST_INSTANCE%/}"

selfhost-help:
	@echo "Standalone self-hosting (Docker Compose project from <instance>/.env, default nibomo)."
	@echo "Instance: $$SELFHOST_INSTANCE   (override: INSTANCE=/abs/dir on the command line)"
	@echo ""
	@echo "  selfhost-setup   create .env, secrets/ and a deployment-root Makefile if missing (never overwrites)"
	@echo "  selfhost-check   validate .env and secrets/ (setup.sh --check; no Docker)"
	@echo "  selfhost-up      selfhost-check, then compose.sh <instance> up -d --build"
	@echo "  selfhost-status  compose.sh <instance> ps"
	@echo "  selfhost-logs    compose.sh <instance> logs --tail=200 [SERVICES='auth backend'] [FOLLOW=1]"
	@echo ""
	@echo "From the deployment root: make -f sourc/Makefile <target>, or make <target> after selfhost-setup."

selfhost-setup:
	@$(SELFHOST_GUARD); \
	case "$$SELFHOST_CHECKOUT" in *[!A-Za-z0-9/._-]*) fail "checkout path $$SELFHOST_CHECKOUT has characters outside A-Z a-z 0-9 / . _ -";; esac; \
	if [ -e "$$I/.env" ] && ! grep -q '^NIBOMO_INSTANCE_ID=' "$$I/.env"; then \
	  fail "$$I/.env lacks NIBOMO_INSTANCE_ID and this target never edits an existing .env; run setup.sh directly (docs/self-hosting.md)"; fi; \
	set -x; bash "$$S/setup.sh" "$$I" || exit 1; { set +x; } 2>/dev/null; \
	t="$$I/Makefile"; \
	if [ -e "$$t" ] || [ -L "$$t" ]; then echo "Kept existing $$t"; exit 0; fi; \
	tmp="$$(mktemp "$$I/.Makefile.XXXXXX")" || exit 1; \
	if ! sed -e "s#@INSTANCE@#$$I#g" -e "s#@SOURCE_MAKEFILE@#$$SELFHOST_CHECKOUT/Makefile#g" \
	  "$$S/Makefile.deployment" > "$$tmp" || ! chmod 0644 "$$tmp"; then rm -f "$$tmp"; exit 1; fi; \
	if ln "$$tmp" "$$t" 2>/dev/null; then echo "Created $$t (run make selfhost-help there)"; \
	elif [ -e "$$t" ]; then echo "Kept existing $$t"; \
	else rm -f "$$tmp"; fail "could not create $$t"; fi; \
	rm -f "$$tmp"

selfhost-check:
	@$(SELFHOST_GUARD); set -x; bash "$$S/setup.sh" --check "$$I"

selfhost-up:
	@$(SELFHOST_GUARD); set -x; bash "$$S/setup.sh" --check "$$I" && bash "$$S/compose.sh" "$$I" up -d --build

selfhost-status:
	@$(SELFHOST_GUARD); set -x; bash "$$S/compose.sh" "$$I" ps

selfhost-logs:
	@$(SELFHOST_GUARD); \
	if printf '%s' "$$SELFHOST_SERVICES" | grep -q '[^a-z0-9 _-]'; then fail "SERVICES must be service names separated by spaces"; fi; \
	case "$$SELFHOST_FOLLOW" in "" | 0) f="";; 1) f="-f";; *) fail "FOLLOW must be 1 or empty";; esac; \
	set -x; bash "$$S/compose.sh" "$$I" logs --tail=200 $$f $$SELFHOST_SERVICES
