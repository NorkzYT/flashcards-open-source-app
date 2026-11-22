// Pure checks of the synthetic provider on a loopback port: refusals, key classes, the labeled scripted
// card turn, the overload-then-retry script and key hygiene. No Docker, no network beyond 127.0.0.1.
//   node --test infra/selfhost/ai-test-provider.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createProviderServer, findMarker, LABEL, readProviderConfig, sha256, SIMULATION_TEXT_PREFIX, syntheticCallId,
  syntheticCardFront,
} from "./ai-test-provider.mjs";

const operatorKey = `sk-nibomo-test-operator-${randomUUID()}`;
const scriptKey = `sk-nibomo-test-script-${randomUUID()}`;
const logged = [];
const servers = {};

async function listen(env) {
  const server = createProviderServer(readProviderConfig({ AI_TEST_PROJECT: "ai-unit", AI_TEST_PORT: "0", ...env }),
    (record) => logged.push(JSON.stringify({ label: LABEL, ...record })));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
before(async () => {
  servers.operator = await listen({ AI_TEST_FUNDING: "operator", AI_TEST_OPERATOR_KEY_SHA256: sha256(operatorKey) });
  servers.userKey = await listen({ AI_TEST_FUNDING: "user-key", AI_TEST_OPERATOR_KEY_SHA256: "none" });
});
after(() => { for (const { server } of Object.values(servers)) { server.destroyHeld(); server.close(); } });

const userTurn = (text, extra = []) => ({
  model: "gpt-test", stream: true,
  input: [{ role: "system", type: "message", content: "system [nibomo-synthetic-card:ffffffffffffffff]" },
    { role: "user", type: "message", content: [{ type: "input_text", text }] }, ...extra],
});
async function post(base, key, body) {
  const res = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  const frames = res.headers.get("content-type") === "text/event-stream"
    ? text.trim().split("\n\n").map((frame) => {
      const [, event] = /^event: (.+)$/mu.exec(frame);
      const [, data] = /^data: (.+)$/mu.exec(frame);
      return { event, data: JSON.parse(data) };
    })
    : null;
  return { status: res.status, text, frames };
}

test("refuses project nibomo, unknown funding and incoherent operator key settings", () => {
  assert.throws(() => readProviderConfig({ AI_TEST_PROJECT: "nibomo", AI_TEST_FUNDING: "user-key" }), /test projects only/u);
  assert.throws(() => readProviderConfig({ AI_TEST_PROJECT: "", AI_TEST_FUNDING: "user-key" }), /test projects only/u);
  assert.throws(() => readProviderConfig({ AI_TEST_PROJECT: "t", AI_TEST_FUNDING: "byok" }), /operator or user-key/u);
  assert.throws(() => readProviderConfig({ AI_TEST_PROJECT: "t", AI_TEST_FUNDING: "operator" }), /64 hex/u);
  assert.throws(() => readProviderConfig({ AI_TEST_PROJECT: "t", AI_TEST_FUNDING: "user-key", AI_TEST_OPERATOR_KEY_SHA256: sha256(operatorKey) }), /must be none/u);
});

test("marker counts only in the newest user message", () => {
  assert.equal(findMarker(userTurn("plain turn")), null);
  assert.deepEqual(findMarker(userTurn("go [nibomo-synthetic-card-retry:0123abcd]")), { nonce: "0123abcd", retry: true });
  const older = userTurn("new turn");
  older.input.splice(1, 0, { role: "user", type: "message", content: "[nibomo-synthetic-card:0123abcd]" });
  assert.equal(findMarker(older), null);
});

test("errors stay errors: no marker, unknown key, fail500, operator-shaped key under user-key funding", async () => {
  const { base } = servers.operator;
  assert.equal((await post(base, operatorKey, userTurn("plain turn"))).status, 401);
  assert.equal((await post(base, `sk-proj-${randomUUID()}`, userTurn("x [nibomo-synthetic-card:0123abcd]"))).status, 401);
  assert.equal((await post(base, `sk-nibomo-test-operator-${randomUUID()}`, userTurn("x [nibomo-synthetic-card:0123abcd]"))).status, 401,
    "only the instance operator key may run the script");
  assert.equal((await post(base, `sk-nibomo-test-fail500-${randomUUID()}`, userTurn("x"))).status, 500);
  assert.equal((await post(base, scriptKey, userTurn("plain turn"))).status, 401);
  const nonStream = await post(base, operatorKey, { ...userTurn("x [nibomo-synthetic-card:0123abcd]"), stream: false });
  assert.equal(nonStream.status, 400);
  assert.match(nonStream.text, /synthetic_stream_only/u);
  const userKeyServer = servers.userKey.base;
  const refused = await post(userKeyServer, operatorKey, userTurn("x [nibomo-synthetic-card:0123abcd]"));
  assert.equal(refused.status, 401);
  assert.ok(logged.some((line) => line.includes('"keyClass":"operator"') && line.includes('"instanceKey":false')));
});

for (const [name, key] of [["operator-funded", operatorKey], ["personal key", scriptKey]]) {
  test(`${name} scripted card turn: sql_execute call, then labeled final text after the tool output`, async () => {
    const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
    const first = await post(servers.operator.base, key, userTurn(`go [nibomo-synthetic-card:${nonce}]`));
    assert.equal(first.status, 200);
    const types = first.frames.map((frame) => frame.event);
    assert.deepEqual(types, ["response.created", "response.output_item.added", "response.function_call_arguments.delta",
      "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    const completed = first.frames.at(-1).data.response;
    assert.equal(completed.status, "completed");
    assert.equal(completed.metadata.simulation, LABEL);
    const [call] = completed.output;
    assert.deepEqual([call.type, call.name, call.call_id], ["function_call", "sql_execute", syntheticCallId(nonce)]);
    const sql = JSON.parse(call.arguments).sql;
    assert.ok(sql.startsWith("INSERT INTO cards (front_text, back_text, tags) VALUES (") && sql.includes(syntheticCardFront(nonce)));

    const output = { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ ok: true, tool: "sql_execute", data: {} }) };
    const second = await post(servers.operator.base, key, userTurn(`go [nibomo-synthetic-card:${nonce}]`,
      [{ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments }, output]));
    const final = second.frames.at(-1).data.response;
    assert.equal(final.status, "completed");
    assert.equal(final.output[0].type, "message");
    assert.ok(final.output[0].content[0].text.startsWith(SIMULATION_TEXT_PREFIX));
    assert.match(final.output[0].content[0].text, /reported success/u);
    assert.ok(second.frames.some((frame) => frame.event === "response.output_text.delta"));
  });
}

test("retry marker: first call is a synthetic server_is_overloaded stream error, the next runs the script", async () => {
  const nonce = "abcdef0123456789";
  const first = await post(servers.operator.base, scriptKey, userTurn(`go [nibomo-synthetic-card-retry:${nonce}]`));
  assert.equal(first.status, 200);
  assert.deepEqual(first.frames.map((frame) => frame.event), ["error"]);
  assert.equal(first.frames[0].data.error.code, "server_is_overloaded");
  const second = await post(servers.operator.base, scriptKey, userTurn(`go [nibomo-synthetic-card-retry:${nonce}]`));
  assert.equal(second.frames.at(-1).data.response.output[0].name, "sql_execute");
});

test("hang is held until the client aborts, and no key ever appears in the provider log", async () => {
  const hangKey = `sk-nibomo-test-hang-${randomUUID()}`;
  const controller = new AbortController();
  const pending = fetch(`${servers.operator.base}/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${hangKey}` }, body: "{}", signal: controller.signal,
  }).catch((error) => error);
  await new Promise((done) => setTimeout(done, 200));
  controller.abort();
  assert.equal((await pending).name, "AbortError");
  await new Promise((done) => setTimeout(done, 200));
  assert.ok(logged.some((line) => line.includes('"event":"client_closed"')));
  const all = logged.join("\n");
  for (const key of [operatorKey, scriptKey, hangKey]) assert.equal(all.includes(key), false);
});
