#!/usr/bin/env node
// AI chat acceptance against a disposable Compose project with the SYNTHETIC test provider
// (compose.ai-test.yml, ai-test-provider.mjs). Start it only through ai-acceptance.sh, which checks the
// instance is a test project and exports AI_TEST_*. The provider's errors and stalls are synthetic, and
// its only successful answers are labeled SIMULATIONS (a scripted sql_execute card insert, then a
// labeled final text): a pass proves the real chat runner, tool execution, card persistence, sealing,
// cancel, retry, lease recovery and failure handling - never a real model generation.
// AI_TEST_FUNDING=operator (instance key, NIBOMO_AI_PROVIDER=openai) or user-key (no operator key at all).
// Worker stop/kill phases run only with AI_TEST_ALLOW_WORKER_STOP=yes (ai-acceptance.sh --allow-worker-stop).
// The database is read as the test oracle through `docker compose exec postgres psql`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const LABEL = "SYNTHETIC-TEST-PROVIDER";
const SIMULATION_TEXT_PREFIX = "[SYNTHETIC-TEST-PROVIDER SIMULATION - not a real model answer]";
const SYNTHETIC_CARD_TAG = "nibomo-synthetic";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const step = (name) => console.log(`- ${name}`);
export const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);
const personalKey = (mode) => `sk-nibomo-test-${mode}-${randomUUID()}`;
const syntheticCardFront = (nonce) => `SYNTHETIC ${nonce}: Which provider wrote this card?`;

/**
 * Worker records are `console.log({ domain: "chat_worker", ... })`: Node's inspect format (single- or
 * multi-line), or JSON if a log driver re-encodes them. Flat records only; values come back as strings.
 */
export function parseWorkerRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("{\"")) continue;
    try {
      const value = JSON.parse(line);
      if (value?.domain === "chat_worker") records.push(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])));
    } catch { /* not JSON */ }
  }
  for (const block of text.matchAll(/\{\s*domain: 'chat_worker',[^{}]*\}/gu)) {
    const record = {};
    for (const field of block[0].matchAll(/(\w+): ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^,\s}]+)/gu)) {
      const raw = field[2];
      record[field[1]] = /^['"]/u.test(raw) ? raw.slice(1, -1).replace(/\\(.)/gu, "$1") : raw;
    }
    records.push(record);
  }
  return records;
}

/**
 * Complete SSE frames in `buffer` as parsed JSON events, plus the unfinished tail. Comment frames
 * (keepalives) are skipped; an `event:` name that disagrees with the payload type is a contract error.
 */
export function parseSseFrames(buffer) {
  const events = [];
  const frames = buffer.split("\n\n");
  const rest = frames.pop();
  for (const frame of frames) {
    let name = null;
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length === 0) continue;
    const event = JSON.parse(data.join("\n"));
    if (name !== null && name !== event.type) throw new Error(`SSE event name mismatch: ${name} vs ${event.type}`);
    events.push(event);
  }
  return { events, rest };
}

/** Records written by the newest worker process (after its last `chat_worker_config`). */
export function currentWorkerRecords(records) {
  const start = records.findLastIndex((record) => record.action === "chat_worker_config");
  return start === -1 ? [] : records.slice(start);
}

function createHarness() {
  const env = (name) => {
    const value = process.env[name] ?? "";
    if (value === "") throw new Error(`${name} is required`);
    return value;
  };
  const compose = JSON.parse(env("AI_TEST_COMPOSE"));
  const funding = env("AI_TEST_FUNDING");
  assert.ok(funding === "operator" || funding === "user-key", "AI_TEST_FUNDING must be operator or user-key");
  const operatorKey = funding === "operator" ? env("AI_TEST_OPERATOR_KEY") : null;
  // Never compare key values through assert: a failure diff would print the key.
  if (funding === "user-key" && (process.env.AI_TEST_OPERATOR_KEY ?? "") !== "") throw new Error("user-key funding has no operator key");
  return {
    compose,
    funding,
    operatorKey,
    allowWorkerStop: process.env.AI_TEST_ALLOW_WORKER_STOP === "yes",
    gateway: env("AI_TEST_GATEWAY"),
    mailbox: env("AI_TEST_MAILBOX"),
    authHost: `auth.${env("AI_TEST_BASE_DOMAIN")}`,
    apiHost: `api.${env("AI_TEST_BASE_DOMAIN")}`,
    appOrigin: `https://${env("AI_TEST_APP_HOST")}`,
    email: `ai-acceptance-${randomUUID().slice(0, 8)}@${env("AI_TEST_EMAIL_DOMAIN")}`.toLowerCase(),
    usedKeys: operatorKey === null ? [] : [operatorKey],
  };
}

