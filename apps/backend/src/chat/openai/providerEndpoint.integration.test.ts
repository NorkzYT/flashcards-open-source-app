/**
 * Module-boundary test of the configurable OpenAI-compatible endpoint: the real chat loop and the real OpenAI
 * SDK stream a Responses API turn with one tool call from a synthetic loopback proxy. Nothing leaves 127.0.0.1:
 * a fetch guard refuses every other URL, and the key is synthetic.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type OpenAI from "openai";
import { startOpenAILoopWithDeps } from "./loop/loop";
import { buildChatCompletionInput, buildChatCompletionInputWithBudget } from "./loop/input";
import {
  collectEvents,
  createAssistantMessageItem,
  createDependencies,
  createParams,
  createResponse,
} from "./loop/loop.testSupport";
import { getOpenAIClient } from "./client";
import { OPENAI_DEFAULT_BASE_URL, readOpenAIProviderEndpoint } from "./providerEndpoint";

const SYNTHETIC_KEY = "sk-synthetic-proxy-client-key-0123456789";
const PROXY_MODEL = "synthetic-proxy-model";

type CapturedRequest = Readonly<{ path: string; authorization: string | null; body: Record<string, unknown> }>;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sse(events: ReadonlyArray<Record<string, unknown>>): string {
  return events.map((event, index) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("");
}

const toolCallItem = {
  type: "function_call",
  id: "fc-1",
  call_id: "call-proxy-1",
  name: "list_workspaces",
  arguments: "{}",
  status: "completed",
} as const;

function toolCallTurn(): string {
  const added = { ...toolCallItem, arguments: "", status: "in_progress" };
  const final = createResponse([toolCallItem as OpenAI.Responses.ResponseFunctionToolCall], undefined);
  return sse([
    { type: "response.created", response: { ...final, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: added },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-1", delta: "{}" },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc-1", arguments: "{}" },
    { type: "response.output_item.done", output_index: 0, item: toolCallItem },
    { type: "response.completed", response: final },
  ]);
}

function textTurn(): string {
  const message = createAssistantMessageItem("Proxy answer.");
  const final = createResponse([message], "Proxy answer.");
  return sse([
    { type: "response.created", response: { ...final, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: message.id, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: "Proxy ", logprobs: [] },
    { type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: "answer.", logprobs: [] },
    { type: "response.output_text.done", output_index: 0, item_id: message.id, content_index: 0, text: "Proxy answer.", logprobs: [] },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: final },
  ]);
}

async function startSyntheticProxy(requests: Array<CapturedRequest>): Promise<Readonly<{ server: Server; baseURL: string }>> {
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? null, body });
      if (request.url !== "/proxy-prefix/v1/responses" || request.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "synthetic proxy: unexpected path or key", type: "invalid_request_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(requests.length === 1 ? toolCallTurn() : textTurn());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseURL: `http://127.0.0.1:${String(port)}/proxy-prefix/v1/` };
}

test("a chat turn with a tool call streams through the configured proxy with the configured model only", async () => {
  const requests: Array<CapturedRequest> = [];
  const { server, baseURL } = await startSyntheticProxy(requests);
  const fetchedURLs: Array<string> = [];
  const originalFetch = globalThis.fetch;
  const output: Array<string> = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  process.env.NIBOMO_DEPLOYMENT = "standalone";
  process.env.OPENAI_API_KEY = SYNTHETIC_KEY;
  process.env.OPENAI_BASE_URL = baseURL;
  process.env.NIBOMO_OPENAI_MODEL = PROXY_MODEL;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchedURLs.push(url);
    if (!url.startsWith(baseURL.replace(/\/$/u, ""))) throw new Error(`egress refused by test guard: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;

  const toolCalls: Array<string> = [];
  const { sink, events } = collectEvents();
  let completion: Awaited<ReturnType<typeof startOpenAILoopWithDeps>>;
  try {
    completion = await startOpenAILoopWithDeps(createParams({}), sink, {
      ...createDependencies(() => {
        throw new Error("the stub client must not be used");
      }, async (params) => {
        toolCalls.push(`${params.item.name}:${params.item.call_id}:${params.item.arguments}`);
        return { output: "{\"workspaces\":[]}", isMutating: false, succeeded: true };
      }),
      getOpenAIClient,
      buildChatCompletionInput,
      buildChatCompletionInputWithBudget,
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(completion.terminationReason, "completed");
  assert.deepEqual(toolCalls, ["list_workspaces:call-proxy-1:{}"]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.path, "/proxy-prefix/v1/responses");
    assert.equal(request.authorization, `Bearer ${SYNTHETIC_KEY}`);
    assert.equal(request.body.model, PROXY_MODEL);
    assert.equal(request.body.stream, true);
  }
  const secondInput = requests[1]?.body.input as ReadonlyArray<Record<string, unknown>>;
  assert.ok(secondInput.some((item) => item.type === "function_call" && item.call_id === "call-proxy-1"));
  assert.ok(secondInput.some((item) => item.type === "function_call_output" && item.call_id === "call-proxy-1"));
  const deltas = events.flatMap((event) => {
    const record = event as Record<string, unknown>;
    return record.type === "delta" && typeof record.text === "string" ? [record.text] : [];
  });
  assert.equal(deltas.join(""), "Proxy answer.");
  assert.ok(fetchedURLs.length === 2 && fetchedURLs.every((url) => url.startsWith(baseURL.replace(/\/$/u, ""))));
  assert.equal(output.join("").includes(SYNTHETIC_KEY), false, "the proxy key must never be logged");
});

test("invalid endpoint settings are refused without echoing the value", () => {
  const standalone = { NIBOMO_DEPLOYMENT: "standalone" };
  for (const [value, message] of [
    ["http://user:sk-secret-in-url@proxy:8317/v1", /must not contain credentials/u],
    ["ftp://proxy/v1", /must use http or https/u],
    ["http://proxy:8317/v1?key=sk-secret-in-url", /query string or fragment/u],
    ["http://proxy:8317/v1#sk-secret-in-url", /query string or fragment/u],
    ["proxy:8317/v1", /must (use http or https|be an absolute)/u],
    ["not a url sk-secret-in-url", /must be an absolute/u],
  ] as const) {
    assert.throws(() => readOpenAIProviderEndpoint({ ...standalone, OPENAI_BASE_URL: value }), (error: Error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes("sk-secret-in-url"), false);
      return true;
    });
  }
  assert.throws(() => readOpenAIProviderEndpoint({ ...standalone, NIBOMO_OPENAI_MODEL: "bad model;rm" }), /NIBOMO_OPENAI_MODEL must be/u);
  assert.throws(() => readOpenAIProviderEndpoint({ NIBOMO_OPENAI_MODEL: PROXY_MODEL }), /only supported with NIBOMO_DEPLOYMENT=standalone/u);
  // AWS default: nothing set keeps api.openai.com and the built-in models.
  assert.deepEqual(readOpenAIProviderEndpoint({}), { baseURL: OPENAI_DEFAULT_BASE_URL, custom: false, modelOverride: null });
  assert.deepEqual(readOpenAIProviderEndpoint({ ...standalone, OPENAI_BASE_URL: "http://cliproxyapi:8317/v1/" }), {
    baseURL: "http://cliproxyapi:8317/v1", custom: true, modelOverride: null,
  });
});
