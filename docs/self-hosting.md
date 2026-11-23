# Self-hosting with Docker Compose (standalone mode)

An opt-in deployment that runs Nibomo on one Docker host without an AWS account. The AWS deployment
and every released client contract are unchanged: nothing here activates unless an operator sets the
standalone settings below.

Status: authenticated web/API/auth, core study, media storage (RustFS) including multipart uploads
and scheduled media maintenance, MCP with OAuth for AI assistants, the durable AI chat worker
(optional; funded by an operator key or by each person's own key) and backup/restore. Not yet
available in standalone mode (they need AWS today and fail with an error instead of falling back):
Apple/Google sign-in, account deletion (Cognito user removal), the chat bash sandbox and PDF
page rendering, billing and Sentry. No AWS credential is configured and instance metadata is
disabled; without an AI overlay the backend has no outbound network at all.

## Design decisions

- **Identity: an in-process local provider in the existing auth service, not a new identity server.**
  `AUTH_IDENTITY_PROVIDER=local` (auth) and `AUTH_MODE=local` (backend) replace only the Cognito
  email-OTP boundary ([provider](../apps/auth/src/server/local/), [dispatch](../apps/auth/src/server/identity/emailOtp.ts),
  [backend verifier](../apps/backend/src/auth/localIdentityVerifier.ts), [schema](../db/migrations/0254_standalone_local_identity.sql)).
  The browser and native routes, the 8-digit code, OTP send/verify throttles and lockouts, the
  principal session fence, account/workspace mapping (`auth.user_identities`), agent API keys and
  cookies are the existing code paths. Adding Keycloak or similar would add a service and still need
  this adapter, because clients speak this service's OTP contract, not OIDC.
- **Tokens:** RS256 ID tokens (1 h) bound to this deployment's issuer (`https://auth.<base>`),
  audience (a per-instance client id) and key; verified with the same `aws-jwt-verify` library from
  the configured key only, never fetched. Refresh tokens are opaque 256-bit values stored as SHA-256,
  with a rolling 30-day idle and 365-day absolute expiry. Each sign-in is a session family: refresh
  rotates, reuse of a rotated token revokes the family, and logout revokes it so issued ID tokens
  stop before `exp` (contract in [auth-service.md](auth-service.md),
  [0257](../db/migrations/0257_standalone_local_session_families.sql)). OTP codes and challenge
  secrets are stored only as keyed HMACs.
- **Registration is closed by default:** only `NIBOMO_ALLOWED_EMAILS` / `NIBOMO_ALLOWED_EMAIL_DOMAINS`
  can create an account; other addresses get an identical response and no mail. Administrators come
  only from `NIBOMO_ADMIN_EMAILS`, applied by the migration job (`scripts/deploy/migrate.sh`).
- **Email:** SMTP through `nodemailer` with mandatory STARTTLS or implicit TLS and normal certificate
  validation. Plaintext SMTP is accepted only for the captured test mailbox
  (`NIBOMO_DEV_MAILBOX=true`; `setup.sh --check` enforces its isolation: own project, `mailpit:1025`,
  no SMTP login, loopback gateway).
- **Database:** PostgreSQL 18 with the repository's migration driver as a one-shot job; services
  start only after it succeeds and connect as `backend_app` / `auth_app`, never as the owner.
- **Gateway:** pinned Caddy serving the built web app and routing strictly by Host; unknown hosts
  get `421`. It resolves the client address right-to-left through `NIBOMO_GATEWAY_TRUSTED_PROXIES`
  only, forwards exactly that address, and strips `Cf-Connecting-Ip`, so a client cannot choose the
  address the OTP IP throttles count. Sign-in mail is sent after the response, so neither timing nor
  status reveals which addresses may sign in; delivery failures are logged.

- **Media: RustFS 1.0.6** (pinned by digest) behind the existing S3 abstraction
  (`MEDIA_ASSETS_STORAGE_PROFILE=rustfs`, [config](../apps/backend/src/mediaAssets/storage/config.ts)).
  Storage I/O uses the private `objectstore:9000`; presigned URLs are signed for
  `https://<NIBOMO_MEDIA_HOST>` and the gateway forwards them with Host, path, query and headers
  unchanged, so no internal address reaches a browser or phone. The gateway accepts only presigned
  `GET`/`HEAD`/`PUT` object requests in the media bucket and refuses everything else (listing,
  bucket and admin calls, multipart and other sub-resources, header-signed or unsigned requests);
  CORS allows only `https://<NIBOMO_APP_HOST>`. The bucket is private; the hosted expiry rules for
  `media/uploads/`, `chat-files/uploads/` and `workspace-exports/` are applied by the one-shot
  `objectstore-init` job ([script](../infra/selfhost/objectstore-init.sh)), which also creates a
  bucket-scoped application user (object read/write/delete and listing of this bucket only, no
  administration) and verifies it. Only RustFS and that job hold the root credential.
  RustFS omits single-part checksum types, so the backend proves them by re-reading the object.
  Multipart uploads work: the gateway admits only a backend-signed `UploadPart` (`partNumber`,
  `uploadId` and the signature query, nothing else), and completion uses the completed-parts
  manifest ([0256](../db/migrations/0256_multipart_completed_parts_manifests.sql)) with a
  whole-object read; without that store a completion is refused with
  `MEDIA_ASSET_MULTIPART_UNSUPPORTED_BY_STORAGE`. The application user's policy is
  `nibomo-media-v2` (adds `s3:ListMultipartUploadParts`).
- **Media maintenance: `media-maintenance`** (backend image,
  [entrypoint](../apps/backend/src/entrypoints/media-maintenance-node.ts),
  [cycle](../apps/backend/src/maintenance/standaloneMediaMaintenance.ts)) replaces the two scheduled
  media Lambdas: generated-media promotion with orphaned-blob and released chat-file cleanup, and
  multipart completion reconciliation. It runs the same batch functions behind the same database
  claim fences and conditional deletes, one cycle at a time across processes (PostgreSQL advisory
  lock). It always runs, with or without AI, as `backend_app` with the bucket-scoped storage user,
  and has no published port and no outbound network.
- **AI: a Postgres-backed worker** (`worker`, same image as the backend,
  [entrypoint](../apps/backend/src/entrypoints/chat-worker-node.ts)). A chat run and its dispatch row
  are written in one transaction ([0255](../db/migrations/0255_chat_run_standalone_dispatch.sql)); the
  worker leases rows ([0258](../db/migrations/0258_chat_run_dispatch_lease_fence.sql) fences the
  lease) and never re-executes a run that left `queued`. `NIBOMO_AI_PROVIDER` picks the funding:
  - `none` (default): no worker; chat answers `AI_PROVIDER_NOT_CONFIGURED`.
  - `openai`: the operator's key in `secrets/openai_api_key`
    ([compose.ai.yml](../infra/selfhost/compose.ai.yml)); each person gets
    `NIBOMO_AI_MONTHLY_MESSAGES` per UTC month. Personal keys are refused unless
    `NIBOMO_AI_PERSONAL_KEYS=sealed`.
  - `user-key`: no operator key is mounted anywhere
    ([compose.ai-user-key.yml](../infra/selfhost/compose.ai-user-key.yml)); each person uses their
    own OpenAI key, and a keyless turn is refused with `OPENAI_API_KEY_REQUIRED_STANDALONE`.

  A personal key is held only as ciphertext under `secrets/chat_credential_key`, bound to the run and
  `NIBOMO_INSTANCE_ID`, and opened once by the worker at claim. [compose.sh](../infra/selfhost/compose.sh)
  adds the matching overlay, the `ai` profile and the API's settings together, so the API never
  accepts runs no worker executes; both overlays give `backend` and `worker` outbound HTTPS. The
  worker is healthy only while its dispatch polls reach Postgres.

- **AI chat live stream: served by the backend itself** at `https://<NIBOMO_API_HOST>/v1/chat/live`
  ([route](../apps/backend/src/chat/live/standalone.ts)), the same SSE handler the AWS chat-live
  function runs, so clients attach unchanged with the `liveStream` URL and run-scoped `Live` token
  from `POST /v1/chat` (10-minute expiry, bound to user, workspace, session and run). Tokens are
  HMAC-signed with `secrets/chat_live_auth_secret`, generated by setup.sh and mounted only on
  `backend`; the backend refuses to start if an AWS secret ARN is also set or `CHAT_LIVE_URL` names
  another host. Rotating the file and recreating `backend` invalidates open live tokens; clients
  re-read the chat and attach again. Stopping or restarting `backend` ends open streams without a
  terminal event and clients resume from their cursor; the run itself belongs to the worker.

- **MCP: the same MCP app as on AWS, served by a Node process** (`mcp`, backend image,
  [entrypoint](../apps/backend/src/entrypoints/mcp-node.ts), [guard](../apps/backend/src/mcp/standalone.ts))
  at `https://<NIBOMO_MCP_HOST>/mcp`, which must be `mcp.<base>`; the OAuth authorization server is
  the auth service at `https://auth.<base>`. It serves the shared tool inventory with agent keys
  (`fca_`) and OAuth access tokens (`fco_`) and keeps the hosted limits per process (4 concurrent
  requests per token, 16 in total; excess gets `429` with `Retry-After`). Only `mcp.<base>` and the
  optional `NIBOMO_MCP_ALTERNATE_HOST` are answered; a token works only on the host it was issued
  for, and a request with an Origin header must name one of `NIBOMO_MCP_ALLOWED_ORIGINS`. OAuth
  id_tokens are signed with `secrets/oidc_signing_key.pem`, which setup.sh generates separately
  from the session identity key. Rotation: write the new key to that path, put the old public key
  in an `OIDC_VERIFICATION_KEYS_FILE` PEM bundle mounted on `auth` until issued id_tokens expire
  (1 h), and recreate `auth`. Limits: one `mcp` replica (the limiter is in-process); there is no
  in-product way yet to revoke one OAuth connection (agent keys can be revoked), so its refresh
  token stays usable until it expires.

## Topology

| Service | Image | Network | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:18.7` | internal | volume `pgdata`; no published port |
| `migrate` | built (`Dockerfile.migrate`) | internal | one-shot; gates `auth` and `backend` |
| `objectstore` | `rustfs/rustfs:1.0.6@sha256:ee717072…05044a` | storage | volume `objectdata`; no published port, console off |
| `objectstore-init` | built (`Dockerfile.objectstore-init`: the same pinned RustFS image + init script) | storage | one-shot; gates `backend` and `worker` |
| `auth` | built (`apps/auth/Dockerfile`, `standalone` stage) | internal + app + egress | egress only for SMTP |
| `backend` | built (`apps/backend/Dockerfile`, `standalone` stage) | internal + app + storage (+ egress, or `ai` with a proxy) | healthy only when `/v1/health` reaches Postgres |
| `mcp` | backend image (`entrypoints/mcp-node.js`) | internal + app | healthy on `/health`; no outbound route |
| `worker` | backend image, profile `ai` | internal + storage + egress (or `ai` with a proxy) | only with an AI overlay |
| `media-maintenance` | backend image (`entrypoints/media-maintenance-node.js`) | internal + storage | always; healthy while cycles succeed; no outbound route |
| `gateway` | built (`Dockerfile.gateway`, Caddy 2.10.2) | app + edge + storage | the only published port, loopback by default; cannot reach Postgres |

No service bind-mounts a file from the source checkout: the migration SQL and driver, the init script
and `runtime-env.sh` are baked into their images with fixed root-owned, read-only modes, so a checkout
made under a strict umask (for example `077`) installs the same way as one made under `022`.

Credentials are files in `<instance>/secrets/` (directory `0700`, files `0444` so container users
can read their mounted copy; keep that directory's mode in every copy and backup) mounted as
Compose secrets; DSNs are assembled inside
the container at start ([runtime-env.sh](../infra/selfhost/runtime-env.sh)). The API signs browser
session CSRF tokens with `secrets/backend_csrf_secret` (generated once, never from AWS) and refuses to
start without it. Settings are in
`<instance>/.env`, documented in [env.example](../infra/selfhost/env.example).

## Hosts, DNS and TLS

Pick a base domain you control, e.g. `study.example.com`, and point `app.`, `api.`, `auth.`, `mcp.`
(plus `NIBOMO_MCP_ALTERNATE_HOST` if set) and the
media host (`NIBOMO_MEDIA_HOST`, e.g. `media.`) at the host. The web app derives `api.`/`auth.` from its `app.` host, and the Android custom-server setting
derives the same hosts from `https://<base>`. AI assistants connect to `https://mcp.<base>/mcp`.
Terminate trusted TLS for all of them in your existing
reverse proxy and forward them to `127.0.0.1:8088` with the original `Host`, path and query
unchanged and without response caching (media URLs are signed for that exact Host and path, and
uploads can be large: allow request bodies up to 5 GiB on the media host); then set
`NIBOMO_GATEWAY_TRUSTED_PROXIES` to the exact `/32` your proxy's connections arrive from as the
gateway container sees them, never a broad range: a host proxy forwarding to the published loopback
port arrives as the `<project>_edge` bridge gateway (`docker network inspect -f
'{{range .IPAM.Config}}{{.Gateway}}{{end}}' <project>_edge`), not `127.0.0.1`. Confirm it against an
observed request, e.g. that the OTP throttle sees distinct client addresses rather than one shared
proxy address. Cookies are `Secure`, so browsers and
phones need HTTPS; a plain `http://IP:PORT` setup is not a supported client configuration.

For a tailnet-only instance, including on a host whose Tailscale node already serves a public
Funnel, see [private tailnet ingress](self-hosting-private-tailnet.md); a `ts.net` base domain is
refused because the session cookies would be shared across the tailnet.

## Operator commands

The deployment directory holds the checkout in `sourc/` plus the instance state, which is never in
Git: `.env`, `secrets/` and the backups you choose to write. Docker volumes are
`<project>_pgdata` and `<project>_objectdata` (project `nibomo`); a different project name means
different, empty volumes. Every Compose command goes through `compose.sh`, which fixes the project,
env file, Docker endpoint and overlays from `.env` and refuses shell `NIBOMO_*`/`COMPOSE_*`/
`DOCKER_CONTEXT` overrides and a project started from another checkout, instance or overlay (rules in
[compose-lib.sh](../infra/selfhost/compose-lib.sh)):

```bash
cd /opt/docker/containers/nibomo
bash sourc/infra/selfhost/setup.sh "$PWD"           # once; safe to re-run, never overwrites
"${EDITOR:-vi}" .env                                 # hosts, media host, allowlist, admins, SMTP, image tag, AI
bash sourc/infra/selfhost/setup.sh --check "$PWD"
bash sourc/infra/selfhost/compose.sh "$PWD" up -d --build
bash sourc/infra/selfhost/compose.sh "$PWD" ps
bash sourc/infra/selfhost/compose.sh "$PWD" logs -f auth backend worker
bash sourc/infra/selfhost/compose.sh "$PWD" restart backend
```

The same steps as Make targets of the checkout's root `Makefile` (they call only `setup.sh` and
`compose.sh`; Make reads no `.env` and runs no Docker itself). `selfhost-setup` also installs a small
`Makefile` in the deployment root if none exists, so the short form works there; it never replaces a
file or edits an existing `.env`:

