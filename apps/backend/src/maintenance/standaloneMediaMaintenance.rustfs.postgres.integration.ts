/**
 * Standalone media maintenance against a real, isolated RustFS 1.0.6 store and the real PostgreSQL
 * cleanup fences. Explicit-only: run through the PostgreSQL integration runner with
 * POSTGRES_INTEGRATION_RUSTFS=1 and RUSTFS_IT_* set; it creates one uniquely named bucket and only
 * writes synthetic objects into it.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { transactionWithWorkspaceScope } from "../database";
import { withSessionAdvisoryLock, SessionAdvisoryLockTimeoutError } from "../database/sessionAdvisoryLock";
import {
  withPostgresIntegrationFixture,
  type PostgresIntegrationFixture,
} from "../testSupport/postgresIntegration";
import {
  failMediaBlobWriterInExecutor,
  reserveMediaBlobWriterInExecutor,
} from "../mediaAssets/blobLifecycle";
import { buildMediaBlobStorageKey } from "../mediaAssets/storageKeys";
import { imageJpegCardMediaBlobNormalizationVersion } from "../mediaAssets/types";
import {
  generatedMediaScheduledWorkloadDependencies,
  runGeneratedMediaScheduledWorkloads,
} from "../entrypoints/scheduledJobs/lambda-generated-media-promotion";
import { runMultipartCompletionScheduledWorkloads } from "../entrypoints/scheduledJobs/lambda-multipart-completion-reconciliation";
import {
  defaultWait,
  maintenanceLockHeld,
  runStandaloneMediaMaintenanceCycle,
  standaloneMediaMaintenanceLockAcquireTimeoutMs,
  standaloneMediaMaintenanceLockKey,
  standaloneMediaMaintenanceLockPollIntervalMs,
  type StandaloneMediaMaintenanceConfig,
  type StandaloneMediaMaintenanceDependencies,
} from "./standaloneMediaMaintenance";

function requiredTestEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the standalone media maintenance integration.`);
  }
  return value;
}

const privateEndpoint = requiredTestEnv("RUSTFS_IT_ENDPOINT");
const accessKeyId = requiredTestEnv("RUSTFS_IT_ACCESS_KEY_ID");
const secretAccessKey = requiredTestEnv("RUSTFS_IT_SECRET_ACCESS_KEY");
const bucketName = `nibomo-maint-it-${randomUUID()}`;
const region = "us-east-1";
/** Applied only for this test's duration: other RustFS files share the process and read env per call. */
const storageEnv: Readonly<Record<string, string>> = {
  MEDIA_ASSETS_STORAGE_PROFILE: "rustfs",
  MEDIA_ASSETS_S3_BUCKET_NAME: bucketName,
  MEDIA_ASSETS_S3_ENDPOINT: privateEndpoint,
  MEDIA_ASSETS_S3_PUBLIC_ENDPOINT: requiredTestEnv("RUSTFS_IT_PUBLIC_ENDPOINT"),
  MEDIA_ASSETS_S3_REGION: region,
  MEDIA_ASSETS_S3_ACCESS_KEY_ID: accessKeyId,
  MEDIA_ASSETS_S3_SECRET_ACCESS_KEY: secretAccessKey,
};

async function withStorageEnv(body: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(storageEnv).map((name) => [name, process.env[name]]));
  Object.assign(process.env, storageEnv);
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const raw = new S3Client({
  endpoint: privateEndpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const config: StandaloneMediaMaintenanceConfig = {
  workerId: "maintenance-it",
  intervalMs: 10_000,
  cycleBudgetMs: 30_000,
  shutdownGraceMs: 5_000,
  cleanupEnabled: true,
};

/** The production wiring of entrypoints/media-maintenance-node.ts, minus process concerns. */
const dependencies: StandaloneMediaMaintenanceDependencies = {
  runMediaFn: (input) => runGeneratedMediaScheduledWorkloads(input, generatedMediaScheduledWorkloadDependencies),
  runMultipartFn: runMultipartCompletionScheduledWorkloads,
  withExclusiveLockFn: async (signal, callback) => {
    try {
      return await withSessionAdvisoryLock({
        lockName: "standalone-media-maintenance",
        lockKey: standaloneMediaMaintenanceLockKey,
        timeoutMs: standaloneMediaMaintenanceLockAcquireTimeoutMs,
        pollIntervalMs: standaloneMediaMaintenanceLockPollIntervalMs,
        signal,
      }, callback);
    } catch (error) {
      if (error instanceof SessionAdvisoryLockTimeoutError) return maintenanceLockHeld;
      throw error;
    }
  },
  nowFn: Date.now,
  createCycleIdFn: randomUUID,
  waitFn: defaultWait,
  log: () => undefined,
};

type Blob = Readonly<{ sha256: string; storageKey: string; bytes: Buffer; blobId: string }>;

async function putObject(key: string, bytes: Buffer, contentType: string): Promise<void> {
  await raw.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: bytes, ContentType: contentType }));
}

