// TEST ONLY (tests/ai-relay-docker.sh). Runs in the backend image with one of two roles:
//   inside    on the project's `ai` network, where backend and worker live: the real OpenAI SDK streams a
//             Responses tool-call turn through ai-relay; TLS validates the proxy's own name end to end;
//             redirects and any other destination fail.
//   neighbour on the operator's proxy network: nothing of the Nibomo stack except the relay's (closed)
//             proxy-side address is reachable.
// Prints one PASS/FAIL line per check; exit 1 on any failure. Synthetic key and data only.
import { createRequire } from "node:module";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";

const require = createRequire("/app/package.json");
const role = process.argv[2];
const env = (name) => process.env[name] ?? "";
let failures = 0;
const report = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${role}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
};
const tcp = (host, port) => new Promise((resolve) => {
  const s = connect({ host, port, timeout: 3000 });
  s.once("connect", () => { s.destroy(); resolve("open"); });
  s.once("timeout", () => { s.destroy(); resolve("timeout"); });
  s.once("error", (e) => resolve(e.code ?? "error"));
});
const resolves = (name) => lookup(name).then((r) => r.address, () => null);

if (role === "inside") {
  const host = env("PROXY_HOST");
  const port = env("PROXY_PORT");
  const OpenAI = require("openai").default ?? require("openai");
  const client = new OpenAI({ apiKey: env("SYNTHETIC_KEY"), baseURL: `http://${host}:${port}/v1`, maxRetries: 0, timeout: 15_000 });
  try {
    const kinds = [];
    let call = null;
    for await (const event of await client.responses.create({ model: "synthetic-proxy-model", input: "hi", stream: true,
      tools: [{ type: "function", name: "list_workspaces", parameters: { type: "object", properties: {} }, strict: false }] })) {
      kinds.push(event.type);
      if (event.type === "response.output_item.done" && event.item.type === "function_call") call = event.item;
    }
    report(call?.name === "list_workspaces" && kinds.at(-1) === "response.completed", "SDK streams a Responses tool call through ai-relay");
    let text = "";
    for await (const event of await client.responses.create({ model: "synthetic-proxy-model", stream: true,
      input: [call, { type: "function_call_output", call_id: call.call_id, output: "{\"workspaces\":[]}" }] })) {
      if (event.type === "response.output_text.delta") text += event.delta;
    }
    report(text === "Relay answer.", "SDK streams the follow-up text turn with the tool output", JSON.stringify(text));
  } catch (error) {
    report(false, "SDK stream through ai-relay", error?.constructor?.name);
  }
  const echo = await fetch(`http://${host}:${port}/echo`).then((r) => r.json(), () => null);
  report(echo?.host === `${host}:${port}` && echo.tls === false, "proxy sees its own Host name, unchanged", JSON.stringify(echo));
  const tls = await fetch(`https://${host}:${port}/echo`).then((r) => r.json(), (e) => ({ error: e.cause?.code ?? String(e) }));
  report(tls?.tls === true, "TLS through the relay validates the proxy's own name end to end", JSON.stringify(tls));
  const wrongName = await fetch(`https://ai-relay:${port}/echo`).then(() => "accepted", (e) => e.cause?.code ?? "refused");
  report(wrongName !== "accepted", "a certificate for another name is still rejected", wrongName);
  const redirect = await fetch(`http://${host}:${port}/redirect`).then((r) => `followed ${r.status}`, (e) => e.cause?.code ?? "failed");
  report(!redirect.startsWith("followed"), "a redirect off the proxy cannot be followed", redirect);
  for (const [h, p] of [["192.0.2.10", 80], ["1.1.1.1", 443]]) {
    const r = await tcp(h, p);
    report(r !== "open", `no route to ${h}:${p}`, r);
  }
  report((await resolves("example.com")) === null, "no outside DNS");
  report((await tcp(`${host}.${env("PROXY_NETWORK")}`, port)) !== "open", "the proxy network itself is not reachable");
} else if (role === "neighbour") {
  const port = Number(env("PROXY_PORT"));
  for (const name of ["backend", "worker", "backend-stub"]) {
    report((await resolves(name)) === null, `${name} does not resolve from the proxy network`);
  }
  for (const address of env("STACK_ADDRESSES").split(",").filter(Boolean)) {
    const [h, p] = address.split(":");
    const r = await tcp(h, Number(p));
    report(r !== "open", `no route to stack address ${address}`, r);
  }
  const relay = env("RELAY_PROXY_ADDRESS");
  const r = await tcp(relay, port);
  report(r !== "open", "the relay does not listen on its proxy-side address", r);
} else {
  console.error("usage: probe.mjs inside|neighbour");
  process.exit(2);
}
process.exit(failures === 0 ? 0 : 1);
