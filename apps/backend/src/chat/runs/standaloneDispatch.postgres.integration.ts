import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { applyWorkspaceDatabaseScopeInExecutor } from "../../database";
import { withPostgresIntegrationFixture } from "../../testSupport/postgresIntegration";
import { createStandaloneChatWorker, DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, type StandaloneChatWorkerConfig } from "../worker/standalone";
import type { handleChatWorkerEvent } from "../worker";
import { claimChatRun, prepareChatRun, requestChatRunCancellation } from "./lifecycleService";
import { leaseStandaloneChatRunDispatches } from "./standaloneDispatch";

type DispatchRow = Readonly<{ run_id: string; state: string; attempt_count: number; user_id: string }>;

const workerConfig: StandaloneChatWorkerConfig = {
  workerId: "pg-integration-worker",
  concurrency: 4,
  pollIntervalMs: 100,
  leaseDurationMs: 60_000,
  maxAttempts: 2,
  recoveryIntervalMs: 1_000,
  runTimeoutMs: 900_000,
  shutdownGraceMs: 0,
};

async function withDeployment<Result>(mode: string | undefined, callback: () => Promise<Result>): Promise<Result> {
  const previous = process.env.NIBOMO_DEPLOYMENT;
  if (mode === undefined) delete process.env.NIBOMO_DEPLOYMENT;
  else process.env.NIBOMO_DEPLOYMENT = mode;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.NIBOMO_DEPLOYMENT;
    else process.env.NIBOMO_DEPLOYMENT = previous;
  }
}

async function startTurn(userId: string, workspaceId: string, sessionId: string, requestId: string) {
  return prepareChatRun(
    userId, workspaceId, sessionId, [{ type: "text", text: "Make one card about photosynthesis." }],
    requestId, "UTC", null, true, null, null, null, async () => undefined,
  );
}

async function dispatchRows(owner: pg.Pool, runIds: ReadonlyArray<string>): Promise<ReadonlyArray<DispatchRow>> {
  return (await owner.query<DispatchRow>(
    "SELECT run_id, state, attempt_count, user_id FROM ai.chat_run_dispatches WHERE run_id = ANY($1::uuid[]) ORDER BY run_id",
    [runIds],
  )).rows;
}

async function runStatus(owner: pg.Pool, runId: string): Promise<string> {
  return (await owner.query<{ status: string }>("SELECT status FROM ai.chat_runs WHERE run_id = $1", [runId])).rows[0].status;
}

async function expireLease(owner: pg.Pool, runId: string, staleHeartbeat: boolean): Promise<void> {
  await owner.query(
    "UPDATE ai.chat_run_dispatches SET lease_expires_at = statement_timestamp() - interval '1 second' WHERE run_id = $1",
    [runId],
  );
  if (staleHeartbeat) {
    await owner.query("UPDATE ai.chat_runs SET worker_heartbeat_at = now() - interval '5 minutes' WHERE run_id = $1", [runId]);
    await owner.query(
      "UPDATE ai.chat_sessions SET active_run_heartbeat_at = now() - interval '5 minutes' WHERE active_run_id = $1",
      [runId],
    );
  }
}

