/**
 * Standalone (self-hosted) live stream: the signing secret comes from one mounted file and never
 * from AWS, and the backend's own /chat/live route speaks the same SSE contract as the AWS
 * chat-live function. Synthetic secrets and ids only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { HttpError } from "../../../shared/errors";
import { getChatLiveAuthSecret } from "../../live/auth";
import type { LiveStreamParams } from "../../live/request";
import {
  closeStandaloneChatLiveStreams,
  createStandaloneChatLiveRoutes,
  loadStandaloneChatLiveConfig,
  resetStandaloneChatLiveSecretCacheForTests,
} from "../../live/standalone";

const SECRET = "a".repeat(64);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function writeSecretFile(content: string): string {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "nibomo-live-secret-"));
  const path = join(directory, "chat_live_auth_secret");
  writeFileSync(path, content, { mode: 0o400 });
  return path;
}

function standaloneEnv(secretFile: string): NodeJS.ProcessEnv {
  return {
    AUTH_MODE: "local",
    PUBLIC_API_BASE_URL: "https://api.selfhost.test/v1",
    CHAT_LIVE_URL: "https://api.selfhost.test/v1/chat/live",
    CHAT_LIVE_AUTH_SECRET_FILE: secretFile,
  };
}

test("hosted configuration (no secret file) leaves the standalone live route off", () => {
  assert.equal(loadStandaloneChatLiveConfig({ AUTH_MODE: "cognito", BACKEND_CHAT_LIVE_AUTH_SECRET_ARN: "arn:x" }), null);
});

test("standalone live config accepts one mounted secret and the API host live URL", () => {
  const config = loadStandaloneChatLiveConfig(standaloneEnv(writeSecretFile(`${SECRET}\n`)));
  assert.deepEqual(config, { liveUrl: "https://api.selfhost.test/v1/chat/live" });
});

test("standalone live config fails closed on every ambiguous or weak setting", () => {
  const file = writeSecretFile(SECRET);
  const cases: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
    ["AWS ARN beside the file", { ...standaloneEnv(file), BACKEND_CHAT_LIVE_AUTH_SECRET_ARN: "arn:x" }],
    ["non-local auth", { ...standaloneEnv(file), AUTH_MODE: "cognito" }],
    ["live URL on another host", { ...standaloneEnv(file), CHAT_LIVE_URL: "https://evil.test/v1/chat/live" }],
    ["live URL over http", { ...standaloneEnv(file), CHAT_LIVE_URL: "http://api.selfhost.test/v1/chat/live" }],
    ["missing live URL", { ...standaloneEnv(file), CHAT_LIVE_URL: "" }],
    ["short secret", standaloneEnv(writeSecretFile("short-secret"))],
    ["empty secret", standaloneEnv(writeSecretFile("\n"))],
    ["missing file", standaloneEnv("/nonexistent/chat_live_auth_secret")],
  ];
  for (const [label, env] of cases) {
    assert.throws(() => loadStandaloneChatLiveConfig(env), Error, label);
  }
});

test("the live signing secret is read from the mounted file and never from AWS", async (t) => {
  const file = writeSecretFile(`${SECRET}\n`);
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    resetStandaloneChatLiveSecretCacheForTests();
  });
  resetStandaloneChatLiveSecretCacheForTests();
  delete process.env.BACKEND_CHAT_LIVE_AUTH_SECRET_ARN;
  process.env.CHAT_LIVE_AUTH_SECRET_FILE = file;
  assert.equal(await getChatLiveAuthSecret(), SECRET);

  process.env.BACKEND_CHAT_LIVE_AUTH_SECRET_ARN = "arn:aws:secretsmanager:synthetic";
  await assert.rejects(getChatLiveAuthSecret(), /both/);
});

type FakeLive = Readonly<{
  app: Hono;
  closed: Promise<string>;
  seen: Array<LiveStreamParams>;
}>;

function createFakeLiveApp(failWith: Error | null): FakeLive {
  const seen: Array<LiveStreamParams> = [];
  let resolveClosed: (reason: string) => void = () => {};
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });
  const app = new Hono().basePath("/v1");
  app.route("/", createStandaloneChatLiveRoutes({
    handleLiveRequestFn: async (url, authorization) => {
      if (failWith !== null) throw failWith;
      assert.equal(authorization, "Live synthetic.token");
      return {
        sessionId: url.searchParams.get("sessionId") ?? "",
        runId: url.searchParams.get("runId") ?? "",
        afterCursor: undefined,
        userId: "user-1",
        workspaceId: "workspace-1",
      };
    },
    runLiveStreamFn: async (stream: Writable, params: LiveStreamParams) => {
      seen.push(params);
      stream.write("event: run_state\ndata: {\"type\":\"run_state\"}\n\n");
      await new Promise<void>((resolve) => stream.once("close", () => resolve()));
      resolveClosed("close");
      return { capturedSentryEvent: false };
    },
  }));
  return { app, closed, seen };
}

async function listen(app: Hono): Promise<Readonly<{ url: string; close: () => void }>> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() });
    });
  });
}

test("the standalone live route streams SSE and ends the run loop when the client disconnects", async () => {
  const fake = createFakeLiveApp(null);
  const server = await listen(fake.app);
  try {
    const abort = new AbortController();
    const response = await fetch(`${server.url}/v1/chat/live?sessionId=${SESSION_ID}&runId=${RUN_ID}`, {
      headers: { Authorization: "Live synthetic.token" },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(response.headers.get("x-request-id"));
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /^event: run_state\n/);
    assert.equal(fake.seen[0]?.runId, RUN_ID);
    assert.equal(fake.seen[0]?.requestId, response.headers.get("x-request-id"));
    abort.abort();
    assert.equal(await fake.closed, "close");
  } finally {
    server.close();
  }
});

test("shutdown closes attached live streams so the process can stop", async () => {
  const fake = createFakeLiveApp(null);
  const server = await listen(fake.app);
  try {
    const response = await fetch(`${server.url}/v1/chat/live?sessionId=${SESSION_ID}&runId=${RUN_ID}`, {
      headers: { Authorization: "Live synthetic.token" },
    });
    const reader = response.body!.getReader();
    await reader.read();
    closeStandaloneChatLiveStreams();
    assert.equal(await fake.closed, "close");
    let done = false;
    while (!done) done = (await reader.read()).done;
  } finally {
    server.close();
  }
});

test("the standalone live route answers attach failures with the live JSON error envelope", async () => {
  const fake = createFakeLiveApp(new HttpError(401, "Chat live auth token expired", "CHAT_LIVE_AUTH_EXPIRED"));
  const response = await fake.app.request(`/v1/chat/live?sessionId=${SESSION_ID}&runId=${RUN_ID}`, {
    headers: { Authorization: "Live synthetic.token" },
  });
  assert.equal(response.status, 401);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, "CHAT_LIVE_AUTH_EXPIRED");
  assert.equal(body.requestId, response.headers.get("x-request-id"));
});
