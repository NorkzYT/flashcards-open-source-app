# Private tailnet ingress on a host that already uses Funnel

How to reach a self-hosted Nibomo only from your tailnet, on a machine whose own Tailscale node
already serves something public with Funnel on `:443`, without touching that Funnel. It extends
[Hosts, DNS and TLS](self-hosting.md#hosts-dns-and-tls); everything there still applies. Nothing
here has been run against a real tailnet: the ingress template is tested locally (see
[What is verified](#what-is-verified)), the Tailscale steps come from Tailscale's documentation.

## Why not a ts.net name

Clients need five sibling hosts on the default HTTPS port (`app.`, `api.`, `auth.`, `mcp.` and the
media host, see [self-hosting.md](self-hosting.md#hosts-dns-and-tls)), and the `session` and
`refresh` cookies are published with `Domain=<NIBOMO_BASE_DOMAIN>` (`COOKIE_DOMAIN` in
[compose.yml](../infra/selfhost/compose.yml)), so every name under the base receives them.

- `ts.net` itself is on the [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat)
  (private section, Tailscale's entry, alongside `*.c.ts.net`). So `<tailnet>.ts.net` is one
  registrable domain: a base there would send the cookies to every device, Tailscale Service and
  Funnel name of the tailnet, including the existing public Funnel host.
- Names under `ts.net` are assigned by Tailscale, and `tailscale serve --https` presents Tailscale's
  certificate for the node's or Service's own MagicDNS name only, so it cannot present
  `app.`/`api.`/`auth.`/`mcp.`/media siblings of a base you choose.

`setup.sh --check` therefore refuses a base equal to or under `ts.net`.

## Shape

```text
tailnet client ──▶ <tailnet address>:443  (a Tailscale Service TailVIP, or a dedicated sidecar node)
                    │ raw TCP, PROXY protocol v2, TLS untouched
                    ▼
                  127.0.0.1:9443  ingress Caddy (private-ingress.Caddyfile): your DNS-01 certificate
                    │ Host, path and query unchanged; X-Forwarded-For = tailnet client address
                    ▼
                  127.0.0.1:8088  Nibomo gateway (unchanged)
```

The existing node's own `:443` and its Funnel are not used and not changed. Nothing listens on a
public or LAN address: the ingress binds `127.0.0.1`, the gateway keeps its loopback bind.

## 1. Base domain, DNS and certificate

1. Choose a base you control and dedicate it to this instance, e.g. `study.example.com`: every name
   under it receives the session cookies, so put nothing else there.
2. Point `app.`, `api.`, `auth.`, `mcp.` and the media name at the tailnet address chosen in step 2
   or 3 (the Service's TailVIP or the sidecar node's `100.x` address), either in a private resolver
   your tailnet uses through split DNS, or in public DNS (that publishes only an unroutable `100.x`
   address; the service stays unreachable off the tailnet).
3. Issue one certificate for the five names (or `*.study.example.com`) with a DNS-01 ACME challenge,
   using your DNS provider's API from wherever that API credential lives. Install the chain and key
   as `/etc/nibomo-ingress/certs/fullchain.pem` and `privkey.pem`, readable by the ingress user only,
   and restart the ingress after each renewal. The ingress itself has no ACME and no outbound need.
4. Configure the instance as usual with those names (`NIBOMO_BASE_DOMAIN=study.example.com`, ...),
   then run `bash sourc/infra/selfhost/setup.sh --check "$PWD"` from the deployment root (`sourc/` is
   the checkout, as in [self-hosting.md](self-hosting.md)).

## 2. Tailnet entry point: pick one

Both forward raw TCP `:443` with `tailscale serve --tcp` and `--proxy-protocol=2`, so the ingress
terminates TLS with your certificate and learns each client's tailnet address. Both flags are in
the [`tailscale serve` reference](https://tailscale.com/kb/1242/tailscale-serve) ("PROXY protocol
version (1 or 2) for TCP forwarding"); its only PROXY example uses `--tls-terminated-tcp`. The
`tailscale serve --help` of Tailscale 1.84.0 lists neither `--proxy-protocol` nor `--service`, so
upgrade first and check that your version accepts the combination below and that `tailscale serve status` reports the
PROXY protocol before trusting it. If it does not, stop there: the ingress refuses connections
without a PROXY header, and without one every client would share a single address (the OTP throttle
would see one client).

### A. Dedicated sidecar node (default: no change to the existing node)

A second `tailscaled` on the same machine, with its own state and therefore its own node identity,
tag and `100.x` address. In userspace networking mode it opens no host socket on `:443`, so it cannot
collide with the existing node or its Funnel.

`tailscaled` runs in the foreground until stopped, so run it as its own systemd unit (persistent,
restarted on failure and at boot), not inline before the `tailscale` commands. The unit is separate
from the packaged `tailscaled.service`, which keeps the existing node. Unlike that unit it has no
`ExecStopPost=tailscaled --cleanup`: without this instance's flags that cleanup targets the default
kernel-mode state (routes, firewall rules, DNS) the existing node relies on.

```bash
sudo tee /etc/systemd/system/tailscaled-nibomo.service > /dev/null <<'EOF'
[Unit]
Description=Tailscale sidecar node for the Nibomo private ingress (userspace, own state)
Wants=network-pre.target
After=network-pre.target NetworkManager.service systemd-resolved.service

[Service]
ExecStart=/usr/sbin/tailscaled --tun=userspace-networking --port=0 --state=/var/lib/tailscale-nibomo/tailscaled.state --socket=/run/tailscale-nibomo/tailscaled.sock
Type=notify
Restart=on-failure
RuntimeDirectory=tailscale-nibomo
RuntimeDirectoryMode=0700
StateDirectory=tailscale-nibomo
StateDirectoryMode=0700

[Install]
WantedBy=multi-user.target
EOF
sudo systemd-analyze verify /etc/systemd/system/tailscaled-nibomo.service
sudo systemctl daemon-reload
sudo systemctl enable --now tailscaled-nibomo.service
systemctl status tailscaled-nibomo.service --no-pager   # active (running); /usr/sbin is the Debian/Ubuntu package path
```

Then, in the same shell (the daemon now runs in the background):

```bash
TS="tailscale --socket=/run/tailscale-nibomo/tailscaled.sock"
sudo $TS up --hostname=nibomo --advertise-tags=tag:nibomo --accept-dns=false   # interactive login or an operator-issued auth key
sudo $TS serve --bg --proxy-protocol=2 --tcp=443 tcp://127.0.0.1:9443
sudo $TS serve status
```

For a one-off trial instead of the unit, start the same `tailscaled ...` command line under `sudo`
in a separate terminal and leave it open; it stops (and the node goes offline) when that terminal
closes. `serve --bg` keeps the serve configuration in this node's state, so it returns when the
daemon restarts.

`tag:nibomo` needs a `tagOwners` entry in the policy. Do not enable Funnel on this node. DNS
(step 1.2) points at `sudo $TS ip -4`. Removal: `sudo $TS serve reset`, `sudo $TS logout`,
`sudo systemctl disable --now tailscaled-nibomo.service`, then delete the unit file.

### B. Tailscale Service `svc:nibomo` on the existing node

A [Tailscale Service](https://tailscale.com/kb/1552/tailscale-services) has its own MagicDNS name
and TailVIP, separate from the node's address. Its documented prerequisites: the hosting device uses
a **tag-based identity**, Tailscale v1.86.0 or later, the Service defined in the admin console with
port `tcp:443`, and host approval in the console or through `autoApprovers.services`.

The tag requirement is the catch: if the existing Funnel node is user-owned, making it a Service host
means retagging it, which changes its identity, ownership and which policy rules (including the one
that allows its Funnel) apply. Do not retag it as a side effect of this setup; if you choose this
route, do it as its own reviewed change and confirm the Funnel afterwards. Then:

```bash
sudo tailscale serve --service=svc:nibomo --bg --proxy-protocol=2 --tcp=443 tcp://127.0.0.1:9443
sudo tailscale serve status --json        # the svc:nibomo endpoint, then approve it if not auto-approved
```

The flags are documented separately (`--service`, `--tcp`, `--proxy-protocol`); Tailscale shows no
verbatim example combining them, and its docs do not say how a Service on `:443` coexists with the
node's own Funnel on `:443` (they are different addresses). Verify both with the checks below.
Removal, in the documented order: `tailscale serve drain svc:nibomo`, wait for connections to close,
then `tailscale serve clear svc:nibomo`.

### Access policy

Tailscale access rules only ever allow: grants and legacy `acls` entries are additive, and a
connection is permitted if any one of them matches. The rule below therefore restricts nothing on
its own. Tailscale's default policy, and many existing ones, contain an allow-all rule
(`{"src": ["*"], "dst": ["*"], "ip": ["*"]}` as a grant, or `"dst": ["*:*"]` in `acls`) that already
admits every tailnet device to this node or Service on every port.

1. Audit every existing `grants` and `acls` entry whose destination can match the new endpoint:
   `*`, `*:*`, `tag:nibomo`, `autogroup:tagged` (option A), `svc:nibomo` (option B), its `100.x`
   address or a range containing it, or a host alias for it. Narrow those before relying on the rule
   below; for an allow-all rule that means replacing it with explicit rules for what the tailnet
   actually uses, a change that affects every device, so review it on its own.
2. Then allow only the people who use this instance, only to port 443, e.g. with option A:

```json
"tagOwners": { "tag:nibomo": ["autogroup:admin"] },
"grants": [
  { "src": ["group:nibomo-users"], "dst": ["tag:nibomo"], "ip": ["443"] }
]
```

With option B the destination is `"svc:nibomo"`. Add no rule from `tag:nibomo` to anything: the
ingress needs no outbound tailnet access.

3. Add policy `tests` that name a member and a non-member (Tailscale evaluates them when the policy
   is saved and rejects a policy that fails), e.g. `{"src": "member@example.com", "accept":
   ["tag:nibomo:443"]}` and `{"src": "other@example.com", "deny": ["tag:nibomo:443", "tag:nibomo:22"]}`.
   A policy test checks the policy text only; checks 2 and 3 below from real devices are what show
   the restriction holds. Until they pass, treat the instance as reachable by the whole tailnet.

### Trust boundary on the host

The ingress takes the client address from the PROXY header of whichever local process connects to
`127.0.0.1:9443`; it cannot tell the forwarder from anything else on the host (the userspace
forwarder also connects from `127.0.0.1`). So:

- Every local user, process and container with host networking is trusted: any of them can connect
  with a forged PROXY header and appear as any `100.x` address (for example to sidestep the OTP
  throttle or put another address in the logs). The same processes can also reach the gateway on
  `127.0.0.1:8088` directly. Run this only on a host whose local users you trust to that degree.
- Root on the host is not isolated from any of it: it can read the certificate key, the sidecar
  node's state (and so act as `tag:nibomo`), and the instance secrets.
- The PROXY-derived address is not authentication. It is a client label for logs and throttling;
  sign-in (email OTP) remains the only user authentication, and tailnet membership plus the policy
  above only decides who can open a connection.

## 3. Ingress proxy

[private-ingress.Caddyfile](../infra/selfhost/private-ingress.Caddyfile) serves the five names on
`127.0.0.1:9443` with your certificate, requires a PROXY header, refuses a Host that differs from the
TLS server name (421), and forwards to the gateway with the original Host, path and query (media URLs
are signed for both). If `NIBOMO_MCP_ALTERNATE_HOST` is set, add a sixth site block for it and put it
on the certificate.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin nibomo-ingress   # once; owns the cert files
# Pass only the host names and gateway port from .env, as literal values (the file is never sourced).
docker run --env-file <(grep -E '^NIBOMO_((APP|API|AUTH|MCP|MEDIA)_HOST|GATEWAY_PORT)=' .env) \
  -d --name nibomo-ingress --restart unless-stopped --network host --read-only \
  --user "$(id -u nibomo-ingress):$(id -g nibomo-ingress)" --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges --tmpfs /config:uid="$(id -u nibomo-ingress)",mode=0700 \
  --tmpfs /data:uid="$(id -u nibomo-ingress)",mode=0700 \
  -v "$PWD/source/infra/selfhost/private-ingress.Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v /etc/nibomo-ingress/certs:/certs:ro caddy:2.10.2-alpine caddy run --config /etc/caddy/Caddyfile
```

(`NET_BIND_SERVICE` is only there because the image's `caddy` binary carries that file capability;
the ingress binds no privileged port.) It reaches the gateway's published loopback port, so set
`NIBOMO_GATEWAY_TRUSTED_PROXIES` to the `<project>_edge` bridge gateway `/32` exactly as in
[Hosts, DNS and TLS](self-hosting.md#hosts-dns-and-tls).

## 4. Checks before use

Record `tailscale funnel status` and `tailscale serve status --json` of the existing node before you
start, and compare after each step: they must be unchanged.

1. From a device in `group:nibomo-users`: `curl -sS https://api.<base>/v1/health` succeeds with no
   `-k`, and the web app signs in at `https://app.<base>`.
2. From a tailnet device outside the grant (after the audit above): the same request times out
   (denied by policy). If it connects, an existing rule still admits it; the instance is not
   restricted.
3. From off the tailnet (e.g. a phone on mobile data with Tailscale off): no connection.
4. The existing Funnel URL still answers from the internet as before.
5. On the host, `sudo ss -ltnp` shows no new listener outside `127.0.0.1` (the ingress on
   `127.0.0.1:9443`; option A adds no host listener for `:443`).
6. After two different devices request an OTP, the gateway log shows two different `100.x` client
   addresses, not one shared address.

## What is verified

`bash infra/selfhost/tests/private-ingress.sh <empty scratch dir>` runs the template in the pinned
Caddy with a throwaway lab CA on loopback (needs Docker, openssl, curl, python3; the leaf certificate
lives one day): all five names reach an echo upstream with Host, path and query unchanged, the client
address comes from the PROXY header while client `X-Forwarded-For`/`Cf-Connecting-Ip` are dropped, a
connection without a PROXY header, an unknown server name and a Host/SNI mismatch are refused, the
certificate fails without the lab CA, and the only socket is `127.0.0.1`. It proves nothing about a
tailnet, the Tailscale commands or the systemd unit above, the access policy, a Service's
coexistence with Funnel, or a public certificate. Its forged-`X-Forwarded-For` check covers headers
from the remote client only; a local process sending its own PROXY header is trusted by design (see
[Trust boundary on the host](#trust-boundary-on-the-host)).