```bash
cd /opt/docker/containers/nibomo
make -f sourc/Makefile selfhost-setup     # once; then edit .env yourself
make selfhost-check                       # setup.sh --check
make selfhost-up                          # selfhost-check, then up -d --build
make selfhost-status                      # ps
make selfhost-logs SERVICES='auth backend' FOLLOW=1
```

Without the root `Makefile`, use `make -f sourc/Makefile <target>`. Another instance directory is
selected only on the command line (`INSTANCE=/abs/dir`, the default is `/opt/docker/containers/nibomo`).
Synthetic test of these targets: `bash infra/selfhost/tests/operator-make.sh <empty scratch dir>`.

AI: for `openai`, put the key in `secrets/openai_api_key` (keep mode `0444` inside the `0700`
directory); `user-key` needs no key file. Optional for `openai`: `NIBOMO_AI_PERSONAL_KEYS=sealed`.
`compose.sh` refuses to address a project whose containers were created with a different overlay
set, so changing `NIBOMO_AI_PROVIDER` (including enabling or disabling AI) is: with the old `.env`
still in place, `compose.sh "$PWD" down` (no `-v`; volumes stay), edit `.env`, run
`setup.sh --check`, then `up -d`. With AI `none` the API refuses new chat runs; runs still queued
are delivered when AI is enabled again.

