// SYNTHETIC TEST PROVIDER for compose.ai-test.yml only. Every answer it gives is a labeled SIMULATION:
// it never forwards anything, holds no real key, and no run it serves is a real generation.
//
// The bearer key picks the behaviour:
// - personal keys sk-nibomo-test-<fail401|fail500|hang|script>-<uuid>;
// - the instance operator key (operator funding only) is recognised by its SHA-256 in
//   AI_TEST_OPERATOR_KEY_SHA256 and must be a synthetic sk-nibomo-test-operator-<uuid> key. With
//   AI_TEST_FUNDING=user-key there is no operator key: any operator-shaped key is still logged as class
//   "operator" (the harness requires zero of them) and refused 401.
// Operator and `script` keys answer 401 unless the turn's newest user message carries a simulation marker
//   [nibomo-synthetic-card:<8-32 hex>]        stream one sql_execute INSERT INTO cards call, then, once
//                                            the request carries that call's output, a labeled final text
//   [nibomo-synthetic-card-retry:<8-32 hex>]  the same, but the first model call of that nonce gets a
//                                            synthetic server_is_overloaded stream error (runner retry path)
// Any other request (non-streaming, other routes, no marker) is a labeled 4xx. Each request and client
// disconnect is one JSON line on stdout with key class and a 12-hex SHA-256 fingerprint, never the key.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const LABEL = "SYNTHETIC-TEST-PROVIDER";
export const SIMULATION_TEXT_PREFIX = "[SYNTHETIC-TEST-PROVIDER SIMULATION - not a real model answer]";
export const SYNTHETIC_CARD_TAG = "nibomo-synthetic";
const MARKER = /\[nibomo-synthetic-card(-retry)?:([0-9a-f]{8,32})\]/u;
const MAX_BODY_BYTES = 4 << 20;
const MAX_SCRIPT_CALLS = 3;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const fingerprint = (key) => sha256(key).slice(0, 12);

/** Refuses anything but a disposable test project and a coherent funding mode. */
export function readProviderConfig(env) {
  const project = env.AI_TEST_PROJECT ?? "";
  if (project === "" || project === "nibomo") {
    throw new Error(`refused for Compose project ${JSON.stringify(project)}; test projects only`);
  }
  const funding = env.AI_TEST_FUNDING ?? "";
  const operatorSha = env.AI_TEST_OPERATOR_KEY_SHA256 ?? "";
  if (funding === "operator") {
    if (!/^[0-9a-f]{64}$/u.test(operatorSha)) throw new Error("operator funding needs AI_TEST_OPERATOR_KEY_SHA256 (64 hex)");
  } else if (funding === "user-key") {
    if (operatorSha !== "" && operatorSha !== "none") throw new Error("user-key funding has no operator key; AI_TEST_OPERATOR_KEY_SHA256 must be none");
  } else {
    throw new Error("AI_TEST_FUNDING must be operator or user-key");
  }
  const port = Number.parseInt(env.AI_TEST_PORT ?? "8080", 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("AI_TEST_PORT must be a port number");
  return { project, funding, operatorSha: funding === "operator" ? operatorSha : null, port };
}

export function classify(authorization, config) {
  const key = /^Bearer\s+(\S+)$/u.exec(authorization ?? "")?.[1] ?? "";
  const keyFp = key === "" ? null : fingerprint(key);
  if (/^sk-nibomo-test-operator-[0-9a-f-]{36}$/u.test(key)) {
    const instanceKey = config.operatorSha !== null && sha256(key) === config.operatorSha;
    return { keyClass: "operator", mode: instanceKey ? "script" : "fail401", instanceKey, keyFp };
  }
  const mode = /^sk-nibomo-test-(fail401|fail500|hang|script)-[0-9a-f-]{36}$/u.exec(key)?.[1];
  if (mode !== undefined) return { keyClass: "personal", mode, keyFp };
  return { keyClass: "unknown", mode: "fail401", keyFp };
}

const inputItems = (body) => (Array.isArray(body?.input) ? body.input : []);
const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "");

/** The marker counts only in the newest user message, so history and system text cannot trigger it. */
export function findMarker(body) {
  const users = inputItems(body).filter((item) => item?.role === "user" && (item.type === undefined || item.type === "message"));
  const match = MARKER.exec(textOf(users.at(-1)?.content));
  return match === null ? null : { nonce: match[2], retry: match[1] !== undefined };
}

export const syntheticCallId = (nonce) => `call_synthetic_${nonce}`;
export const syntheticCardFront = (nonce) => `SYNTHETIC ${nonce}: Which provider wrote this card?`;
export const syntheticCardBack = (nonce) => `The labeled synthetic test provider (simulation ${nonce}), not a real model.`;
export const syntheticCardSql = (nonce) =>
  `INSERT INTO cards (front_text, back_text, tags) VALUES ('${syntheticCardFront(nonce)}', '${syntheticCardBack(nonce)}', ('${SYNTHETIC_CARD_TAG}'))`;

