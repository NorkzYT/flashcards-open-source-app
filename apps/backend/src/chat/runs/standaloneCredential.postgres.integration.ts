import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type pg from "pg";
import { withPostgresIntegrationFixture } from "../../testSupport/postgresIntegration";
import { createStandaloneChatWorker, DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, type StandaloneChatWorkerConfig } from "../worker/standalone";
import type { handleChatWorkerEvent } from "../worker";
import { UserOpenAIApiKey } from "../userOpenAIApiKey";
import { claimChatRun, prepareChatRun } from "./lifecycleService";
import {
  readStandaloneCredentialKeyring,
  sealStandaloneCredential,
  type StandaloneCredentialKeyring,
} from "./standaloneCredential";
import { leaseStandaloneChatRunDispatches } from "./standaloneDispatch";
import { loadAiUsageStatus } from "../../aiUsage";

// Synthetic only: a random placeholder, never a real provider key.
const syntheticKey = `sk-synthetic-${randomUUID()}`;

function keyringFor(directory: string, instanceId: string): StandaloneCredentialKeyring {
  const path = join(directory, `key-${randomUUID()}`);
  writeFileSync(path, randomBytes(48), { mode: 0o600 });
  const keyring = readStandaloneCredentialKeyring({ NIBOMO_CHAT_CREDENTIAL_KEY_FILE: path, NIBOMO_INSTANCE_ID: instanceId });
  assert.ok(keyring !== null);
  return keyring;
}

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

async function startKeyedTurn(
  userId: string, workspaceId: string, sessionId: string, keyring: StandaloneCredentialKeyring, mode = "standalone",
) {
  return withDeployment(mode, () => prepareChatRun(
    userId, workspaceId, sessionId, [{ type: "text", text: "Make one card about diffusion." }],
    randomUUID(), "UTC", null, true, null, null, null, async () => undefined, null, undefined, undefined,
    (binding) => sealStandaloneCredential(keyring, binding, new UserOpenAIApiKey(syntheticKey), new Date()),
  ));
}

async function runStatus(owner: pg.Pool, runId: string): Promise<string> {
  return (await owner.query<{ status: string }>("SELECT status FROM ai.chat_runs WHERE run_id = $1", [runId])).rows[0].status;
}

async function credentialCount(owner: pg.Pool, runId: string): Promise<number> {
  return (await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ai.chat_run_dispatch_credentials WHERE run_id = $1", [runId],
  )).rows[0].n;
}