An instance created before media/AI support: re-run `setup.sh` (adds only the missing secrets) and
add `NIBOMO_COMPOSE_PROJECT`, `NIBOMO_MEDIA_HOST`, `NIBOMO_MEDIA_BUCKET`, `NIBOMO_AI_PROVIDER`,
`NIBOMO_AI_PERSONAL_KEYS` and `NIBOMO_AI_MONTHLY_MESSAGES` from [env.example](../infra/selfhost/env.example)
to `.env`.
An instance created before personal-key sealing: re-run `setup.sh` (adds `secrets/chat_credential_key`
and appends `NIBOMO_INSTANCE_ID` to `.env`).
An instance created before multipart support: the next `up -d` reruns `objectstore-init`, which
replaces the application user's policy with `nibomo-media-v2`, and starts `media-maintenance`.
An instance created before the standalone live stream: re-run `setup.sh` (adds
`secrets/chat_live_auth_secret`; `compose.sh` refuses to start without it).
An instance created before the browser CSRF key: re-run `setup.sh` (adds
`secrets/backend_csrf_secret`); `selfhost-check` reports it missing until then.
An instance created before MCP support: re-run `setup.sh` (adds `secrets/oidc_signing_key.pem`),
add `NIBOMO_MCP_HOST`, `NIBOMO_MCP_ALTERNATE_HOST` and `NIBOMO_MCP_ALLOWED_ORIGINS`, and route
`mcp.<base>` through DNS, TLS and your proxy. The API now advertises `https://mcp.<base>/mcp` in its
agent discovery and requires that host's configuration to start.