async function objectBytesOrNull(key: string): Promise<number | null> {
  try {
    const head = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return head.ContentLength ?? -1;
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return null;
    throw error;
  }
}

/** A blob whose only writer failed: the lifecycle schedules it for cleanup (same path as production). */
async function createCleanupCandidateBlob(fixture: PostgresIntegrationFixture): Promise<Blob> {
  const bytes = randomBytes(42);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = buildMediaBlobStorageKey(sha256);
  const mediaAssetId = randomUUID();
  const reservation = await transactionWithWorkspaceScope(
    { userId: fixture.userId, workspaceId: fixture.workspaceId },
    (executor) => reserveMediaBlobWriterInExecutor(executor, {
      writerKind: "direct_ingestion", workspaceId: fixture.workspaceId, mediaAssetId,
      operationId: `maint-it-${randomUUID()}`, sha256, storageKey, mimeType: "image/jpeg",
      sizeBytes: bytes.length, normalizationVersion: imageJpegCardMediaBlobNormalizationVersion,
    }),
  );
  const blobId = randomUUID();
  await fixture.ownerPool.query(
    `INSERT INTO content.media_blobs
       (media_blob_id, sha256, mime_type, size_bytes, storage_key, normalization_version)
     VALUES ($1, $2, 'image/jpeg', $3, $4, $5)`,
    [blobId, sha256, bytes.length, storageKey, imageJpegCardMediaBlobNormalizationVersion],
  );
  await transactionWithWorkspaceScope(
    { userId: fixture.userId, workspaceId: fixture.workspaceId },
    (executor) => failMediaBlobWriterInExecutor(executor, reservation.reservationToken),
  );
  await putObject(storageKey, bytes, "image/jpeg");
  return { sha256, storageKey, bytes, blobId };
}

async function setEligibility(fixture: PostgresIntegrationFixture, sha256: string, sql: string): Promise<void> {
  await fixture.ownerPool.query(
    `UPDATE content.media_blob_lifecycles SET cleanup_eligible_at = ${sql} WHERE sha256 = $1`,
    [sha256],
  );
}