async function run(h) {
  const dc = (args, options = {}) =>
    execFileSync("docker", [...h.compose, ...args], { encoding: "utf8", maxBuffer: 64 << 20, ...options });
  const uuid = (value) => { assert.match(value, /^[0-9a-f-]{36}$/u); return value; };
  const sql = (query) => dc(["exec", "-T", "postgres", "psql", "-U", "flashcards_owner", "-d", "flashcards",
    "-v", "ON_ERROR_STOP=1", "-Atc", query]).trim();
  const literal = (value) => `'${String(value).replace(/'/gu, "''")}'`;

  function request(path, { method = "GET", host, headers = {}, body, base = h.gateway } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(`${base}${path}`), {
        method,
        headers: {
          ...(host === undefined ? {} : { host }),
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          ...headers,
        },
        timeout: 30_000,
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${path}`)));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  const auth = (path, options = {}) => request(path, { ...options, host: h.authHost });
  const api = (path, options = {}) => request(`/v1${path}`, { ...options, host: h.apiHost });

  async function signIn() {
    const sentAfter = Date.now() - 1_000;
    const sent = await auth("/api/send-code", { method: "POST", body: { email: h.email } });
    assert.equal(sent.status, 200, sent.text);
    let code = null;
    for (let attempt = 0; attempt < 30 && code === null; attempt += 1) {
      const list = await request("/api/v1/messages?limit=20", { base: h.mailbox });
      const message = (list.json?.messages ?? []).find((item) =>
        item.To?.some((to) => to.Address?.toLowerCase() === h.email) && Date.parse(item.Created) >= sentAfter);
      if (message !== undefined) {
        const full = await request(`/api/v1/message/${message.ID}`, { base: h.mailbox });
        code = /sign-in code is (\d{8})/u.exec(full.json?.Text ?? "")?.[1] ?? null;
      } else {
        await sleep(500);
      }
    }
    assert.ok(code, "sign-in code arrived in the development mailbox");
    const verified = await auth("/api/verify-code", {
      method: "POST", body: { code, csrfToken: sent.json.csrfToken, otpSessionToken: sent.json.otpSessionToken },
    });
    assert.equal(verified.status, 200, verified.text);
    return { authorization: `Bearer ${verified.json.idToken}` };
  }

  /** Provider log lines (JSON, labeled) since `since` (ms). */
  const providerEvents = (since) => dc(["logs", "--no-color", "--no-log-prefix", "ai-test-provider"]).split("\n")
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((event) => event.label === LABEL && Date.parse(event.at) >= since);
  const requestsSince = (since) => providerEvents(since).filter((event) => event.event === "request");
  const workerRecords = () => currentWorkerRecords(parseWorkerRecords(dc(["logs", "--no-color", "--no-log-prefix", "worker"])));
  async function waitFor(what, read, accept, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (accept(value)) return value;
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(value)}`);
      await sleep(500);
    }
  }

  const runRow = (requestId) => {
    const row = sql(`SELECT r.run_id, r.status, s.workspace_id,
        (SELECT count(*) FROM ai.chat_run_dispatches d WHERE d.run_id = r.run_id),
        (SELECT count(*) FROM ai.chat_run_dispatch_credentials c WHERE c.run_id = r.run_id)
      FROM ai.chat_runs r JOIN ai.chat_sessions s ON s.session_id = r.session_id
      WHERE r.request_id = ${literal(requestId)}`);
    if (row === "") return null;
    const [runId, status, workspaceId, dispatchRows, credentialRows] = row.split("|");
    return { runId, status, workspaceId, dispatchRows: Number(dispatchRows), credentialRows: Number(credentialRows) };
  };
  const dispatchLease = (runId) => {
    const row = sql(`SELECT state, coalesce(lease_owner, ''), attempt_count, lease_token IS NOT NULL
      FROM ai.chat_run_dispatches WHERE run_id = ${literal(uuid(runId))}`);
    if (row === "") return null;
    const [state, owner, attempts, hasToken] = row.split("|");
    return { state, owner, attempts: Number(attempts), hasToken: hasToken === "t" };
  };
  const terminal = (row) => row !== null && ["completed", "cancelled", "failed", "interrupted"].includes(row.status);

  async function postTurn(bearer, key, text) {
    const fresh = await api("/chat/new", { method: "POST", headers: bearer, body: {} });
    assert.equal(fresh.status, 200, fresh.text);
    const sessionId = uuid(fresh.json.sessionId);
    const clientRequestId = randomUUID();
    if (key !== null) h.usedKeys.push(key);
    const posted = await api("/chat", {
      method: "POST",
      headers: { ...bearer, ...(key === null ? {} : { "x-openai-api-key": key }) },
      body: { sessionId, clientRequestId, content: [{ type: "text", text }], timezone: "UTC" },
    });
    return { sessionId, clientRequestId, posted };
  }
  /**
   * The live envelope POST /chat hands every client: the standalone API's own /v1/chat/live route
   * and a run-scoped `Live` token that expires within the hosted 10 minutes.
   */
  function liveEnvelope(posted, runId) {
    const active = posted.json?.activeRun;
    assert.equal(active?.runId, runId, `POST /chat names the active run: ${posted.text}`);
    const stream = active.live?.stream;
    assert.equal(stream?.url, `https://${h.apiHost}/v1/chat/live`, "live URL is this deployment's API host");
    assert.match(stream.authorization, /^Live [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u, "run-scoped Live token");
    const ttl = stream.expiresAt - Date.now();
    assert.ok(ttl > 0 && ttl <= 10 * 60_000 + 5_000, `live token expires within 10 minutes (${ttl} ms)`);
    return { url: stream.url, authorization: stream.authorization, cursor: active.live.cursor ?? null };
  }

  /**
   * Attaches the way the clients do (liveStream.ts): GET <url>?sessionId&runId[&afterCursor] with the
   * Live header, through the gateway with the envelope's Host. Resolves on run_terminal, end of stream
   * or `timeoutMs`; `abort()` drops the connection like a client going away.
   */
  function attachLive(turn, { authorization = turn.live.authorization, runId = turn.runId, afterCursor = turn.live.cursor,
    origin = h.appOrigin, timeoutMs = 120_000 } = {}) {
    const url = new URL(turn.live.url);
    url.searchParams.set("sessionId", turn.sessionId);
    url.searchParams.set("runId", runId);
    if (afterCursor !== null) url.searchParams.set("afterCursor", afterCursor);
    const events = [];
    let req;
    let timer;
    let response = null;
    const done = new Promise((resolve, reject) => {
      req = http.request(new URL(`${url.pathname}${url.search}`, h.gateway), {
        headers: {
          host: url.host,
          accept: "text/event-stream",
          "x-client-platform": "web",
          ...(authorization === null ? {} : { authorization }),
          ...(origin === null ? {} : { origin }),
        },
      }, (res) => {
        response = res;
        const result = (ended) => ({ status: res.statusCode, headers: res.headers, events, ended, text });
        let text = "";
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (res.statusCode !== 200) { text += chunk; return; }
          try {
            const parsed = parseSseFrames(buffer + chunk);
            buffer = parsed.rest;
            events.push(...parsed.events);
          } catch (error) { reject(error); return; }
          if (events.some((event) => event.type === "run_terminal")) { clearTimeout(timer); resolve(result("terminal")); req.destroy(); }
        });
        res.on("end", () => { clearTimeout(timer); resolve(result("eof")); });
        res.on("error", () => { clearTimeout(timer); resolve(result("reset")); });
        res.on("aborted", () => { clearTimeout(timer); resolve(result("reset")); });
      });
      req.on("error", (error) => { clearTimeout(timer); if (events.length === 0) reject(error); });
      timer = setTimeout(() => {
        resolve({ status: response?.statusCode ?? null, headers: response?.headers ?? {}, events, ended: "timeout", text: "" });
        req.destroy();
      }, timeoutMs);
      req.end();
    });
    return { done, events, abort: () => { clearTimeout(timer); req.destroy(); } };
  }
  const terminalOf = (result) => result.events.find((event) => event.type === "run_terminal");

  async function startTurn(bearer, key, text = "AI acceptance turn (synthetic provider).") {
    const turn = await postTurn(bearer, key, text);
    assert.equal(turn.posted.status, 200, turn.posted.text);
    const row = await waitFor("run row", () => runRow(turn.clientRequestId), (value) => value !== null, 10_000);
    const runId = uuid(row.runId);
    return { ...turn, runId, live: liveEnvelope(turn.posted, runId) };
  }

  const serviceState = (service) => {
    const id = dc(["ps", "-a", "-q", service]).trim();
    assert.ok(id !== "", `${service} container exists`);
    const [status, exitCode] = execFileSync("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", id],
      { encoding: "utf8" }).trim().split(" ");
    return { status, exitCode: Number(exitCode) };
  };
  async function startWorker() {
    dc(["start", "worker"]);
    await waitFor("worker healthy", () => dc(["ps", "--format", "{{.Health}}", "worker"]).trim(),
      (health) => health === "healthy", 120_000);
  }
  /** Names only: values are never read into the harness output. */
  const envNames = (service) => {
    const id = dc(["ps", "-q", service]).trim();
    return JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .Config.Env}}", id], { encoding: "utf8" }))
      .map((entry) => entry.split("=", 1)[0]);
  };
  const mountTargets = (service) => {
    const id = dc(["ps", "-q", service]).trim();
    return JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .Mounts}}", id], { encoding: "utf8" }))
      .map((mount) => mount.Destination);
  };

  /**
   * One scripted SIMULATION turn: the provider answers a sql_execute INSERT INTO cards call, the real
   * runner executes it, then the provider answers a labeled final text. With `retry`, the first model
   * call gets a synthetic overload and the runner's own retry must recover without a duplicate card.
   */
  async function simulatedCardTurn(bearer, key, keyClass, retry) {
    const nonce = randomBytes(8).toString("hex");
    const since = Date.now() - 1_000;
    const turn = await startTurn(bearer, key,
      `AI acceptance SIMULATION (synthetic provider, not a real model). [nibomo-synthetic-card${retry ? "-retry" : ""}:${nonce}]`);
    const live = await attachLive(turn).done;
    assert.equal(live.status, 200, `live attach: ${live.text}`);
    assert.equal(live.headers["content-type"], "text/event-stream");
    assert.equal(live.headers["access-control-allow-origin"], h.appOrigin, "live CORS answers the app origin");
    assert.equal(live.ended, "terminal", `live stream ended with run_terminal: ${JSON.stringify(live.events.map((e) => e.type))}`);
    assert.equal(terminalOf(live).outcome, "completed");
    assert.ok(live.events.every((event) => event.sessionId === turn.sessionId && event.runId === turn.runId), "every event scoped to this run");
    assert.ok(JSON.stringify(live.events).includes(SIMULATION_TEXT_PREFIX), "the labeled simulation reply arrived over the live stream");
    const row = await waitFor("simulated run terminal", () => runRow(turn.clientRequestId), terminal, 90_000);
    assert.equal(row.status, "completed", `simulated turn completed: ${JSON.stringify(row)}`);
    assert.deepEqual([row.dispatchRows, row.credentialRows], [0, 0]);

    const front = syntheticCardFront(nonce);
    const stored = sql(`SELECT count(*), coalesce(bool_and(${literal(SYNTHETIC_CARD_TAG)} = ANY(tags)), false)
      FROM content.cards WHERE workspace_id = ${literal(uuid(row.workspaceId))} AND front_text = ${literal(front)} AND deleted_at IS NULL`);
    assert.equal(stored, "1|t", "exactly one synthetic card saved in the session workspace (no duplicate on retry)");
    const listed = await api(`/workspaces/${row.workspaceId}/cards/query`, { method: "POST", headers: bearer, body: { limit: 10, searchText: nonce } });
    assert.equal(listed.status, 200, listed.text);
    assert.ok((listed.json?.cards ?? []).some((card) => card.frontText === front), "card visible through the cards API");
    const chat = await api(`/chat?sessionId=${turn.sessionId}`, { headers: bearer });
    assert.equal(chat.status, 200, chat.text);
    assert.ok(chat.text.includes(SIMULATION_TEXT_PREFIX) && chat.text.includes("reported success"),
      "assistant reply is the labeled simulation text and the tool reported success");

    const streams = requestsSince(since).filter((event) => event.simulation === nonce);
    assert.equal(streams.length, retry ? 3 : 2, `model calls: ${JSON.stringify(streams)}`);
    assert.ok(streams.every((event) => event.keyClass === keyClass && event.keyFp === (key === null ? fingerprint(h.operatorKey) : fingerprint(key))),
      JSON.stringify(streams));
    const steps = providerEvents(since).filter((event) => event.event === "simulated" && event.nonce === nonce).map((event) => event.step);
    assert.deepEqual(steps, retry ? ["overloaded", "tool_call", "final_text"] : ["tool_call", "final_text"]);
    if (key !== null) {
      assert.equal(requestsSince(since).filter((event) => event.keyClass === "operator").length, 0, "no operator-key call for an own-key turn");
    }
    return nonce;
  }

  const workerPhase = (name) => {
    if (h.allowWorkerStop) return true;
    console.log(`- SKIPPED (no --allow-worker-stop): ${name}`);
    return false;
  };

  console.log(`AI acceptance (${h.funding} funding) with the ${LABEL}: errors, stalls and labeled SIMULATIONS only; no real provider, no real generation`);

  step("worker config and isolation: funding mode, personal keys sealed, synthetic provider labeled");
  const config = workerRecords().find((record) => record.action === "chat_worker_config");
  assert.ok(config !== undefined, "worker logged chat_worker_config");
  assert.equal(config.aiFunding, h.funding);
  assert.equal(config.personalOpenAIKeys, "sealed");
  const firstWorkerId = config.workerId;
  assert.ok(providerEvents(0).some((event) => event.event === "listening" && event.funding === h.funding), "synthetic provider is listening");
  for (const service of ["backend", "worker"]) {
    const names = envNames(service);
    const mounts = mountTargets(service);
    if (h.funding === "user-key") {
      assert.ok(!names.includes("OPENAI_API_KEY") && !names.includes("OPENAI_API_KEY_FILE"), `${service} has no operator key variable`);
      assert.ok(!mounts.some((target) => target.endsWith("/openai_api_key")), `${service} has no operator key mount`);
    }
    assert.ok(names.includes("OPENAI_BASE_URL"), `${service} points at the synthetic provider`);
  }

  const bearer = await signIn();

  if (h.funding === "operator") {
    step("operator-key turn: provider 401 -> run failed, operator key used, one request");
    const since = Date.now() - 1_000;
    const turn = await startTurn(bearer, null);
    const row = await waitFor("operator run terminal", () => runRow(turn.clientRequestId), terminal, 90_000);
    assert.equal(row.status, "failed");
    assert.equal(row.dispatchRows, 0);
    const requests = requestsSince(since);
    assert.equal(requests.filter((event) => event.keyClass === "operator").length, 1, JSON.stringify(requests));
    assert.equal(requests.filter((event) => event.keyClass !== "operator").length, 0, JSON.stringify(requests));

    step("operator-funded SIMULATION: sql_execute card insert executed, card saved, labeled reply, turn completed");
    await simulatedCardTurn(bearer, null, "operator", false);
  } else {
    step("user-key funding: keyless turn refused before anything is written, no provider call");
    const since = Date.now() - 1_000;
    const turn = await postTurn(bearer, null, "AI acceptance keyless turn (must be refused).");
    assert.equal(turn.posted.status, 400, turn.posted.text);
    assert.equal(turn.posted.json?.code, "OPENAI_API_KEY_REQUIRED_STANDALONE", turn.posted.text);
    await sleep(2_000);
    assert.equal(runRow(turn.clientRequestId), null, "no run row for a refused keyless turn");
    assert.equal(requestsSince(since).length, 0, "no provider request for a refused keyless turn");
  }

  step("personal-key SIMULATION: own key only, credential consumed, card saved, labeled reply");
  await simulatedCardTurn(bearer, personalKey("script"), "personal", false);

  step("retry recovery: synthetic overload on the first model call, runner retries once, one card");
  await simulatedCardTurn(bearer, personalKey("script"), "personal", true);

  step("personal-key turn: provider 401 -> run failed with the personal key only, credential consumed");
  {
    const since = Date.now() - 1_000;
    const key = personalKey("fail401");
    const turn = await startTurn(bearer, key);
    const row = await waitFor("personal run terminal", () => runRow(turn.clientRequestId), terminal, 90_000);
    assert.equal(row.status, "failed");
    assert.deepEqual([row.dispatchRows, row.credentialRows], [0, 0]);
    const requests = requestsSince(since);
    assert.equal(requests.filter((event) => event.keyFp === fingerprint(key)).length, 1, JSON.stringify(requests));
    assert.equal(requests.filter((event) => event.keyClass === "operator").length, 0, "no operator-key fallback");
  }

  step("cancel: stalled provider, exact lease held by this worker, POST /chat/stop -> cancelled, request aborted");
  {
    const since = Date.now() - 1_000;
    const key = personalKey("hang");
    const turn = await startTurn(bearer, key);
    await waitFor("stalled request", () => requestsSince(since), (events) => events.some((event) => event.keyFp === fingerprint(key)), 90_000);
    const lease = dispatchLease(turn.runId);
    assert.deepEqual(lease, { state: "leased", owner: firstWorkerId, attempts: 1, hasToken: true }, "lease owned by the running worker");

    step("live stream refusals: no credential, forged signature, token for another run, foreign Origin");
    const refused = async (what, options, status, code) => {
      const result = await attachLive(turn, { ...options, timeoutMs: 15_000 }).done;
      assert.equal(result.status, status, `${what}: ${result.text}`);
      if (code !== null) assert.equal(JSON.parse(result.text).code, code, what);
      assert.equal(result.events.length, 0, `${what}: no events`);
    };
    await refused("no credential", { authorization: null }, 401, null);
    const [payload, signature] = turn.live.authorization.slice(5).split(".");
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    await refused("forged signature", { authorization: `Live ${payload}.${flipped}` }, 401, "CHAT_LIVE_AUTH_INVALID");
    await refused("token for another run", { runId: randomUUID() }, 401, "CHAT_LIVE_AUTH_INVALID");
    const foreign = attachLive(turn, { origin: "https://evil.example", timeoutMs: 3_000 });
    const foreignResult = await foreign.done;
    assert.equal(foreignResult.headers?.["access-control-allow-origin"], undefined, "no CORS grant for a foreign Origin");

    step("cancel over the live stream: attached client sees run_terminal stopped after POST /chat/stop");
    const attached = attachLive(turn, { timeoutMs: 90_000 });
    await sleep(1_500);
    const stopped = await api("/chat/stop", { method: "POST", headers: bearer, body: { sessionId: turn.sessionId, runId: turn.runId } });
    assert.equal(stopped.status, 200, stopped.text);
    const live = await attached.done;
    assert.equal(live.ended, "terminal", `live stream ended with run_terminal: ${JSON.stringify(live.events.map((e) => e.type))}`);
    assert.equal(terminalOf(live).outcome, "stopped");
    const row = await waitFor("cancelled run", () => runRow(turn.clientRequestId), terminal, 60_000);
    assert.equal(row.status, "cancelled");
    await waitFor("provider saw the abort", () => providerEvents(since), (events) =>
      events.some((event) => event.event === "client_closed" && event.keyFp === fingerprint(key)), 30_000);
    await waitFor("dispatch released", () => runRow(turn.clientRequestId).dispatchRows, (count) => count === 0, 30_000);
  }

  if (workerPhase("backend SIGKILL mid-stream: live attach drops, re-attach after restart, stop delivered")) {
    step("backend SIGKILL mid-stream: live attach drops without run_terminal, same token re-attaches after restart, stop delivered");
    const since = Date.now() - 1_000;
    const key = personalKey("hang");
    const turn = await startTurn(bearer, key);
    await waitFor("stalled request", () => requestsSince(since), (events) => events.some((event) => event.keyFp === fingerprint(key)), 90_000);
    const first = attachLive(turn, { timeoutMs: 60_000 });
    await sleep(1_500);
    dc(["kill", "-s", "SIGKILL", "backend"]);
    const dropped = await first.done;
    assert.notEqual(dropped.ended, "terminal", "no run_terminal from a killed backend");
    assert.notEqual(dropped.ended, "timeout", "the client sees the connection end");
    dc(["start", "backend"]);
    await waitFor("backend healthy", () => dc(["ps", "--format", "{{.Health}}", "backend"]).trim(), (health) => health === "healthy", 120_000);
    assert.equal(runRow(turn.clientRequestId).status, "running", "the run survives an API restart (worker-owned)");
    const again = attachLive(turn, { timeoutMs: 90_000 });
    await sleep(1_500);
    const stopped = await api("/chat/stop", { method: "POST", headers: bearer, body: { sessionId: turn.sessionId, runId: turn.runId } });
    assert.equal(stopped.status, 200, stopped.text);
    const live = await again.done;
    assert.equal(live.status, 200);
    assert.equal(live.ended, "terminal", `re-attached stream ended with run_terminal: ${JSON.stringify(live.events.map((e) => e.type))}`);
    assert.equal(terminalOf(live).outcome, "stopped");
    assert.equal((await waitFor("cancelled run", () => runRow(turn.clientRequestId), terminal, 60_000)).status, "cancelled");
  }

  if (workerPhase("worker stopped: personal-key turn waits sealed, runs after restart")) {
    step("worker stopped: personal-key turn waits sealed (ciphertext only), runs after restart");
    dc(["stop", "worker"]);
    const since = Date.now() - 1_000;
    const key = personalKey("fail401");
    const turn = await startTurn(bearer, key);
    let row = runRow(turn.clientRequestId);
    assert.deepEqual([row.status, row.dispatchRows, row.credentialRows], ["queued", 1, 1]);
    assert.deepEqual(dispatchLease(turn.runId), { state: "pending", owner: "", attempts: 0, hasToken: false });
    const dump = dc(["exec", "-T", "postgres", "pg_dump", "-U", "flashcards_owner", "-d", "flashcards", "--data-only"]);
    for (const used of h.usedKeys) assert.equal(dump.includes(used), false, `key ${fingerprint(used)} absent from a database dump`);
    await startWorker();
    row = await waitFor("queued run terminal after restart", () => runRow(turn.clientRequestId), terminal, 90_000);
    assert.equal(row.status, "failed");
    assert.deepEqual([row.dispatchRows, row.credentialRows], [0, 0]);
    assert.equal(requestsSince(since).filter((event) => event.keyFp === fingerprint(key)).length, 1);
  }

  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!workerPhase(`${signal} mid-run: interrupted after restart by the new lease owner, never replayed`)) continue;
    step(`${signal} mid-run: interrupted after restart by the new lease owner, never replayed`);
    const since = Date.now() - 1_000;
    const ownerBefore = workerRecords().find((record) => record.action === "chat_worker_config")?.workerId;
    const key = personalKey("hang");
    const turn = await startTurn(bearer, key);
    await waitFor("stalled request", () => requestsSince(since), (events) => events.some((event) => event.keyFp === fingerprint(key)), 90_000);
    const leaseBefore = dispatchLease(turn.runId);
    assert.deepEqual(leaseBefore, { state: "leased", owner: ownerBefore, attempts: 1, hasToken: true }, "lease owned by the running worker");
    if (signal === "SIGTERM") {
      // The stalled run cannot drain: the worker waits CHAT_WORKER_SHUTDOWN_GRACE_MS and exits 1 itself
      // (in-flight left), inside stop_grace_period, so Docker never needs SIGKILL (137).
      dc(["stop", "worker"]);
      assert.equal(serviceState("worker").exitCode, 1, "worker exits 1 with one run left after its shutdown grace");
    } else {
      dc(["kill", "-s", "SIGKILL", "worker"]);
    }
    assert.equal(serviceState("worker").status, "exited");
    assert.equal(runRow(turn.clientRequestId).status, "running", "run left running by the stopped worker");
    assert.equal(dispatchLease(turn.runId).owner, ownerBefore, "stopped worker's lease stays until recovery");
    await startWorker();
    const ownerAfter = workerRecords().find((record) => record.action === "chat_worker_config")?.workerId;
    assert.ok(ownerAfter !== undefined && ownerAfter !== ownerBefore, "restarted worker has a new lease owner id");
    const row = await waitFor("abandoned run interrupted", () => runRow(turn.clientRequestId), terminal, 180_000);
    assert.equal(row.status, "interrupted");
    const live = await attachLive(turn, { timeoutMs: 30_000 }).done;
    assert.equal(live.ended, "terminal", `live attach after recovery: ${JSON.stringify(live.events.map((e) => e.type))}`);
    assert.notEqual(terminalOf(live).outcome, "completed", "recovered run is not reported completed");
    await waitFor("dispatch settled by the recoverer", () => runRow(turn.clientRequestId).dispatchRows, (count) => count === 0, 30_000);
    const recovered = workerRecords().filter((record) => record.action === "chat_worker_dispatch_recovered" && record.runId === turn.runId);
    assert.ok(recovered.some((record) => record.runStatus === "interrupted"), `new owner interrupted it: ${JSON.stringify(recovered)}`);
    assert.ok(!recovered.some((record) => record.outcome === "lease_lost"), "recoverer held its lease");
    const requests = requestsSince(since).filter((event) => event.keyFp === fingerprint(key));
    assert.equal(requests.length, 1, `no replay: ${JSON.stringify(requests)}`);
  }

  step("no key material in backend, worker or provider logs; no operator key used in user-key funding");
  const logs = dc(["logs", "--no-color", "backend", "worker", "ai-test-provider"]);
  for (const key of h.usedKeys) assert.equal(logs.includes(key), false, `key ${fingerprint(key)} absent from logs`);
  if (h.funding === "user-key") {
    assert.equal(providerEvents(0).filter((event) => event.event === "request" && event.keyClass === "operator").length, 0, "no operator-shaped key ever sent");
  }

  const partial = h.allowWorkerStop ? "" : " PARTIAL: worker stop/kill phases skipped;";
  console.log(`AI ACCEPTANCE PASS (${h.funding} funding;${partial} synthetic provider: error, labeled SIMULATED card turn over the live stream, live auth refusals, retry, cancel, backend/worker kill recovery, lease, sealing; no real generation)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  Promise.resolve().then(() => run(createHarness())).catch((error) => {
    console.error(`AI ACCEPTANCE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