Updating: take a backup, then `git -C sourc fetch` and check out the tested commit, set
`NIBOMO_IMAGE_TAG` to it, read the "instance created before" notes above, and run the same
`up -d --build` (or `make selfhost-up`); the migration job runs before the services restart.
Updating across [0257](../db/migrations/0257_standalone_local_session_families.sql) signs every user
out once. A forward-migrated database is not valid for older images, so rollback means restoring
the pre-upgrade backup with the previous checkout and tag, not just starting old images.
The job applies each migration file together with its `schema_migrations` row, so a failed or
interrupted file leaves neither and earlier files of the same update stay applied; it fails, and
nothing starts, on an invalid `NIBOMO_ADMIN_EMAILS` entry, an empty database secret or a missing
runtime role. Fix the input and run `up -d` again; never edit `schema_migrations` by hand.

## Keys and secrets

`setup.sh` generates every file below once and never replaces one; back up `secrets/` with the
database, because a lost key cannot be regenerated without the effect listed. Replace a file by
writing a new one beside it with the same generator `setup.sh` uses ([setup.sh](../infra/selfhost/setup.sh)),
mode `0444`, then renaming it over the old one; Compose secrets are read at container start, so
recreate the named services with `compose.sh "$PWD" up -d --force-recreate <services>`.

