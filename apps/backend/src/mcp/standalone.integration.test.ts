import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMcpHttpApp } from "./httpApp";
import {
  createStandaloneMcpGuard,
  loadStandaloneMcpConfig,
  STANDALONE_TOKEN_SLOT_COUNT,
} from "./standalone";

// The standalone ingress in front of the shared MCP app, exercised through the app's fetch handler.
// Every case here is answered before any database access.
const standaloneEnv: NodeJS.ProcessEnv = {
  AUTH_MODE: "local",
  MCP_BASE_DOMAIN: "study.example.com",
  MCP_ALTERNATE_HOST: "mcp.alt.example.net",
  MCP_ALLOWED_ORIGINS: "https://client.example.org",
  PUBLIC_APP_BASE_URL: "https://app.study.example.com",
  PUBLIC_API_BASE_URL: "https://api.study.example.com/v1",
  PUBLIC_AUTH_BASE_URL: "https://auth.study.example.com",
  PUBLIC_MCP_BASE_URL: "https://mcp.study.example.com",
  PUBLIC_SITE_BASE_URL: "https://study.example.com",
};

function withEnv<T>(env: NodeJS.ProcessEnv, body: () => T): T {
  const saved = { ...process.env };
  for (const name of Object.keys(env)) process.env[name] = env[name];
  try {
    return body();
  } finally {
    for (const name of Object.keys(env)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function setup() {
  return withEnv(standaloneEnv, () => {
    const guard = createStandaloneMcpGuard(loadStandaloneMcpConfig(process.env));
    return { guard, app: createMcpHttpApp(guard) };
  });
}

function call(
  app: ReturnType<typeof setup>["app"],
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<Response> {
  return withEnv(standaloneEnv, () => Promise.resolve(app.fetch(new Request(`http://127.0.0.1:8082${path}`, {
    method,
    headers,
    body: method === "POST" ? "{}" : undefined,
  }))));
}

test("an unknown or missing Host is refused before metadata and transport", async () => {
  const { app } = setup();
  for (const host of ["evil.example.com", "auth.study.example.com", "127.0.0.1:8082"]) {
    assert.equal((await call(app, "/.well-known/oauth-protected-resource/mcp", { host })).status, 421, host);
    assert.equal((await call(app, "/mcp", { host }, "POST")).status, 421, host);
  }
  // X-Forwarded-Host never substitutes for Host.
  const forwarded = await call(app, "/mcp", { host: "evil.example.com", "x-forwarded-host": "mcp.study.example.com" }, "POST");
  assert.equal(forwarded.status, 421);
});

test("a present Origin must be listed exactly; an absent Origin is a non-browser client", async () => {
  const { app } = setup();
  const host = "mcp.study.example.com";
  for (const origin of ["https://evil.example.org", "null", "https://client.example.org:8443", "http://client.example.org"]) {
    assert.equal((await call(app, "/mcp", { host, origin }, "POST")).status, 403, origin);
    assert.equal((await call(app, "/.well-known/oauth-protected-resource", { host, origin })).status, 403, origin);
  }
  const listed = await call(app, "/mcp", { host, origin: "https://client.example.org" }, "POST");
  assert.equal(listed.status, 401);
  assert.equal(listed.headers.get("access-control-allow-origin"), "https://client.example.org");
  assert.equal((await call(app, "/mcp", { host }, "POST")).status, 401);
});

test("metadata and the Bearer challenge name the exact resource of the host used", async () => {
  const { app } = setup();
  for (const host of ["mcp.study.example.com", "MCP.Study.Example.com.", "mcp.alt.example.net"]) {
    const canonical = host.toLowerCase().replace(/\.$/, "");
    const metadata = await call(app, "/.well-known/oauth-protected-resource/mcp", { host });
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), {
      resource: `https://${canonical}/mcp`,
      authorization_servers: ["https://auth.study.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["flashcards"],
    });
    const challenge = await call(app, "/mcp", { host }, "POST");
    assert.equal(challenge.status, 401);
    assert.equal(
      challenge.headers.get("www-authenticate"),
      `Bearer resource_metadata="https://${canonical}/.well-known/oauth-protected-resource/mcp"`,
    );
  }
});

test("a token holding all of its slots is refused with Retry-After and its slots are not leaked", async () => {
  const { app, guard } = setup();
  const token = "fco_standalone_slot_probe";
  const key = createHash("sha256").update(token).digest("hex");
  for (let slot = 0; slot < STANDALONE_TOKEN_SLOT_COUNT; slot += 1) assert.equal(guard.tokenSlots.tryAcquire(key), true);
  const refused = await call(app, "/mcp", { host: "mcp.study.example.com", authorization: `Bearer ${token}` }, "POST");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "1");
  assert.equal(((await refused.json()) as { code: string }).code, "MCP_CLIENT_CONCURRENCY_LIMIT_REACHED");
  assert.equal(guard.tokenSlots.inUse(key), STANDALONE_TOKEN_SLOT_COUNT);
  assert.equal(guard.processSlots.inUse("process"), 0);
});

test("standalone settings fail closed", () => {
  const cases: ReadonlyArray<NodeJS.ProcessEnv> = [
    { AUTH_MODE: "cognito" },
    { MCP_BASE_DOMAIN: "" },
    { MCP_BASE_DOMAIN: "https://study.example.com" },
    { PUBLIC_MCP_BASE_URL: "" },
    { PUBLIC_MCP_BASE_URL: "https://mcp.other.example.com" },
    { PUBLIC_AUTH_BASE_URL: "https://login.study.example.com" },
    { PUBLIC_API_BASE_URL: "http://api.study.example.com/v1" },
    { PUBLIC_SITE_BASE_URL: "" },
    { MCP_ALLOWED_ORIGINS: "*" },
    { MCP_ALLOWED_ORIGINS: "http://client.example.org" },
  ];
  for (const override of cases) {
    assert.throws(() => loadStandaloneMcpConfig({ ...standaloneEnv, ...override }), JSON.stringify(override));
  }
});