/** Every row of every table in the chat/AI schemas, as text and raw bytes, searched for the plaintext. */
async function plaintextPersisted(owner: pg.Pool): Promise<ReadonlyArray<string>> {
  const tables = (await owner.query<{ name: string }>(
    "SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('ai', 'public', 'security')",
  )).rows.map((row) => row.name);
  const hits: Array<string> = [];
  for (const table of tables) {
    const found = (await owner.query<{ hit: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} AS t WHERE strpos(row_to_json(t)::text, $1) > 0) AS hit`, [syntheticKey],
    )).rows[0].hit;
    if (found) hits.push(table);
  }
  const inCiphertext = (await owner.query<{ hit: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM ai.chat_run_dispatch_credentials WHERE position(convert_to($1, 'UTF8') IN ciphertext) > 0) AS hit",
    [syntheticKey],
  )).rows[0].hit;
  if (inCiphertext) hits.push("ciphertext");
  return hits;
}

function config(workerId: string, keyring: StandaloneCredentialKeyring | null): StandaloneChatWorkerConfig {
  return {
    workerId, concurrency: 1, pollIntervalMs: 100, leaseDurationMs: 60_000, maxAttempts: 3,
    recoveryIntervalMs: 1_000, runTimeoutMs: 900_000, shutdownGraceMs: 0, credentialKeyring: keyring,
  };
}

test("standalone personal key: sealed, lease-bound, single-use, expiring, never persisted or logged in clear", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "nibomo-credential-test-"));
  try {
    await withPostgresIntegrationFixture(async (fixture) => {
      const { userId, workspaceId } = fixture;
      const owner = fixture.ownerPool;
      const keyring = keyringFor(directory, "pg-integration-instance");
      const sessions = Array.from({ length: 7 }, () => randomUUID());
      const logs: Array<string> = [];
      const opened: Array<string> = [];
      const handler: typeof handleChatWorkerEvent = async (event, context) => {
        assert.equal(event.userOpenAIApiKey, null, "the dispatch event never carries the key");
        const claimed = await claimChatRun(event.userId, event.workspaceId, event.runId, context.claimMode);
        if (claimed?.userOpenAIApiKey) opened.push(claimed.userOpenAIApiKey.revealRawValue());
        logs.push(JSON.stringify(claimed));
      };
      const worker = (workerKeyring: StandaloneCredentialKeyring | null) => createStandaloneChatWorker(
        config("credential-worker", workerKeyring),
        { ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, handleEvent: handler, log: (record) => logs.push(JSON.stringify(record)) },
      );
      try {
        // AWS mode never persists a key.
        await assert.rejects(startKeyedTurn(userId, workspaceId, sessions[0], keyring, "aws"), /only for standalone/);

        // Sealed at enqueue: ciphertext only, runtime role cannot read it, plaintext nowhere in the database.
        const happy = await startKeyedTurn(userId, workspaceId, sessions[1], keyring);
        assert.equal(await credentialCount(owner, happy.runId), 1);
        assert.deepEqual(await plaintextPersisted(owner), []);
        await assert.rejects(fixture.runtimePool.query("SELECT * FROM ai.chat_run_dispatch_credentials"), { code: "42501" });
        await assert.rejects(fixture.runtimePool.query(
          "SELECT * FROM ai.take_chat_run_dispatch_credential($1, $2, $3, $4, $5, $6)",
          [happy.runId, happy.sessionId, userId, workspaceId, randomUUID(), "credential-worker"],
        ), { code: "55000" });

        // A forged lease claims nothing and receives nothing; the sealed row stays for the real holder.
        const [lease] = await leaseStandaloneChatRunDispatches("credential-worker", 60_000, 1);
        assert.equal(lease.runId, happy.runId);
        const forged = await claimChatRun(userId, workspaceId, happy.runId, {
          mode: "standalone_dispatch_lease", credentialKeyring: keyring, personalCredentialRequired: false,
          lease: { runId: happy.runId, sessionId: happy.sessionId, userId, workspaceId, leaseToken: randomUUID(), leaseOwner: "credential-worker" },
        });
        assert.equal(forged, null);
        assert.equal(await credentialCount(owner, happy.runId), 1);
        // The exact holder opens it once; taking deletes it.
        const claimed = await claimChatRun(userId, workspaceId, happy.runId, {
          mode: "standalone_dispatch_lease", credentialKeyring: keyring, personalCredentialRequired: false,
          lease: { runId: happy.runId, sessionId: happy.sessionId, userId, workspaceId, leaseToken: lease.leaseToken, leaseOwner: "credential-worker" },
        });
        assert.equal(claimed?.userOpenAIApiKey?.revealRawValue(), syntheticKey);
        assert.equal(JSON.stringify(claimed).includes(syntheticKey), false, "serialized claim is redacted");
        assert.equal(await credentialCount(owner, happy.runId), 0);

        // Through the worker loop: opened in memory, absent from logs.
        const looped = await startKeyedTurn(userId, workspaceId, sessions[2], keyring);
        await Promise.all(await worker(keyring).pollOnce());
        assert.deepEqual(opened, [syntheticKey]);
        assert.equal(await runStatus(owner, looped.runId), "running");
        assert.equal(await credentialCount(owner, looped.runId), 0);

        // Worker without the key setting: fail closed, interrupted, no operator-key fallback.
        const noKey = await startKeyedTurn(userId, workspaceId, sessions[3], keyring);
        await Promise.all(await worker(null).pollOnce());
        assert.equal(opened.length, 1);
        assert.equal(await runStatus(owner, noKey.runId), "interrupted");
        assert.equal(await credentialCount(owner, noKey.runId), 0);

        // Different instance (different derived key): fail closed.
        const otherInstance = await startKeyedTurn(userId, workspaceId, sessions[4], keyring);
        await Promise.all(await worker(keyringFor(directory, "another-instance")).pollOnce());
        assert.equal(opened.length, 1);
        assert.equal(await runStatus(owner, otherInstance.runId), "interrupted");

        // Expiry moved in the database (AAD-bound): authentication fails, fail closed.
        const tampered = await startKeyedTurn(userId, workspaceId, sessions[5], keyring);
        await owner.query(
          "UPDATE ai.chat_run_dispatch_credentials SET expires_at = expires_at + interval '1 minute' WHERE run_id = $1",
          [tampered.runId],
        );
        await Promise.all(await worker(keyring).pollOnce());
        assert.equal(opened.length, 1);
        assert.equal(await runStatus(owner, tampered.runId), "interrupted");

        // Expired before any claim: recovery purges it; the later claim interrupts the run.
        const expired = await startKeyedTurn(userId, workspaceId, sessions[6], keyring);
        await owner.query(
          `UPDATE ai.chat_run_dispatch_credentials
           SET created_at = clock_timestamp() - interval '10 minutes', expires_at = clock_timestamp() - interval '1 minute'
           WHERE run_id = $1`,
          [expired.runId],
        );
        const sweeper = worker(keyring);
        await sweeper.recoverOnce();
        assert.equal(await credentialCount(owner, expired.runId), 0);
        assert.ok(logs.some((line) => line.includes("chat_worker_credentials_purged")));
        await Promise.all(await sweeper.pollOnce());
        assert.equal(opened.length, 1);
        assert.equal(await runStatus(owner, expired.runId), "interrupted");

        assert.deepEqual(await plaintextPersisted(owner), []);
        assert.equal(logs.some((line) => line.includes(syntheticKey)), false, "no captured log holds the key");
      } finally {
        await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = ANY($1::uuid[])", [sessions]);
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withEnv<Result>(values: Readonly<Record<string, string | undefined>>, callback: () => Promise<Result>): Promise<Result> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("standalone user-key funding: sealed turn runs on the personal key, keyless run ends before the provider, usage reports no operator allowance", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "nibomo-user-key-test-"));
  try {
    await withPostgresIntegrationFixture(async (fixture) => {
      const { userId, workspaceId } = fixture;
      const owner = fixture.ownerPool;
      const keyring = keyringFor(directory, "pg-user-key-instance");
      const sessions = [randomUUID(), randomUUID(), randomUUID()];
      const logs: Array<string> = [];
      const claimedRuns: Array<Readonly<{ runId: string; key: string | null }>> = [];
      // Stands in for the provider: anything claimed would be executed, so a claim is a provider call.
      const handler: typeof handleChatWorkerEvent = async (event, context) => {
        const claimed = await claimChatRun(event.userId, event.workspaceId, event.runId, context.claimMode);
        if (claimed !== null) claimedRuns.push({ runId: claimed.runId, key: claimed.userOpenAIApiKey?.revealRawValue() ?? null });
        logs.push(JSON.stringify(claimed));
      };
      const userKeyWorker = createStandaloneChatWorker(
        { ...config("user-key-worker", keyring), personalCredentialRequired: true },
        { ...DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES, handleEvent: handler, log: (record) => logs.push(JSON.stringify(record)) },
      );
      try {
        await withEnv({ OPENAI_API_KEY: undefined, NIBOMO_STANDALONE_AI_FUNDING: "user-key" }, async () => {
          // A keyless run already in the queue (e.g. from before the switch): interrupted with a reason the
          // person can act on, never claimed, so nothing reaches any provider and no key is borrowed.
          const keyless = await withDeployment("standalone", () => prepareChatRun(
            userId, workspaceId, sessions[0], [{ type: "text", text: "Make one card about osmosis." }],
            randomUUID(), "UTC", null, true, null, null, null, async () => undefined, null, undefined, undefined,
          ));
          await Promise.all(await userKeyWorker.pollOnce());
          assert.deepEqual(claimedRuns, []);
          const keylessRow = (await owner.query<{ status: string; last_error_message: string | null }>(
            "SELECT status, last_error_message FROM ai.chat_runs WHERE run_id = $1", [keyless.runId],
          )).rows[0];
          assert.equal(keylessRow.status, "interrupted");
          assert.match(keylessRow.last_error_message ?? "", /only with your own OpenAI API key/);

          // A sealed personal-key turn is claimed with exactly that key in memory.
          const keyed = await startKeyedTurn(userId, workspaceId, sessions[1], keyring);
          await Promise.all(await userKeyWorker.pollOnce());
          assert.deepEqual(claimedRuns, [{ runId: keyed.runId, key: syntheticKey }]);
          assert.equal(await runStatus(owner, keyed.runId), "running");
          assert.equal(await credentialCount(owner, keyed.runId), 0);

          // A sealed turn whose credential is gone when claimed: interrupted, still no fallback.
          const lost = await startKeyedTurn(userId, workspaceId, sessions[2], keyring);
          await owner.query("DELETE FROM ai.chat_run_dispatch_credentials WHERE run_id = $1", [lost.runId]);
          await Promise.all(await userKeyWorker.pollOnce());
          assert.equal(claimedRuns.length, 1);
          assert.equal(await runStatus(owner, lost.runId), "interrupted");

          // Usage status: no operator-funded messages exist on this server.
          const status = await withDeployment("standalone", () => loadAiUsageStatus(userId, "account", new Date()));
          assert.equal(status.usage.remainingMessages, 0);
        });

        // Operator funding (unchanged default) reports the operator's own monthly allowance, not the hosted tier's.
        await withEnv({ NIBOMO_STANDALONE_AI_FUNDING: undefined, NIBOMO_STANDALONE_AI_MONTHLY_MESSAGES: "7" }, async () => {
          const status = await withDeployment("standalone", () => loadAiUsageStatus(userId, "account", new Date()));
          assert.equal(status.usage.remainingMessages, Math.max(0, 7 - status.usage.usedMessages));
        });

        assert.deepEqual(await plaintextPersisted(owner), []);
        assert.equal(logs.some((line) => line.includes(syntheticKey)), false, "no captured log holds the key");
      } finally {
        await owner.query("DELETE FROM ai.chat_sessions WHERE session_id = ANY($1::uuid[])", [sessions]);
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
