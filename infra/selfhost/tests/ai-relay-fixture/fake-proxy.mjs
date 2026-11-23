// TEST ONLY (tests/ai-relay-docker.sh): a synthetic stand-in for the operator's OpenAI-compatible proxy.
// One port serves plain HTTP and TLS (first byte 0x16), so the fixture can prove both through ai-relay.
// It answers the Responses API with one streamed tool call, then streamed text, for the synthetic key only;
// /echo reports what arrived; /redirect points outside the stack. Never a real provider.
import { readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp } from "node:net";

const KEY = process.env.FAKE_PROXY_KEY ?? "";
let responsesCalls = 0;

function sse(events) {
  return events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");
}
function response(output, status) {
  return { id: `resp-${responsesCalls}`, object: "response", created_at: 0, status, model: "synthetic-proxy-model",
    output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}
function toolTurn() {
  const item = { type: "function_call", id: "fc-1", call_id: "call-fx-1", name: "list_workspaces", arguments: "{}", status: "completed" };
  return sse([
    { type: "response.created", response: response([], "in_progress") },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-1", delta: "{}" },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc-1", arguments: "{}" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: response([item], "completed") },
  ]);
}
function textTurn() {
  const msg = { type: "message", id: "msg-1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Relay answer.", annotations: [] }] };
  return sse([
    { type: "response.created", response: response([], "in_progress") },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg-1", content_index: 0, delta: "Relay " },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg-1", content_index: 0, delta: "answer." },
    { type: "response.completed", response: response([msg], "completed") },
  ]);
}

function handler(request, res) {
  const chunks = [];
  request.on("data", (c) => chunks.push(c));
  request.on("end", () => {
    const authorized = request.headers.authorization === `Bearer ${KEY}`;
    if (request.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: request.headers.host, tls: Boolean(request.socket.encrypted),
        forwarded: request.headers["x-forwarded-for"] ?? null }));
      return;
    }
    if (request.url === "/redirect") {
      res.writeHead(302, { location: "http://192.0.2.10/v1/responses" });
      res.end();
      return;
    }
    if (request.url === "/v1/responses" && request.method === "POST" && authorized) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      responsesCalls += 1;
      console.log(`fake-proxy: responses call ${responsesCalls} model=${body.model} stream=${body.stream} host=${request.headers.host}`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(responsesCalls % 2 === 1 ? toolTurn() : textTurn());
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic proxy: unexpected path or key", type: "invalid_request_error" } }));
  });
}

const http = createHttp(handler);
const https = createHttps({ key: readFileSync("/fixture/tls/key.pem"), cert: readFileSync("/fixture/tls/cert.pem") }, handler);
createTcp((socket) => {
  socket.once("data", (first) => {
    socket.pause();
    socket.unshift(first);
    (first[0] === 0x16 ? https : http).emit("connection", socket);
    process.nextTick(() => socket.resume());
  });
}).listen(8317, () => console.log("fake-proxy: listening on 8317 (http + tls)"));
