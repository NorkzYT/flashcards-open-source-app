// Real TLS on loopback for the smoke transport: a throwaway test CA signs a leaf for the logical
// names, and the transport must verify it by SNI, refuse a wrong CA, the system store and a name the
// certificate does not cover, keep plain-http loopback working, and keep credentials out of output.
// Needs openssl; no Docker, no network beyond 127.0.0.1.
//   node --test infra/selfhost/smoke-transport.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createTransport, readCa, redact, refuseInsecureTls } from "./smoke-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "smoke-transport-"));
const file = (name) => join(dir, name);
const openssl = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
const servers = {};
const seen = [];

function makeCa(name) {
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${name}`,
    "-keyout", file(`${name}.key`), "-out", file(`${name}.pem`));
}

before(async () => {
  makeCa("ca");
  makeCa("wrong-ca");
  writeFileSync(file("ext.cnf"), "subjectAltName=DNS:auth.tls.test,DNS:mcp.tls.test\n");
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=mcp.tls.test", "-keyout", file("leaf.key"), "-out", file("leaf.csr"));
  openssl("x509", "-req", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial",
    "-days", "1", "-extfile", file("ext.cnf"), "-out", file("leaf.pem"));
  const handler = (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ host: req.headers.host, sni: req.socket.servername ?? null, path: req.url, body, type: req.headers["content-type"] });
      res.writeHead(req.url.startsWith("/leak") ? 400 : 200, { "content-type": "application/json" });
      res.end(req.url.startsWith("/leak")
        ? JSON.stringify({ error: "x", access_token: "fco_SECRETACCESS", refresh_token: "fcr_SECRETREFRESH",
          redirect_to: "https://client.example.org/cb?code=SECRETCODE&state=st-1", note: "Bearer fca_SECRETKEY" })
        : JSON.stringify({ ok: true }));
    });
  };
  servers.tls = https.createServer({ key: readFileSync(file("leaf.key")), cert: readFileSync(file("leaf.pem")) }, handler);
  servers.plain = http.createServer(handler);
  for (const server of Object.values(servers)) await new Promise((done) => server.listen(0, "127.0.0.1", done));
});
after(() => {
  for (const server of Object.values(servers)) server.close();
  rmSync(dir, { recursive: true, force: true });
});
const gateway = (name) => `${name === "tls" ? "https" : "http"}://127.0.0.1:${servers[name].address().port}`;

test("https: verified against the test CA, SNI and Host are the logical name, path and query kept", async () => {
  const { request, secure } = createTransport({ gateway: gateway("tls"), ca: readCa(file("ca.pem")) });
  assert.equal(secure, true);
  const response = await request("http://mcp.tls.test/mcp?x=1", { method: "POST", host: "mcp.tls.test", body: { a: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.at(-1), { host: "mcp.tls.test", sni: "mcp.tls.test", path: "/mcp?x=1", body: "{\"a\":1}", type: "application/json" });
  const form = await request("http://auth.tls.test/token", { method: "POST", form: { grant_type: "x" } });
  assert.equal(form.status, 200);
  assert.deepEqual(seen.at(-1), { host: "auth.tls.test", sni: "auth.tls.test", path: "/token", body: "grant_type=x",
    type: "application/x-www-form-urlencoded" });
});

test("https: a verified connection can carry another Host only when SNI is named explicitly", async () => {
  const { request } = createTransport({ gateway: gateway("tls"), ca: readCa(file("ca.pem")) });
  await request("http://other.invalid/mcp", { host: "other.invalid", servername: "mcp.tls.test" });
  assert.deepEqual([seen.at(-1).host, seen.at(-1).sni], ["other.invalid", "mcp.tls.test"]);
  await assert.rejects(request("http://other.invalid/mcp"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
});

test("https: wrong CA and the system store are refused before any request is sent", async () => {
  const count = seen.length;
  const wrong = createTransport({ gateway: gateway("tls"), ca: readCa(file("wrong-ca.pem")) });
  await assert.rejects(wrong.request("http://mcp.tls.test/mcp"), (error) => /UNABLE_TO_VERIFY|SELF_SIGNED|CERT/.test(error.code));
  const system = createTransport({ gateway: gateway("tls") });
  await assert.rejects(system.request("http://mcp.tls.test/mcp"), (error) => /UNABLE_TO_VERIFY|SELF_SIGNED|CERT/.test(error.code));
  assert.equal(seen.length, count, "no request reached the server");
});

test("http loopback gateway: Host is the logical name, no TLS", async () => {
  const { request, secure } = createTransport({ gateway: gateway("plain"), ca: readCa(file("ca.pem")) });
  assert.equal(secure, false);
  assert.equal((await request("http://mcp.tls.test/mcp", { host: "mcp.tls.test" })).status, 200);
  assert.deepEqual([seen.at(-1).host, seen.at(-1).sni], ["mcp.tls.test", null]);
  assert.throws(() => createTransport({ gateway: "ftp://127.0.0.1:1" }), /must be http/);
});

test("response text and errors mask credentials", async () => {
  const { request } = createTransport({ gateway: gateway("plain") });
  const response = await request("http://auth.tls.test/leak");
  assert.equal(response.json.access_token, "fco_SECRETACCESS", "callers still get the parsed value");
  assert.doesNotMatch(response.text, /SECRET/);
  assert.match(response.text, /"access_token":"<redacted>".*"note":"Bearer <redacted>"/);
  assert.match(redact("GET /authorize?client_id=c&code_verifier=v1&code=SECRET session=abc; Path=/"),
    /client_id=c&code_verifier=<redacted>&code=<redacted> session=<redacted>;/);
  const slow = http.createServer(() => {});
  await new Promise((done) => slow.listen(0, "127.0.0.1", done));
  const timed = createTransport({ gateway: `http://127.0.0.1:${slow.address().port}` });
  await assert.rejects(timed.request("http://auth.tls.test/authorize?code_challenge=CH&code=SECRET", { timeoutMs: 200 }),
    (error) => error.message === "timeout GET auth.tls.test/authorize");
  slow.closeAllConnections();
  slow.close();
});

test("NODE_TLS_REJECT_UNAUTHORIZED=0 is refused, in the helper and by mcp-smoke before any network", () => {
  assert.throws(() => refuseInsecureTls({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /refused/);
  const run = spawnSync(process.execPath, [join(here, "mcp-smoke.mjs")], { encoding: "utf8", env: {
    PATH: process.env.PATH, NODE_TLS_REJECT_UNAUTHORIZED: "0", SMOKE_GATEWAY: "https://127.0.0.1:1",
    SMOKE_MAILBOX: "http://127.0.0.1:1", SMOKE_BASE_DOMAIN: "tls.test", SMOKE_EMAIL_DOMAIN: "tls.test" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /NODE_TLS_REJECT_UNAUTHORIZED=0 is refused/);
  assert.doesNotMatch(run.stdout, /^- /m, "no step ran");
});

// Async: the fixture servers live in this process, so a blocking spawn would starve them.
const runAsync = (args, options) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("mcp-smoke against a TLS front with the wrong CA fails at the first request", async () => {
  const count = seen.length;
  const run = await runAsync([join(here, "mcp-smoke.mjs")], { timeout: 30_000, env: {
    PATH: process.env.PATH, SMOKE_GATEWAY: gateway("tls"), SMOKE_CA_FILE: file("wrong-ca.pem"),
    SMOKE_MAILBOX: gateway("plain"), SMOKE_BASE_DOMAIN: "tls.test", SMOKE_EMAIL_DOMAIN: "tls.test" } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /MCP SMOKE FAIL: .*(UNABLE_TO_VERIFY|self-signed|unable to verify|certificate)/i);
  assert.equal(seen.length, count, "no request reached the front");
});

test("mcp-smoke against a TLS front with the right CA dials it by SNI and Host", async () => {
  const count = seen.length;
  const run = await runAsync([join(here, "mcp-smoke.mjs")], { timeout: 30_000, env: {
    PATH: process.env.PATH, SMOKE_GATEWAY: gateway("tls"), SMOKE_CA_FILE: file("ca.pem"),
    SMOKE_MAILBOX: gateway("plain"), SMOKE_BASE_DOMAIN: "tls.test", SMOKE_EMAIL_DOMAIN: "tls.test" } });
  // The fixture is not a gateway (it answers 200), so the smoke fails its first assertion, after
  // the unknown-SNI probe was refused by verification and the 421 probe went over verified TLS.
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /MCP SMOKE FAIL: AssertionError/);
  assert.deepEqual(seen.slice(count).map((entry) => [entry.host, entry.sni, entry.path]),
    [["mcp.unknown.invalid", "mcp.tls.test", "/mcp"]]);
});