test("standalone dispatch: atomic enqueue, least privilege, single claim, bounded redelivery, no replay", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const { userId, workspaceId } = fixture;
    const owner = fixture.ownerPool;
    const sessions = Array.from({ length: 6 }, () => randomUUID());
    const foreignUser = `pg-integration-foreign-${randomUUID()}`;
    try {
      // AWS mode (unset) is unchanged: no dispatch row.
      const awsRun = await withDeployment(undefined, () => startTurn(userId, workspaceId, sessions[0], randomUUID()));
      assert.deepEqual(await dispatchRows(owner, [awsRun.runId]), []);

      // Standalone: the row commits with the run; a replayed POST adds nothing.
      const requestId = randomUUID();
      const crashed = await withDeployment("standalone", () => startTurn(userId, workspaceId, sessions[1], requestId));
      const replay = await withDeployment("standalone", () => startTurn(userId, workspaceId, sessions[1], requestId));
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.runId, crashed.runId);
      assert.deepEqual(await dispatchRows(owner, [crashed.runId]), [
        { run_id: crashed.runId, state: "pending", attempt_count: 0, user_id: userId },
      ]);
      await assert.rejects(withDeployment("bogus", () => startTurn(userId, workspaceId, sessions[5], randomUUID())),
        /NIBOMO_DEPLOYMENT must be/);
      assert.equal((await owner.query("SELECT 1 FROM ai.chat_sessions WHERE session_id = $1", [sessions[5]])).rowCount, 0);

      // The runtime role can neither read nor change the queue, and cannot enqueue for someone else.
      const runtime = await fixture.runtimePool.connect();
      try {
        await assert.rejects(runtime.query("SELECT * FROM ai.chat_run_dispatches"), { code: "42501" });
        await assert.rejects(runtime.query("DELETE FROM ai.chat_run_dispatches"), { code: "42501" });
        await assert.rejects(runtime.query("UPDATE ai.chat_run_dispatches SET attempt_count = 0"), { code: "42501" });
        const awsRequestId = (await owner.query<{ request_id: string }>(
          "SELECT request_id FROM ai.chat_runs WHERE run_id = $1", [awsRun.runId],
        )).rows[0].request_id;
        for (const [forgedUser, forgedRequest] of [[foreignUser, awsRequestId], [userId, "forged-request"]]) {
          await runtime.query("BEGIN");
          await applyWorkspaceDatabaseScopeInExecutor(
            { query: (text, params) => runtime.query(text, [...params]) },
            { userId, workspaceId },
          );
          await assert.rejects(runtime.query(
            "INSERT INTO ai.chat_run_dispatches(run_id, session_id, user_id, workspace_id, chat_request_id) VALUES ($1,$2,$3,$4,$5)",
            [awsRun.runId, awsRun.sessionId, forgedUser, workspaceId, forgedRequest],
          ), { code: "42501" });
          await runtime.query("ROLLBACK");
        }
      } finally {
        await runtime.query("ROLLBACK").catch(() => undefined);
        runtime.release();
      }

      // Two concurrent leasers: exactly one gets the row.
      const [first, second] = await Promise.all([
        leaseStandaloneChatRunDispatches("leaser-a", 60_000, 10),
        leaseStandaloneChatRunDispatches("leaser-b", 60_000, 10),
      ]);
      assert.deepEqual([...first, ...second].map((row) => row.runId), [crashed.runId]);
      await owner.query(
        "UPDATE ai.chat_run_dispatches SET state='pending', lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, attempt_count=0 WHERE run_id=$1",
        [crashed.runId],
      );

      // Worker claims (queued_only), then dies after the provider may have been reached.
      let providerCalls = 0;
      const crashingHandler: typeof handleChatWorkerEvent = async (event, context) => {
        assert.equal(event.userOpenAIApiKey, null);
        assert.ok(typeof context.claimMode === "object" && context.claimMode.mode === "standalone_dispatch_lease");
        assert.equal(context.claimMode.lease.leaseOwner, workerConfig.workerId);
        const claimed = await claimChatRun(event.userId, event.workspaceId, event.runId, context.claimMode);
        if (claimed === null) return;
        providerCalls += 1;
        throw new Error("worker crashed after the provider call started");
      };
      const logs: Array<string> = [];
      const worker = createStandaloneChatWorker(workerConfig, {
        ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES,
        handleEvent: crashingHandler,
        log: (record) => logs.push(`${record.action}:${record.outcome ?? ""}`),
      });
      await Promise.all(await worker.pollOnce());
      assert.equal(providerCalls, 1);
      assert.equal(await runStatus(owner, crashed.runId), "running");
      // Even the Lambda's stale takeover is refused in queued_only mode.
      await expireLease(owner, crashed.runId, true);
      const crashedLease = (await owner.query<{ lease_token: string; lease_owner: string }>(
        "SELECT lease_token, lease_owner FROM ai.chat_run_dispatches WHERE run_id = $1", [crashed.runId],
      )).rows[0];
      assert.equal(await claimChatRun(userId, workspaceId, crashed.runId, {
        mode: "standalone_dispatch_lease",
        credentialKeyring: null, personalCredentialRequired: false,
        lease: {
          runId: crashed.runId, sessionId: crashed.sessionId, userId, workspaceId,
          leaseToken: crashedLease.lease_token, leaseOwner: crashedLease.lease_owner,
        },
      }), null);
      const recovered = await worker.recoverOnce();
      assert.deepEqual(recovered.map((row) => [row.runId, row.outcome]), [[crashed.runId, "ambiguous"]]);
      assert.equal(await runStatus(owner, crashed.runId), "interrupted");
      assert.deepEqual(await dispatchRows(owner, [crashed.runId]), []);
      assert.deepEqual(await worker.pollOnce(), []);
      assert.equal(providerCalls, 1);

      // A failure before the claim is delivered again, bounded by maxAttempts, then interrupted.
      const flaky = await withDeployment("standalone", () => startTurn(userId, workspaceId, sessions[2], randomUUID()));
      let preClaimFailures = 0;
      const failingWorker = createStandaloneChatWorker(workerConfig, {
        ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES,
        handleEvent: async () => {
          preClaimFailures += 1;
          throw new Error("database unavailable before claim");
        },
        log: () => undefined,
      });
      await Promise.all(await failingWorker.pollOnce());
      await expireLease(owner, flaky.runId, false);
      assert.deepEqual((await failingWorker.recoverOnce()).map((row) => row.outcome), ["requeued"]);
      assert.deepEqual(await dispatchRows(owner, [flaky.runId]), [
        { run_id: flaky.runId, state: "pending", attempt_count: 1, user_id: userId },
      ]);
      await Promise.all(await failingWorker.pollOnce());
      await expireLease(owner, flaky.runId, false);
      assert.deepEqual((await failingWorker.recoverOnce()).map((row) => row.outcome), ["exhausted"]);
      assert.equal(preClaimFailures, 2);
      assert.equal(await runStatus(owner, flaky.runId), "interrupted");
      assert.deepEqual(await dispatchRows(owner, [flaky.runId]), []);

      // Cancellation before the claim: the worker skips the run and drops the row.
      const cancelled = await withDeployment("standalone", () => startTurn(userId, workspaceId, sessions[3], randomUUID()));
      await requestChatRunCancellation(userId, workspaceId, cancelled.sessionId, cancelled.runId);
      const cancelWorker = createStandaloneChatWorker(workerConfig, {
        ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES,
        handleEvent: async (event, context) => {
          assert.equal(await claimChatRun(event.userId, event.workspaceId, event.runId, context.claimMode), null);
        },
        log: () => undefined,
      });
      await Promise.all(await cancelWorker.pollOnce());
      assert.equal(await runStatus(owner, cancelled.runId), "cancelled");
      assert.deepEqual(await dispatchRows(owner, [cancelled.runId]), []);

      // A healthy claimed run outlives its dispatch lease untouched; deleting the session cascades the row.
      const healthy = await withDeployment("standalone", () => startTurn(userId, workspaceId, sessions[4], randomUUID()));
      const [healthyLease] = await leaseStandaloneChatRunDispatches("leaser-c", 60_000, 1);
      assert.ok(await claimChatRun(userId, workspaceId, healthy.runId, {
        mode: "standalone_dispatch_lease",
        credentialKeyring: null, personalCredentialRequired: false,
        lease: {
          runId: healthy.runId, sessionId: healthy.sessionId, userId, workspaceId,
          leaseToken: healthyLease.leaseToken, leaseOwner: "leaser-c",
        },
      }));
      await expireLease(owner, healthy.runId, false);
      assert.deepEqual(await worker.recoverOnce(), []);
      assert.equal(await runStatus(owner, healthy.runId), "running");
      assert.equal((await dispatchRows(owner, [healthy.runId])).length, 1);
      await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = $1", [healthy.sessionId]);
      assert.deepEqual(await dispatchRows(owner, [healthy.runId]), []);
    } finally {
      await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = ANY($1::uuid[])", [sessions]);
    }
  });
});
