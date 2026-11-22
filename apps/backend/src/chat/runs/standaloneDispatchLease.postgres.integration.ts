import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { withPostgresIntegrationFixture } from "../../testSupport/postgresIntegration";
import { createStandaloneChatWorker, DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, type StandaloneChatWorkerConfig } from "../worker/standalone";
import type { handleChatWorkerEvent } from "../worker";
import { claimChatRun, interruptAbandonedStandaloneChatRun, prepareChatRun, type ChatRunClaimMode } from "./lifecycleService";
import {
  leaseStandaloneChatRunDispatches,
  recoverStandaloneChatRunDispatches,
  type StandaloneChatRunDispatchLease,
} from "./standaloneDispatch";

function config(workerId: string): StandaloneChatWorkerConfig {
  return {
    workerId,
    concurrency: 1,
    pollIntervalMs: 100,
    leaseDurationMs: 60_000,
    maxAttempts: 3,
    recoveryIntervalMs: 1_000,
    runTimeoutMs: 900_000,
    shutdownGraceMs: 0,
  };
}

function leaseClaim(lease: StandaloneChatRunDispatchLease): ChatRunClaimMode {
  return { mode: "standalone_dispatch_lease", lease, credentialKeyring: null, personalCredentialRequired: false };
}

async function startTurn(userId: string, workspaceId: string, sessionId: string) {
  const previous = process.env.NIBOMO_DEPLOYMENT;
  process.env.NIBOMO_DEPLOYMENT = "standalone";
  try {
    return await prepareChatRun(
      userId, workspaceId, sessionId, [{ type: "text", text: "Make one card about osmosis." }],
      randomUUID(), "UTC", null, true, null, null, null, async () => undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.NIBOMO_DEPLOYMENT;
    else process.env.NIBOMO_DEPLOYMENT = previous;
  }
}

async function runStatus(owner: pg.Pool, runId: string): Promise<string> {
  return (await owner.query<{ status: string }>("SELECT status FROM ai.chat_runs WHERE run_id = $1", [runId])).rows[0].status;
}

async function expireLease(owner: pg.Pool | pg.PoolClient, runId: string): Promise<void> {
  await owner.query(
    "UPDATE ai.chat_run_dispatches SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1",
    [runId],
  );
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("standalone dispatch lease fence: only the exact current holder claims or interrupts", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const { userId, workspaceId } = fixture;
    const owner = fixture.ownerPool;
    const sessions = Array.from({ length: 4 }, () => randomUUID());
    try {
      // 1. Exact-field fence, checked by the SQL function itself through the runtime role.
      const exact = await startTurn(userId, workspaceId, sessions[0]);
      const [leased] = await leaseStandaloneChatRunDispatches("worker-exact", 60_000, 1);
      assert.equal(leased.runId, exact.runId);
      const held: StandaloneChatRunDispatchLease = {
        runId: exact.runId, sessionId: exact.sessionId, userId, workspaceId,
        leaseToken: leased.leaseToken, leaseOwner: "worker-exact",
      };
      const assertLease = async (lease: StandaloneChatRunDispatchLease): Promise<boolean> =>
        (await fixture.runtimePool.query<{ held: boolean }>(
          "SELECT ai.assert_chat_run_dispatch_lease($1, $2, $3, $4, $5, $6) AS held",
          [lease.runId, lease.sessionId, lease.userId, lease.workspaceId, lease.leaseToken, lease.leaseOwner],
        )).rows[0].held;
      assert.equal(await assertLease(held), true);
      for (const forged of [
        { ...held, leaseToken: randomUUID() },
        { ...held, leaseOwner: "worker-other" },
        { ...held, sessionId: randomUUID() },
        { ...held, userId: `${userId}-other` },
        { ...held, workspaceId: randomUUID() },
        { ...held, runId: randomUUID() },
      ]) {
        assert.equal(await assertLease(forged), false, JSON.stringify(forged));
      }
      await expireLease(owner, exact.runId);
      assert.equal(await assertLease(held), false, "an expired lease is not held");
      assert.equal(await claimChatRun(userId, workspaceId, exact.runId, leaseClaim(held)), null);
      assert.equal(await runStatus(owner, exact.runId), "queued");
      await assert.rejects(
        claimChatRun(userId, workspaceId, exact.runId, leaseClaim({ ...held, runId: randomUUID() })),
        /does not match the run/,
      );
      // The runtime role still cannot read the queue directly.
      await assert.rejects(fixture.runtimePool.query("SELECT lease_token FROM ai.chat_run_dispatches"), { code: "42501" });
      await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = $1", [sessions[0]]);

      // 2. Two workers, one run: A's lease expires mid-flight and the run is redelivered to B. A (stale)
      //    claims nothing; B claims and reaches the "provider" exactly once.
      const contested = await startTurn(userId, workspaceId, sessions[1]);
      const providerCalls: Array<string> = [];
      const aReady = deferred();
      const aGo = deferred();
      const handlerFor = (name: string, gate: boolean): typeof handleChatWorkerEvent => async (event, context) => {
        if (gate) {
          aReady.resolve();
          await aGo.promise;
        }
        const claimed = await claimChatRun(event.userId, event.workspaceId, event.runId, context.claimMode);
        if (claimed !== null) providerCalls.push(name);
      };
      const workerA = createStandaloneChatWorker(config("worker-a"), {
        ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, handleEvent: handlerFor("a", true), log: () => undefined,
      });
      const workerB = createStandaloneChatWorker(config("worker-b"), {
        ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, handleEvent: handlerFor("b", false), log: () => undefined,
      });
      const aRuns = await workerA.pollOnce();
      assert.equal(aRuns.length, 1);
      await aReady.promise;
      await expireLease(owner, contested.runId);
      assert.deepEqual((await workerB.recoverOnce()).map((row) => [row.runId, row.outcome]), [[contested.runId, "requeued"]]);
      await Promise.all(await workerB.pollOnce());
      assert.deepEqual(providerCalls, ["b"]);
      aGo.resolve();
      await Promise.all(aRuns);
      assert.deepEqual(providerCalls, ["b"], "the stale holder never claims");
      assert.equal(await runStatus(owner, contested.runId), "running");
      // A's completion uses its own token and removes nothing that B holds.
      const remaining = (await owner.query<{ lease_owner: string }>(
        "SELECT lease_owner FROM ai.chat_run_dispatches WHERE run_id = $1", [contested.runId],
      )).rows;
      assert.deepEqual(remaining, []);

      // 3. Recovery fence: a recoverer whose re-lease was taken over interrupts nothing.
      const abandoned = await startTurn(userId, workspaceId, sessions[2]);
      await leaseStandaloneChatRunDispatches("worker-dead", 60_000, 1);
      await expireLease(owner, abandoned.runId);
      const recoverParams = { maxAttempts: 1, staleHeartbeatMs: 30_000, leaseDurationMs: 60_000, limit: 10 };
      const [first] = await recoverStandaloneChatRunDispatches({ ...recoverParams, leaseOwner: "recoverer-1" });
      assert.equal(first.outcome, "exhausted");
      await expireLease(owner, abandoned.runId);
      const [second] = await recoverStandaloneChatRunDispatches({ ...recoverParams, leaseOwner: "recoverer-2" });
      assert.equal(second.outcome, "exhausted");
      const base = { runId: abandoned.runId, sessionId: abandoned.sessionId, userId, workspaceId };
      assert.deepEqual(
        await interruptAbandonedStandaloneChatRun({ ...base, leaseToken: first.leaseToken as string, leaseOwner: "recoverer-1" }),
        { leaseHeld: false, foundStatus: null, interrupted: false },
      );
      assert.equal(await runStatus(owner, abandoned.runId), "queued");
      assert.deepEqual(
        await interruptAbandonedStandaloneChatRun({ ...base, leaseToken: second.leaseToken as string, leaseOwner: "recoverer-1" }),
        { leaseHeld: false, foundStatus: null, interrupted: false },
        "the right token under the wrong owner is not the lease",
      );
      assert.deepEqual(
        await interruptAbandonedStandaloneChatRun({ ...base, leaseToken: second.leaseToken as string, leaseOwner: "recoverer-2" }),
        { leaseHeld: true, foundStatus: "queued", interrupted: true },
      );
      assert.equal(await runStatus(owner, abandoned.runId), "interrupted");

      // 4. Lock order and expiry at lock time: while a holder has the dispatch row locked, the sweep skips
      //    it; a claim that waited on the lock past its expiry claims nothing.
      const raced = await startTurn(userId, workspaceId, sessions[3]);
      const [racedLease] = await leaseStandaloneChatRunDispatches("worker-raced", 60_000, 1);
      const blocker = await owner.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT 1 FROM ai.chat_run_dispatches WHERE run_id = $1 FOR UPDATE", [raced.runId]);
        const pendingClaim = claimChatRun(userId, workspaceId, raced.runId, leaseClaim({
          runId: raced.runId, sessionId: raced.sessionId, userId, workspaceId,
          leaseToken: racedLease.leaseToken, leaseOwner: "worker-raced",
        }));
        await expireLease(blocker, raced.runId);
        // The claim is now waiting on the dispatch row lock; the sweep must not see the row.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const waiting = (await owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%assert_chat_run_dispatch_lease%'",
          )).rows[0].n;
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(
          (await recoverStandaloneChatRunDispatches({ ...recoverParams, leaseOwner: "recoverer-3" })).map((row) => row.runId)
            .filter((runId) => runId === raced.runId),
          [],
        );
        await blocker.query("COMMIT");
        assert.equal(await pendingClaim, null);
        assert.equal(await runStatus(owner, raced.runId), "queued");
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    } finally {
      await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = ANY($1::uuid[])", [sessions]);
    }
  });
});
