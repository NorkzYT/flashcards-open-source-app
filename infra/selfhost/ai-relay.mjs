// Fixed-upstream TCP relay between backend/worker and the operator's OpenAI-compatible proxy
// (compose.ai-proxy.yml). It is the only Nibomo container on the proxy's network, so nothing there can
// reach backend or worker (no gateway bypass, no forged forwarding headers), and backend/worker have
// no route anywhere except this relay.
//
// Bytes are passed through unchanged (TLS, when used, stays end to end with the proxy's own hostname),
// never parsed or logged. The upstream is fixed at start; no client can choose another destination.
//   AI_RELAY_LISTEN_HOST   the proxy hostname, which this container answers to on the project's `ai`
//                          network (a Compose alias); backend and worker see no other host by that name.
//   AI_RELAY_LISTEN_NAME   <hostname>.<project>_ai, the relay's own address there: the only listener.
//   AI_RELAY_UPSTREAM_HOST <hostname>.<proxy network>, the proxy itself.
//   AI_RELAY_PORT          TCP port, the same on both sides.
// Docker DNS answers <name>.<network> only from that network; the bare name is ambiguous here.
import { lookup } from "node:dns/promises";
import { createServer, connect } from "node:net";
import { networkInterfaces } from "node:os";

const MAX_CONNECTIONS = 64;
const CONNECT_TIMEOUT_MS = 10_000;
// Long enough for a quiet reasoning stream, short enough to shed abandoned sockets.
const IDLE_TIMEOUT_MS = 15 * 60_000;

function setting(name, pattern) {
  const value = process.env[name] ?? "";
  if (!pattern.test(value)) {
    console.error(`ai-relay: ${name} is missing or malformed`);
    process.exit(2);
  }
  return value;
}

const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const listenHost = setting("AI_RELAY_LISTEN_HOST", LABEL);
const scoped = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,253}$/u;
const listenName = setting("AI_RELAY_LISTEN_NAME", scoped);
const upstreamHost = setting("AI_RELAY_UPSTREAM_HOST", scoped);
const port = Number(setting("AI_RELAY_PORT", /^[1-9][0-9]{0,4}$/u));
if (port > 65535 || !upstreamHost.startsWith(`${listenHost}.`) || !listenName.startsWith(`${listenHost}.`)
    || listenName === upstreamHost) {
  console.error("ai-relay: AI_RELAY_PORT, AI_RELAY_LISTEN_NAME or AI_RELAY_UPSTREAM_HOST is malformed");
  process.exit(2);
}

const localAddresses = new Set(
  Object.values(networkInterfaces()).flat().filter((i) => i !== undefined).map((i) => i.address),
);

// Listen only on this container's own `ai` address, never on the proxy network.
const listenAddresses = (await lookup(listenName, { all: true, family: 4 }).catch(() => []))
  .map((entry) => entry.address)
  .filter((address) => localAddresses.has(address));
if (listenAddresses.length !== 1) {
  console.error(`ai-relay: ${listenName} must resolve to exactly one address of this container (got ${listenAddresses.length})`);
  process.exit(1);
}

let open = 0;
const server = createServer({ pauseOnConnect: true }, (client) => {
  if (open >= MAX_CONNECTIONS) {
    client.destroy();
    return;
  }
  open += 1;
  client.once("close", () => { open -= 1; });
  client.on("error", () => {});
  client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
  lookup(upstreamHost, { family: 4 }).then(({ address }) => {
    // Never loop back into this relay.
    if (localAddresses.has(address)) throw Object.assign(new Error("loop"), { code: "ELOOP" });
    const upstream = connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
    upstream.once("connect", () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", (error) => { console.error(`ai-relay: upstream ${error.code ?? "error"}`); });
    upstream.once("close", () => client.destroy());
    client.once("close", () => upstream.destroy());
  }).catch((error) => {
    console.error(`ai-relay: upstream ${error.code ?? "lookup failed"}`);
    client.destroy();
  });
});
server.listen({ host: listenAddresses[0], port }, () => {
  console.log(`ai-relay: listening on ${listenAddresses[0]}:${port}, upstream ${upstreamHost}:${port}`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