/** Pure: what the scripted turn answers to one model call. */
export function planScriptedTurn(body, marker, overloadedNonces) {
  if (marker.retry && !overloadedNonces.has(marker.nonce)) {
    overloadedNonces.add(marker.nonce);
    return { kind: "overloaded" };
  }
  const callId = syntheticCallId(marker.nonce);
  const items = inputItems(body);
  if (items.filter((item) => item?.type === "function_call" && item.call_id === callId).length >= MAX_SCRIPT_CALLS) {
    return { kind: "error", status: 400, code: "synthetic_script_exhausted", message: "Synthetic script already ran" };
  }
  const output = items.find((item) => item?.type === "function_call_output" && item.call_id === callId);
  if (output === undefined) return { kind: "tool_call", callId, arguments: JSON.stringify({ sql: syntheticCardSql(marker.nonce) }) };
  const outputText = typeof output.output === "string" ? output.output : JSON.stringify(output.output ?? null);
  const toolOk = /"ok"\s*:\s*true/u.test(outputText) && !/"ok"\s*:\s*false/u.test(outputText);
  return {
    kind: "final_text",
    text: `${SIMULATION_TEXT_PREFIX} Simulated card ${marker.nonce}: the sql_execute tool ${toolOk ? "reported success" : "did not report success"}.`,
  };
}

const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };

/** Pure: the Responses API stream (SSE frames) for one plan step. */
export function scriptedEvents(plan, model, responseId) {
  const base = {
    id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model, error: null,
    incomplete_details: null, instructions: null, metadata: { simulation: LABEL }, parallel_tool_calls: false,
    temperature: null, tool_choice: "auto", tools: [], top_p: null,
  };
  let sequence = 0;
  const event = (type, fields) => ({ event: type, data: { type, sequence_number: sequence++, ...fields } });
  if (plan.kind === "overloaded") {
    return [{ event: "error", data: { error: { type: "service_unavailable_error", code: "server_is_overloaded", message: `Synthetic overload (${LABEL} simulation)`, param: null } } }];
  }
  const events = [event("response.created", { response: { ...base, status: "in_progress", output: [], usage: null } })];
  let item;
  if (plan.kind === "tool_call") {
    item = { type: "function_call", id: `fc_${plan.callId}`, call_id: plan.callId, name: "sql_execute", arguments: plan.arguments, status: "completed" };
    events.push(
      event("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
      event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: plan.arguments }),
      event("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: plan.arguments }),
      event("response.output_item.done", { output_index: 0, item }),
    );
  } else {
    const part = { type: "output_text", text: plan.text, annotations: [] };
    item = { type: "message", id: `msg_${responseId}`, role: "assistant", status: "completed", phase: "final_answer", content: [part] };
    events.push(
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
      event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } }),
      event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: plan.text, logprobs: [] }),
      event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: plan.text, logprobs: [] }),
      event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part }),
      event("response.output_item.done", { output_index: 0, item }),
    );
  }
  events.push(event("response.completed", { response: { ...base, status: "completed", output: [item], usage } }));
  return events;
}

export function createProviderServer(config, log) {
  const held = new Set();
  const overloadedNonces = new Set();
  const sendError = (res, status, message, code) => {
    res.writeHead(status, { "content-type": "application/json", "x-synthetic-provider": LABEL });
    res.end(JSON.stringify({ error: { message: `${message} (${LABEL})`, type: "invalid_request_error", code, param: null } }));
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/__test/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, label: LABEL, funding: config.funding }));
      return;
    }
    const who = classify(req.headers.authorization, config);
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size <= MAX_BODY_BYTES) chunks.push(chunk); });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
      const marker = path === "/v1/responses" && req.method === "POST" && size <= MAX_BODY_BYTES ? findMarker(body) : null;
      // Only streamed turns are scripted: a non-streamed call (e.g. follow-up suggestions, which quote the
      // user's text) gets the labeled 400 below and counts as no simulation.
      const scripted = marker !== null && who.mode === "script" && body?.stream === true;
      log({ event: "request", method: req.method, path, ...who, stream: body?.stream === true, simulation: scripted ? marker.nonce : null });
      if (marker !== null && who.mode === "script" && !scripted) {
        sendError(res, 400, "Synthetic provider simulates only streaming chat turns", "synthetic_stream_only");
        return;
      }
      if (scripted) {
        const plan = planScriptedTurn(body, marker, overloadedNonces);
        log({ event: "simulated", path, keyClass: who.keyClass, keyFp: who.keyFp, nonce: marker.nonce, step: plan.kind });
        if (plan.kind === "error") {
          sendError(res, plan.status, plan.message, plan.code);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-synthetic-provider": LABEL });
        const model = typeof body.model === "string" ? body.model.slice(0, 64) : "synthetic";
        for (const frame of scriptedEvents(plan, model, `resp_synthetic_${marker.nonce}_${Date.now()}`)) {
          res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        }
        res.end();
        return;
      }
      if (who.mode === "hang") {
        // Accept and never answer, like a stalled provider; the caller must cancel, stop or time out.
        held.add(res);
        res.on("close", () => {
          held.delete(res);
          log({ event: "client_closed", path, ...who });
        });
        return;
      }
      if (who.mode === "fail500") {
        sendError(res, 500, "Synthetic provider failure", "server_error");
        return;
      }
      sendError(res, 401, "Incorrect API key provided", "invalid_api_key");
    });
  });
  server.destroyHeld = () => { for (const res of held) res.destroy(); };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let config;
  try {
    config = readProviderConfig(process.env);
  } catch (error) {
    console.error(`${LABEL}: ${error.message}`);
    process.exit(78);
  }
  const log = (record) => console.log(JSON.stringify({ label: LABEL, at: new Date().toISOString(), ...record }));
  const server = createProviderServer(config, log);
  server.listen(config.port, "0.0.0.0", () => log({ event: "listening", port: server.address().port, project: config.project, funding: config.funding }));
  process.on("SIGTERM", () => {
    server.destroyHeld();
    server.close(() => process.exit(0));
  });
}