| File | Used by | Effect of replacing it |
| --- | --- | --- |
| `local_auth_signing_key.pem` + `local_auth_public_key.pem` | `auth` signs, `backend` verifies ID tokens | Replace both together, recreate `auth` and `backend`. There is no overlap bundle: ID tokens signed with the old key (at most 1 h old) are refused; refresh tokens are database rows and stay valid |
| `oidc_signing_key.pem` | `auth` (MCP OAuth id_tokens) | Overlap procedure in the MCP decision above (`OIDC_VERIFICATION_KEYS_FILE`); must differ from the session key |
| `session_encryption_key` | `auth` (OTP cookies, OTP code and refresh-successor HMACs) | Pending sign-in codes and an in-flight refresh retry fail; recreate `auth` |
| `chat_live_auth_secret` | `backend` (live-stream tokens) | Open live tokens fail; clients re-attach (see the live-stream decision) |
| `chat_credential_key`, with `NIBOMO_INSTANCE_ID` in `.env` | `backend`, `worker` (sealed personal keys) | Personal-key runs queued in the last 10 minutes are interrupted; keep both stable |
| `openai_api_key` | `backend`, `worker` (AI `openai` only) | Recreate `backend` and `worker` |
| `db_backend_password`, `db_auth_password` | `migrate` sets them on `backend_app` / `auth_app` at every run | `compose.sh "$PWD" up -d --force-recreate migrate auth backend mcp worker media-maintenance` (omit `worker` without AI) |
| `db_owner_password`, `objectstore_*` | PostgreSQL owner, RustFS root and application user | No rotation procedure: `migrate` logs in with the owner password and fails with a replaced one; keep them stable |

