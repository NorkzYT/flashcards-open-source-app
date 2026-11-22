// Pure check of the worker-log oracle: the worker writes `console.log({ domain: "chat_worker", ... })`,
// which Node prints in inspect format (multi-line once long), not JSON.
//   node --test infra/selfhost/ai-acceptance.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "node:util";
import { currentWorkerRecords, parseSseFrames, parseWorkerRecords } from "./ai-acceptance.mjs";

const line = (record) => format(record);
const config = (workerId) => ({
  domain: "chat_worker", action: "chat_worker_config", workerId, concurrency: 2, pollIntervalMs: 1000,
  leaseDurationMs: 60000, maxAttempts: 3, runTimeoutMs: 900000, aiFunding: "user-key", aiMonthlyMessagesPerPerson: null,
  sandbox: "disabled", personalOpenAIKeys: "sealed", instanceId: "nibomo-0123",
});

test("parses inspect-format worker records and keeps only the newest process", () => {
  const runId = "6f1c2c8e-0000-4000-8000-000000000001";
  const text = [
    line(config("a1b2c3:7:0000aaaa")),
    line({ domain: "chat_worker", action: "chat_worker_dispatch_leased", runId, attemptCount: 1 }),
    "some unrelated backend line",
    line(config("a1b2c3:7:1111bbbb")),
    line({ domain: "chat_worker", action: "chat_worker_dispatch_recovered", runId, sessionId: "s", workspaceId: "w",
      chatRequestId: "r", attemptCount: 1, outcome: "ambiguous", runStatus: "interrupted" }),
  ].join("\n");
  assert.ok(text.includes("\n  domain: 'chat_worker'"), "fixture is the multi-line inspect format");
  const all = parseWorkerRecords(text);
  assert.equal(all.length, 4);
  const current = currentWorkerRecords(all);
  assert.deepEqual([current[0].workerId, current[0].aiFunding, current[0].personalOpenAIKeys], ["a1b2c3:7:1111bbbb", "user-key", "sealed"]);
  assert.deepEqual([current[1].runId, current[1].runStatus, current[1].outcome], [runId, "interrupted", "ambiguous"]);
});

test("also accepts JSON-encoded records", () => {
  const records = parseWorkerRecords(JSON.stringify(config("x:1:2")));
  assert.equal(records[0].workerId, "x:1:2");
  assert.equal(records[0].aiFunding, "user-key");
});

test("parses live SSE frames across chunk boundaries, skipping keepalive comments", () => {
  const first = parseSseFrames(': keepalive\n\nevent: assistant_delta\ndata: {"type":"assistant_delta","text":"a"}\n\nevent: run_ter');
  assert.deepEqual(first.events, [{ type: "assistant_delta", text: "a" }]);
  const second = parseSseFrames(`${first.rest}minal\ndata: {"type":"run_terminal","outcome":"completed"}\n\n`);
  assert.deepEqual(second.events, [{ type: "run_terminal", outcome: "completed" }]);
  assert.equal(second.rest, "");
  assert.throws(() => parseSseFrames('event: run_terminal\ndata: {"type":"assistant_delta"}\n\n'), /mismatch/);
});