/** Cleanup never removes `content.media_blobs`; it records a completed attempt and clears eligibility. */
async function cleanupState(
  fixture: PostgresIntegrationFixture,
  sha256: string,
): Promise<Readonly<{ completedAttempts: number; eligible: boolean }>> {
  const result = await fixture.ownerPool.query<{ completed_attempts: number; eligible: boolean }>(
    `SELECT
       (SELECT count(*)::int FROM content.media_blob_cleanup_attempts
        WHERE sha256 = $1 AND state = 'completed') AS completed_attempts,
       (SELECT cleanup_eligible_at IS NOT NULL FROM content.media_blob_lifecycles WHERE sha256 = $1) AS eligible`,
    [sha256],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No cleanup state for ${sha256}`);
  return { completedAttempts: row.completed_attempts, eligible: row.eligible };
}

test("standalone maintenance deletes only expired unreferenced media and released chat files, one cycle at a time", async () => {
  await raw.send(new CreateBucketCommand({ Bucket: bucketName }));
  await withStorageEnv(() => withPostgresIntegrationFixture(async (fixture) => {
    const expired = await createCleanupCandidateBlob(fixture);
    await setEligibility(fixture, expired.sha256, "clock_timestamp() - interval '1 second'");

    // Referenced by a live media asset, then marked eligible again: only the reference fence protects it.
    const referenced = await createCleanupCandidateBlob(fixture);
    await fixture.ownerPool.query(
      `INSERT INTO content.media_assets
         (media_asset_id, workspace_id, media_blob_id, source_url, created_at,
          client_updated_at, last_modified_by_replica_id, last_operation_id)
       VALUES ($1, $2, $3, NULL, $4, $4, $5, $6)`,
      [randomUUID(), fixture.workspaceId, referenced.blobId, fixture.createdAt,
        fixture.replicaId, `maint-it-ref-${randomUUID()}`],
    );
    await setEligibility(fixture, referenced.sha256, "clock_timestamp() - interval '1 second'");

    // Unreferenced but its grace period has not expired.
    const notYetDue = await createCleanupCandidateBlob(fixture);
    await setEligibility(fixture, notYetDue.sha256, "clock_timestamp() + interval '1 hour'");

    const releasedChatKey = `chat-files/maint-it/${randomUUID()}.txt`;
    const liveChatKey = `chat-files/maint-it/${randomUUID()}.txt`;
    await putObject(releasedChatKey, Buffer.from("released"), "text/plain");
    await putObject(liveChatKey, Buffer.from("live"), "text/plain");
    await fixture.ownerPool.query("INSERT INTO ai.chat_file_deletions (s3_key) VALUES ($1)", [releasedChatKey]);

    // 1. Another holder of the maintenance lock: the cycle is skipped and nothing is touched.
    const holder = await fixture.ownerPool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 3::bigint))", [standaloneMediaMaintenanceLockKey]);
      const skipped = await runStandaloneMediaMaintenanceCycle(config, dependencies, new AbortController().signal);
      assert.equal(skipped.status, "skipped_lock_held");
      assert.equal(await objectBytesOrNull(expired.storageKey), expired.bytes.length);
      assert.equal(await objectBytesOrNull(releasedChatKey), "released".length);
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 3::bigint))", [standaloneMediaMaintenanceLockKey]);
    } finally {
      holder.release();
    }

    // 2. Shutdown before the cycle starts: refused, nothing deleted.
    const stopped = new AbortController();
    stopped.abort(new Error("shutdown"));
    const cancelled = await runStandaloneMediaMaintenanceCycle(config, dependencies, stopped.signal);
    assert.equal(cancelled.status, "failed");
    assert.equal(await objectBytesOrNull(expired.storageKey), expired.bytes.length);

    // 3. A real cycle.
    const outcome = await runStandaloneMediaMaintenanceCycle(config, dependencies, new AbortController().signal);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    if (outcome.status !== "completed") return;
    const cleanupBySha = new Map(outcome.media.cleanup.results.map((item) => [item.sha256, item.outcome]));
    assert.equal(cleanupBySha.get(expired.sha256), "deleted");
    // Still marked eligible, yet never claimed: the claim excludes any blob a live asset references.
    assert.equal(cleanupBySha.has(referenced.sha256), false);
    const referencedEligible = await fixture.ownerPool.query<{ due: boolean }>(
      "SELECT cleanup_eligible_at <= clock_timestamp() AS due FROM content.media_blob_lifecycles WHERE sha256 = $1",
      [referenced.sha256],
    );
    assert.equal(referencedEligible.rows[0]?.due, true);
    assert.equal(cleanupBySha.has(notYetDue.sha256), false);
    assert.deepEqual(outcome.media.chatFileCleanup, { tombstones: 1, deleted: 1, failures: [] });

    assert.equal(await objectBytesOrNull(expired.storageKey), null);
    assert.deepEqual(await cleanupState(fixture, expired.sha256), { completedAttempts: 1, eligible: false });
    assert.equal(await objectBytesOrNull(referenced.storageKey), referenced.bytes.length);
    assert.deepEqual(await cleanupState(fixture, referenced.sha256), { completedAttempts: 0, eligible: true });
    assert.equal(await objectBytesOrNull(notYetDue.storageKey), notYetDue.bytes.length);
    assert.deepEqual(await cleanupState(fixture, notYetDue.sha256), { completedAttempts: 0, eligible: true });
    assert.equal(await objectBytesOrNull(releasedChatKey), null);
    assert.equal(await objectBytesOrNull(liveChatKey), "live".length);
    const tombstones = await fixture.ownerPool.query("SELECT 1 FROM ai.chat_file_deletions WHERE s3_key = $1", [releasedChatKey]);
    assert.equal(tombstones.rowCount, 0);

    // 4. Idempotent: the next cycle finds nothing new to delete and the referenced blob stays.
    const again = await runStandaloneMediaMaintenanceCycle(config, dependencies, new AbortController().signal);
    assert.equal(again.status, "completed");
    if (again.status === "completed") assert.equal(again.media.cleanup.deleted, 0);
    assert.equal(await objectBytesOrNull(referenced.storageKey), referenced.bytes.length);

  }));
});