## Backup and restore

```bash
cd /opt/docker/containers/nibomo
install -d -m 0700 /opt/docker/containers/nibomo-backups     # outside sourc/ and secrets/
bash sourc/infra/selfhost/backup.sh "$PWD" /opt/docker/containers/nibomo-backups
```

[backup.sh](../infra/selfhost/backup.sh) stops every running service except `postgres` and
`objectstore`, requires that no other PostgreSQL session remains and that row counts do not change
across the dump, archives the stopped RustFS volume with per-file SHA-256 sums, copies `.env` and
`secrets/`, and starts exactly the services it stopped again, also on failure; it exits non-zero
and names any service that is not running (healthy) again in time. It refuses while a job or
one-off container runs or another container mounts the data volumes. Expect a short outage. The
backup directory holds live credentials: keep it private and keep a copy offline.

[restore.sh](../infra/selfhost/restore.sh) restores only into a new instance directory and a project
that has no containers, volumes or networks; its header lists every check. It starts only
`postgres` until objects and rows are verified, and `--start` (which needs a `--gateway-port` other
than the source's and is refused with `--allow-source-project-name`) is the only way it starts
anything else:

```bash
cd /opt/docker/containers/nibomo
bash sourc/infra/selfhost/restore.sh /opt/docker/containers/nibomo-backups/nibomo-backup-nibomo-<time> \
  /opt/docker/containers/nibomo-restore nibomo-restore --gateway-port 18088
```

The restored instance keeps the same hosts, keys, SMTP and AI settings (with `--start` an `openai`
copy runs chat on the operator's key, and the AI-mode change rule above applies to its project), so
test it through its own gateway port with the original `Host` names, then sign in and check cards, review history, due dates, images and chat
history. A failed restore leaves its project and directory for inspection; removing them is a manual step.

## Explicit network subnets

When Docker's default address pools are exhausted, point `NIBOMO_COMPOSE_NETWORK_FILE` (in the shell,
for every `compose.sh`, `backup.sh` and `restore.sh` call of that project) at an overlay that only
assigns private IPv4 subnets; no host or daemon setting changes:

```yaml
networks:
  app:
    ipam:
      config:
        - subnet: 10.247.70.0/24
```

The file must be yours (or root's), not group/world-writable, in a directory that is not either, and
contain nothing but this shape for `internal`, `app`, `storage`, `edge`, `egress` or `ai` (the
project-internal network of the [AI proxy](#ai-through-an-openai-compatible-proxy); Compose ignores the
entry while no proxy is configured), so isolation and attachments stay exactly as in the Compose files. A subnet that overlaps an existing Docker network, or
differs from the project's existing network, is refused. A project created with the overlay must
always be addressed with it, and one created without it never with it.

The synthetic safety test of these scripts (no Docker daemon involved):
`bash infra/selfhost/tests/backup-restore-safety.sh <empty scratch dir>`. The `setup.sh --check` rules (CSRF key,
test mailbox isolation): `bash infra/selfhost/tests/setup-check.sh <empty scratch dir>`.

## AI through an OpenAI-compatible proxy

With `NIBOMO_AI_PROVIDER=openai`, chat can go to an operator-run OpenAI-compatible proxy (for example
CLIProxyAPI) instead of `api.openai.com`. The proxy must serve the Responses API with streaming and
function calls; dictation and card images use the same endpoint with their built-in models.

```bash
# .env (no secret here); secrets/openai_api_key holds the proxy's client key, never the URL
NIBOMO_AI_PROVIDER=openai
NIBOMO_AI_PERSONAL_KEYS=                       # must stay empty: personal keys would reach the proxy
NIBOMO_AI_PROXY_BASE_URL=http://cliproxyapi:8317/v1
NIBOMO_AI_PROXY_NETWORK=nibomo-ai-proxy        # existing Docker network the proxy container is on
NIBOMO_AI_MODEL=<model the proxy serves>       # optional; also valid without a proxy
```

The host must be the proxy container's name on that network (one DNS label; no dots, IP address or
Nibomo service name); the port defaults to 80/443. [compose.ai-proxy.yml](../infra/selfhost/compose.ai-proxy.yml)
then adds `ai-relay` and the project-internal network `ai`:

```
backend, worker --(ai, internal)--> ai-relay --(NIBOMO_AI_PROXY_NETWORK)--> cliproxyapi:8317
```

`backend` and `worker` lose `egress` and join only `ai`, where `ai-relay` answers under the proxy's
hostname and forwards raw TCP to that one host on the proxy network. URL, `Host` and, with `https`, the
certificate name stay the proxy's own, end to end. The relay is the only Nibomo container on the proxy
network: it has no secrets or database access, listens only on its `ai` address, and cannot be pointed
elsewhere, so the proxy and its neighbours cannot reach `backend` (around the gateway, with forged
forwarding headers), `worker`, Postgres or RustFS, and redirects or any other destination fail for
`backend`/`worker`. `compose.sh` derives the relay settings from the URL, only inspects the proxy
network, and refuses one that is missing, is one of the project's own, holds any other container of
the project, or has an outbound route. The backend validates the URL again at start (http/https, no
credentials, query or fragment) and passes it to every OpenAI client explicitly, so there is no
fallback to `api.openai.com`. Usage rows record the model actually sent (`NIBOMO_AI_MODEL` when set),
so built-in prices never apply to it.

Dedicated network (recommended; Nibomo never changes the proxy's own Compose project):

```bash
docker network create --internal nibomo-ai-proxy
docker ps --format '{{.Names}}'                     # find the proxy container's current name
# --alias gives the URL's host on this network whatever the container is called; or add the network to the
# proxy's own compose file
docker network connect --alias cliproxyapi nibomo-ai-proxy <proxy container name>
```

On a host whose Docker address pools are exhausted, `docker network create` also needs
`--subnet <free private /24>`, and the project's `ai` network an `ai:` entry in the
[network overlay](#explicit-network-subnets).

`--internal` keeps the network itself unrouted while the proxy keeps its own networks for upstream
traffic. A shared, routed network instead requires `NIBOMO_AI_PROXY_NETWORK_EGRESS=accepted`; it gives
`ai-relay` (not `backend`/`worker`) that route and those neighbours.

Turning the proxy on or off changes the overlay set, so it follows the AI-mode change rule above.
`down` is required there because `compose.sh` refuses to address containers created with another
overlay set; it removes the project's containers and networks (no `-v`: volumes stay; take a backup
first) and the instance is offline until `up` finishes. From the deployment root:

```bash
bash sourc/infra/selfhost/compose.sh "$PWD" down    # with the old .env still in place
"${EDITOR:-vi}" .env                                 # set or clear the NIBOMO_AI_PROXY_* lines
make selfhost-check
make selfhost-up
```

With the proxy already on, changing only the URL, model or proxy network keeps the overlay set: edit
`.env`, then `make selfhost-up`, which recreates the changed services; no `down`.
Synthetic test of the refusals and the rendered network model:
`bash infra/selfhost/tests/ai-proxy.sh <empty scratch dir>`; the streaming tool-call path against a
loopback proxy: `node --test --import tsx src/chat/openai/providerEndpoint.integration.test.ts` in
`apps/backend`. The boundary on a real Docker daemon (disposable project, synthetic proxy, two free
private /24s): `bash infra/selfhost/tests/ai-relay-docker.sh <empty scratch dir> <built backend image> <ai /24> <proxy /24>`.

## Testing a stack

Never test against the `nibomo` project. Use a separate instance directory and project name, the
captured mailbox overlay, and the public-contract smoke:

```bash
bash sourc/infra/selfhost/setup.sh /path/to/test-instance
# in the test .env: NIBOMO_COMPOSE_PROJECT=nibomo-selftest NIBOMO_SMTP_HOST=mailpit NIBOMO_SMTP_PORT=1025
#   NIBOMO_SMTP_TLS_MODE=none NIBOMO_DEV_MAILBOX=true NIBOMO_ALLOWED_EMAIL_DOMAINS=<test domain>
#   NIBOMO_GATEWAY_PORT=<free port> NIBOMO_GATEWAY_BIND=127.0.0.1
bash sourc/infra/selfhost/compose.sh /path/to/test-instance up -d --build
SMOKE_GATEWAY=http://127.0.0.1:<port> SMOKE_BASE_DOMAIN=<base> SMOKE_MAILBOX=http://127.0.0.1:18025 \
  SMOKE_EMAIL_DOMAIN=<test domain> node sourc/infra/selfhost/smoke.mjs
```

The smoke ([smoke.mjs](../infra/selfhost/smoke.mjs)) covers readiness, unknown-host refusal,
forged-credential refusal, browser and agent OTP sign-in, refresh, logout, card creation, an
idempotent review retry and cross-account workspace refusal. The test domain must not be an RFC 2606
reserved name (`*.test`, `*.example`, `*.invalid`, `*.localhost`, `example.com/net/org`): sign-in
refuses those addresses with `400`. The normal OTP throttles apply, so
repeated runs from one address within an hour are refused with `429`; use a fresh test project. [mcp-smoke.mjs](../infra/selfhost/mcp-smoke.mjs) takes
the same variables (plus optional `SMOKE_MCP_ALTERNATE_HOST` and `SMOKE_MCP_ALLOWED_ORIGIN`) and
covers MCP ingress refusals, OAuth discovery, DCR, PKCE authorize/consent/token, the id_token
signature, the shared study tools with an idempotent review retry, host binding, concurrency limits,
refresh rotation and cross-account isolation; it sends three sign-in codes per run. The PostgreSQL boundaries for the
identity adapter and the chat dispatch are `apps/backend/src/auth/standaloneLocalIdentity.postgres.integration.ts`
and `apps/backend/src/chat/runs/standaloneDispatch.postgres.integration.ts`.
