/**
 * Multipart completion against a real, isolated RustFS 1.0.6 store
 * (`rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a`)
 * and the real PostgreSQL writer/reconciliation fences, including migration 0256.
 * Explicit-only: run through the PostgreSQL integration runner with
 * RUSTFS_IT_ENDPOINT, RUSTFS_IT_PUBLIC_ENDPOINT, RUSTFS_IT_ACCESS_KEY_ID and
 * RUSTFS_IT_SECRET_ACCESS_KEY set; it creates one uniquely named bucket.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { HttpError } from "../../../shared/errors";
import {
  withPostgresIntegrationFixture,
  type PostgresIntegrationFixture,
} from "../../../testSupport/postgresIntegration";
import { buildMediaBlobStorageKey } from "../../storageKeys";
import {
  beginMediaAssetUploadSessionCompletionAttemptWithOwner,
  completeMediaAssetUploadSessionForWorkspace,
  createMediaAssetUploadSessionCompletedPartsFingerprint,
  handoffMediaAssetUploadSessionCompletionAttempt,
  loadMediaAssetUploadSessionForCompletionForWorkspace,
  type MediaAssetUploadSessionCompletionWithOwnerInput,
  type MultipartMediaBlobWriterAttemptExactInput,
  type MultipartMediaBlobWriterAttemptInput,
} from "../../uploadSessions";
import type { CompleteMediaAssetUploadPartInput } from "../../types";
import {
  applyMultipartCompletionReconciliation,
  claimMultipartCompletionReconciliations,
  failMultipartCompletionReconciliation,
  processClaimedMultipartCompletionReconciliationWithDependencies,
  readMultipartCompletionReconciliationOutcome,
  rescheduleMultipartCompletionReconciliation,
  renewMultipartCompletionReconciliationLease,
  type MultipartCompletionReconciliationJobResult,
} from "../../multipart/completion/completionReconciliation";
import { completeMultipartUploadSessionAtApplicationBoundary } from "../../multipart/completion/completionBoundary";
import {
  applicationAttemptResolutionDependencies,
  applicationObservationScope,
  createApplicationDeadlines,
  insertSession,
  session,
} from "../../multipart/atomicWriterPostgresTestSupport";
import {
  createMediaAssetsS3Client,
  getMediaAssetsStorageConfig,
} from "../config";
import type { MediaAssetStorageDependencies } from "../contracts";
import { createPresignedMediaAssetUploadPartsWithDependencies } from "../presigned";
import { MultipartCompletionReconciliationStorageTerminalError } from "../errors";
import {
  completeMultipartMediaAssetUploadWithDependencies,
  createMultipartMediaAssetUploadWithDependencies,
} from "./multipart";
import { reconcileMultipartMediaAssetUploadWithDependencies } from "./reconciliation";
import {
  createCompletedPartsManifest,
  postgresCompletedPartsManifestStore,
} from "./completedPartsManifest";

function requiredTestEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the RustFS multipart integration.`);
  }
  return value;
}

const privateEndpoint = requiredTestEnv("RUSTFS_IT_ENDPOINT");
const publicEndpoint = requiredTestEnv("RUSTFS_IT_PUBLIC_ENDPOINT");
const accessKeyId = requiredTestEnv("RUSTFS_IT_ACCESS_KEY_ID");
const secretAccessKey = requiredTestEnv("RUSTFS_IT_SECRET_ACCESS_KEY");
const bucketName = `nibomo-mp-it-${randomUUID()}`;
const region = "us-east-1";
Object.assign(process.env, {
  MEDIA_ASSETS_STORAGE_PROFILE: "rustfs",
  MEDIA_ASSETS_S3_BUCKET_NAME: bucketName,
  MEDIA_ASSETS_S3_ENDPOINT: privateEndpoint,
  MEDIA_ASSETS_S3_PUBLIC_ENDPOINT: publicEndpoint,
  MEDIA_ASSETS_S3_REGION: region,
  MEDIA_ASSETS_S3_ACCESS_KEY_ID: accessKeyId,
  MEDIA_ASSETS_S3_SECRET_ACCESS_KEY: secretAccessKey,
});

const raw = new S3Client({
  endpoint: privateEndpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const partSizeBytes = 5 * 1024 * 1024;
const future = (): string => new Date(Date.now() + 3_600_000).toISOString();
const noop = (): void => undefined;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storageDependencies(client: S3Client): MediaAssetStorageDependencies {
  return {
    s3Client: client,
    getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig,
    completedPartsManifestStore: postgresCompletedPartsManifestStore,
  };
}

/** A fresh private client; `failOn` makes every request of that command throw before it is sent. */
function privateClient(
  failOn: ReadonlyArray<string> = [],
  observe: (commandName: string, input: unknown) => void = noop,
): S3Client {
  const client = createMediaAssetsS3Client("private", {});
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const commandName = context.commandName ?? "";
      observe(commandName, args.input);
      if (failOn.includes(commandName)) {
        throw new Error(`simulated process loss before ${commandName}`);
      }
      return next(args);
    },
    { step: "initialize", name: `mp-it-${randomUUID()}` },
  );
  return client;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function readObjectSha256(key: string): Promise<string> {
  const response = await raw.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  return sha256Hex(Buffer.from(await response.Body!.transformToByteArray()));
}

type RealSession = Readonly<{
  input: MediaAssetUploadSessionCompletionWithOwnerInput;
  parts: ReadonlyArray<CompleteMediaAssetUploadPartInput>;
  bytes: Buffer;
}>;

async function uploadPart(
  input: MediaAssetUploadSessionCompletionWithOwnerInput,
  partNumber: number,
  body: Buffer,
): Promise<CompleteMediaAssetUploadPartInput> {
  const sha256 = sha256Hex(body);
  const [presigned] = await createPresignedMediaAssetUploadPartsWithDependencies({
    workspaceId: input.workspaceId,
    mediaAssetId: input.mediaAssetId,
    stagingStorageKey: input.stagingStorageKey,
    s3UploadId: input.s3UploadId,
    parts: [{ partNumber, sha256 }],
    observationScope: applicationObservationScope(input),
  }, {
    s3Client: createMediaAssetsS3Client("public_presign", {}),
    getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig,
  });
  assert.ok(presigned !== undefined);
  assert.ok(presigned.url.startsWith(publicEndpoint), "part URL must be signed for the public origin");
  const response = await fetch(presigned.url, {
    method: "PUT",
    headers: presigned.headers,
    body: body,
  });
  assert.equal(response.status, 200, await response.text());
  const eTag = response.headers.get("etag");
  assert.ok(eTag !== null);
  return { partNumber, eTag, sha256 };
}

/**
 * Creates a real multipart upload and session row. `declared` overrides what the session
 * (and the signed proof) claims; `proofLastOperationId` signs a different operation.
 */
async function createRealSession(
  fixture: PostgresIntegrationFixture,
  options: Readonly<{
    declaredSha256?: string;
    declaredSizeBytes?: number;
    proofLastOperationId?: string;
    mimeType?: string;
  }> = {},
): Promise<RealSession> {
  const bytes = Buffer.concat([randomBytes(partSizeBytes), randomBytes(4_321)]);
  const base = session(fixture, "active", future());
  const sha256 = options.declaredSha256 ?? sha256Hex(bytes);
  const draft: MediaAssetUploadSessionCompletionWithOwnerInput = {
    ...base,
    sha256,
    blobStorageKey: buildMediaBlobStorageKey(sha256),
    mimeType: options.mimeType ?? "video/mp4",
    sizeBytes: options.declaredSizeBytes ?? bytes.byteLength,
    partSizeBytes,
    partCount: 2,
  };
  const created = await createMultipartMediaAssetUploadWithDependencies({
    signal: new AbortController().signal,
    workspaceId: draft.workspaceId,
    mediaAssetId: draft.mediaAssetId,
    stagingStorageKey: draft.stagingStorageKey,
    mimeType: draft.mimeType,
    sha256: draft.sha256,
    lastOperationId: options.proofLastOperationId ?? draft.lastOperationId,
    observationScope: applicationObservationScope(draft),
  }, storageDependencies(privateClient()));
  const input = { ...draft, s3UploadId: created.s3UploadId };
  await insertSession(fixture, input, "active");
  const parts = [
    await uploadPart(input, 1, bytes.subarray(0, partSizeBytes)),
    await uploadPart(input, 2, bytes.subarray(partSizeBytes)),
  ];
  return { input, parts, bytes };
}

async function completeThroughApplicationBoundary(
  real: RealSession,
  client: S3Client,
  parts: ReadonlyArray<CompleteMediaAssetUploadPartInput> = real.parts,
) {
  const loaded = await loadMediaAssetUploadSessionForCompletionForWorkspace(
    real.input.userId,
    real.input.workspaceId,
    real.input.sessionId,
  );
  const deadlines = createApplicationDeadlines(8_000, 15_000);
  try {
    return await completeMultipartUploadSessionAtApplicationBoundary(
      real.input.userId,
      loaded,
      parts,
      randomUUID(),
      applicationObservationScope(real.input),
      deadlines.operation,
      deadlines.writerLeaseTargetAtMs,
      deadlines.request,
      {
        ...applicationAttemptResolutionDependencies,
        abortMultipartMediaAssetUploadFn: async () => {},
        completeMultipartMediaAssetUploadFn: (storageInput) =>
          completeMultipartMediaAssetUploadWithDependencies(
            storageInput,
            storageDependencies(client),
          ),
        completeMediaAssetUploadSessionForWorkspaceFn:
          completeMediaAssetUploadSessionForWorkspace,
      },
    );
  } finally {
    deadlines.operation.dispose();
    deadlines.request.dispose();
  }
}

/** Acquires a writer attempt, runs storage completion with a client that "dies" at `lostAt`, then hands off. */
async function loseForegroundProcessAt(
  real: RealSession,
  lostAt: "CompleteMultipartUploadCommand" | "CopyObjectCommand",
): Promise<MultipartMediaBlobWriterAttemptExactInput> {
  const attemptInput: MultipartMediaBlobWriterAttemptInput = {
    ...real.input,
    attemptToken: randomUUID(),
    completedPartsFingerprint:
      createMediaAssetUploadSessionCompletedPartsFingerprint(real.parts),
  };
  const attempt = await beginMediaAssetUploadSessionCompletionAttemptWithOwner(
    attemptInput,
    60_000,
  );
  assert.equal(attempt.status, "acquired");
  assert.ok("reservationToken" in attempt);
  const writer: MultipartMediaBlobWriterAttemptExactInput = {
    ...attemptInput,
    reservationToken: attempt.reservationToken,
    normalizationVersion: attempt.normalizationVersion,
  };
  await assert.rejects(completeMultipartMediaAssetUploadWithDependencies({
    writer,
    getStorageCapability: async () => attempt.storageCapability,
    assertStorageMutationAuthorized: noop,
    signal: new AbortController().signal,
    workspaceId: real.input.workspaceId,
    mediaAssetId: real.input.mediaAssetId,
    stagingStorageKey: real.input.stagingStorageKey,
    blobStorageKey: real.input.blobStorageKey,
    s3UploadId: real.input.s3UploadId,
    mimeType: real.input.mimeType,
    sizeBytes: real.input.sizeBytes,
    sha256: real.input.sha256,
    lastOperationId: real.input.lastOperationId,
    parts: real.parts,
    observationScope: applicationObservationScope(real.input),
  }, storageDependencies(privateClient([lostAt]))));
  assert.equal(
    await handoffMediaAssetUploadSessionCompletionAttempt(writer),
    "handed_off",
  );
  return writer;
}

type WorkerRun = Readonly<{
  result: MultipartCompletionReconciliationJobResult;
  leaseRenewals: number;
  copies: ReadonlyArray<Readonly<Record<string, unknown>>>;
  terminalCode: string | null;
}>;

async function runReconciliationWorker(attemptToken: string): Promise<WorkerRun> {
  const deadlineAtMs = Date.now() + 60_000;
  const jobs = await claimMultipartCompletionReconciliations({
    leaseOwner: `rustfs-it-${randomUUID()}`,
    leaseDurationMs: 60_000,
    limit: 1,
    deadlineAtMs,
  });
  const job = jobs[0];
  assert.ok(job !== undefined, "a handed-off job must be claimable");
  assert.equal(job.attemptToken, attemptToken);
  let leaseRenewals = 0;
  let terminalCode: string | null = null;
  const copies: Array<Readonly<Record<string, unknown>>> = [];
  const client = privateClient([], (commandName, commandInput) => {
    if (commandName === "CopyObjectCommand") {
      copies.push(commandInput as Readonly<Record<string, unknown>>);
    }
  });
  const result = await processClaimedMultipartCompletionReconciliationWithDependencies(
    job,
    {
      leaseOwner: job.leaseOwner,
      leaseDurationMs: 60_000,
      maximumJobs: 1,
      deadlineAtMs,
      observationScope: applicationObservationScope({
        userId: job.userId,
        workspaceId: job.workspaceId,
      } as MediaAssetUploadSessionCompletionWithOwnerInput),
      signal: new AbortController().signal,
    },
    {
      claimJobsFn: claimMultipartCompletionReconciliations,
      reconcileStorageFn: async (storageInput) => {
        try {
          await reconcileMultipartMediaAssetUploadWithDependencies(
            storageInput,
            storageDependencies(client),
          );
        } catch (error) {
          if (error instanceof MultipartCompletionReconciliationStorageTerminalError) {
            terminalCode = error.code;
          }
          throw error;
        }
      },
      renewLeaseFn: async (...args) => {
        leaseRenewals += 1;
        return renewMultipartCompletionReconciliationLease(...args);
      },
      applyJobFn: applyMultipartCompletionReconciliation,
      rescheduleJobFn: rescheduleMultipartCompletionReconciliation,
      failJobFn: failMultipartCompletionReconciliation,
      readJobOutcomeFn: readMultipartCompletionReconciliationOutcome,
      nowFn: Date.now,
    },
  );
  return { result, leaseRenewals, copies, terminalCode };
}

async function sessionState(real: RealSession): Promise<string> {
  return (await loadMediaAssetUploadSessionForCompletionForWorkspace(
    real.input.userId,
    real.input.workspaceId,
    real.input.sessionId,
  )).state;
}

test("RustFS multipart: bucket", async () => {
  await raw.send(new CreateBucketCommand({ Bucket: bucketName }));
});

test("RustFS multipart: foreground completion verifies bytes, records the immutable manifest, promotes once", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const listed = await raw.send(new ListPartsCommand({
      Bucket: bucketName, Key: real.input.stagingStorageKey, UploadId: real.input.s3UploadId,
    }));
    assert.equal(listed.Parts?.length, 2);
    assert.ok(listed.Parts?.every((part) => part.ChecksumSHA256 === undefined), "RustFS ListParts omits part SHA-256 (G2)");
    assert.deepEqual(listed.Parts?.map((part) => part.ETag), real.parts.map((part) => part.eTag));

    const copies: Array<Readonly<Record<string, unknown>>> = [];
    const client = privateClient([], (name, input) => {
      if (name === "CopyObjectCommand") copies.push(input as Readonly<Record<string, unknown>>);
    });
    const result = await completeThroughApplicationBoundary(real, client);
    assert.equal(result.applied, true);
    assert.equal(await sessionState(real), "completed");
    assert.equal(await readObjectSha256(real.input.blobStorageKey), real.input.sha256);
    assert.equal(copies.length, 1, "exactly one promotion copy, no normalizing self-copy");
    assert.equal(copies[0]?.Key, real.input.blobStorageKey);
    assert.equal(typeof copies[0]?.CopySourceIfMatch, "string", "promotion is fenced on the verified staging ETag");

    const fingerprint = createMediaAssetUploadSessionCompletedPartsFingerprint(real.parts);
    const stored = await fixture.ownerPool.query<{ manifest: string; part_count: number }>(
      "SELECT manifest, part_count FROM content.media_multipart_completed_parts_manifests WHERE completed_parts_fingerprint = $1",
      [fingerprint],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]?.manifest, createCompletedPartsManifest(real.parts));
    assert.equal(stored.rows[0]?.part_count, 2);
    assert.equal(sha256Hex(Buffer.from(stored.rows[0]!.manifest, "utf8")), fingerprint);

    // Replay of the same completion does not copy again.
    const replayCopies: Array<unknown> = [];
    const replay = await completeThroughApplicationBoundary(real, privateClient([], (name) => {
      if (name === "CopyObjectCommand") replayCopies.push(name);
    }));
    assert.equal(replay.applied, false);
    assert.equal(replayCopies.length, 0);
  });
});

test("RustFS multipart: recovery after process loss before CompleteMultipartUpload uses the manifest", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const writer = await loseForegroundProcessAt(real, "CompleteMultipartUploadCommand");
    assert.equal(await objectExists(real.input.stagingStorageKey), false);
    const open = await raw.send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
    assert.ok(open.Uploads?.some((upload) => upload.UploadId === real.input.s3UploadId));

    const run = await runReconciliationWorker(writer.attemptToken);
    assert.equal(run.result.outcome, "applied", JSON.stringify(run.result));
    assert.ok(run.leaseRenewals > 0, "reconciliation renews its lease");
    assert.equal(run.copies.length, 1);
    assert.equal(await sessionState(real), "completed");
    assert.equal(await readObjectSha256(real.input.blobStorageKey), real.input.sha256);

    // A duplicate job is never claimable after apply, and a re-run of storage is a no-op.
    const again = await claimMultipartCompletionReconciliations({
      leaseOwner: `rustfs-it-${randomUUID()}`, leaseDurationMs: 60_000, limit: 1, deadlineAtMs: Date.now() + 10_000,
    });
    assert.equal(again.length, 0);
  });
});

test("RustFS multipart: recovery after process loss before promotion verifies the completed object", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const writer = await loseForegroundProcessAt(real, "CopyObjectCommand");
    assert.equal(await objectExists(real.input.stagingStorageKey), true);
    assert.equal(await objectExists(real.input.blobStorageKey), false);
    const run = await runReconciliationWorker(writer.attemptToken);
    assert.equal(run.result.outcome, "applied", JSON.stringify(run.result));
    assert.equal(run.copies.length, 1);
    assert.equal(typeof run.copies[0]?.CopySourceIfMatch, "string");
    assert.equal(await sessionState(real), "completed");
    assert.equal(await readObjectSha256(real.input.blobStorageKey), real.input.sha256);
  });
});

test("RustFS multipart: a part overwritten after the fingerprint is refused, nothing promoted", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const writer = await loseForegroundProcessAt(real, "CompleteMultipartUploadCommand");
    // Same size, different bytes: a new ETag for part 1 after the manifest was recorded.
    const replaced = await uploadPart(real.input, 1, randomBytes(partSizeBytes));
    assert.notEqual(replaced.eTag, real.parts[0]?.eTag);
    const run = await runReconciliationWorker(writer.attemptToken);
    assert.equal(run.result.outcome, "failed");
    assert.equal(run.terminalCode, "MULTIPART_PARTS_FINGERPRINT_MISMATCH");
    assert.equal(run.result.errorCode, "MULTIPART_PARTS_FINGERPRINT_MISMATCH");
    assert.equal(run.copies.length, 0);
    assert.equal(await objectExists(real.input.stagingStorageKey), false);
    assert.equal(await objectExists(real.input.blobStorageKey), false);
  });
});

test("RustFS multipart: foreground with a stale part ETag never promotes", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    // The client declares the original parts but part 1 is overwritten before completion.
    await uploadPart(real.input, 1, randomBytes(partSizeBytes));
    await assert.rejects(completeThroughApplicationBoundary(real, privateClient()));
    assert.equal(await objectExists(real.input.blobStorageKey), false);
    assert.notEqual(await sessionState(real), "completed");
  });
});

test("RustFS multipart: invalid proof, size, and hash are refused before promotion", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const wrongProof = await createRealSession(fixture, { proofLastOperationId: randomUUID() });
    await assert.rejects(
      completeThroughApplicationBoundary(wrongProof, privateClient()),
      (error: unknown) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_PROOF_MISMATCH",
    );
    assert.equal(await objectExists(wrongProof.input.blobStorageKey), false);

    // Declared SHA-256 (and signed proof) differ from the bytes; the part checksums are honest.
    const wrongHash = await createRealSession(fixture, { declaredSha256: sha256Hex(randomBytes(32)) });
    await assert.rejects(
      completeThroughApplicationBoundary(wrongHash, privateClient()),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    );
    assert.equal(await objectExists(wrongHash.input.blobStorageKey), false);
    assert.notEqual(await sessionState(wrongHash), "completed");

    const wrongSize = await createRealSession(fixture, { declaredSizeBytes: partSizeBytes + 4_320 });
    await assert.rejects(
      completeThroughApplicationBoundary(wrongSize, privateClient()),
      (error: unknown) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_MISMATCH",
    );
    assert.equal(await objectExists(wrongSize.input.blobStorageKey), false);
  });
});

test("RustFS multipart: staging replaced between verification and promotion is not promoted", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const staged = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: real.input.stagingStorageKey })).catch(() => null);
    assert.equal(staged, null);
    let replaced = false;
    const client = privateClient([], noop);
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const commandInput = args.input as Readonly<{ Key?: string }>;
        if (!replaced && context.commandName === "CopyObjectCommand" && commandInput.Key === real.input.blobStorageKey) {
          replaced = true;
          const head = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: real.input.stagingStorageKey }));
          // Same proof metadata and length, other bytes: only the ETag fence can tell.
          await raw.send(new PutObjectCommand({
            Bucket: bucketName, Key: real.input.stagingStorageKey, Body: randomBytes(real.bytes.byteLength),
            ContentType: real.input.mimeType, Metadata: head.Metadata,
          }));
        }
        return next(args);
      },
      { step: "initialize", name: "replace-staging-before-promotion" },
    );
    await assert.rejects(completeThroughApplicationBoundary(real, client));
    assert.equal(replaced, true);
    assert.equal(await objectExists(real.input.blobStorageKey), false);
  });
});

test("RustFS multipart: a wrong pre-existing blob is never accepted", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    await raw.send(new PutObjectCommand({
      Bucket: bucketName, Key: real.input.blobStorageKey, Body: randomBytes(real.bytes.byteLength),
      ContentType: real.input.mimeType, Metadata: { "flashcards-sha256": real.input.sha256 },
    }));
    const writer = await loseForegroundProcessAt(real, "CopyObjectCommand").catch(async (error: unknown) => {
      throw error;
    });
    const run = await runReconciliationWorker(writer.attemptToken);
    assert.equal(run.result.outcome, "failed");
    assert.equal(run.terminalCode, "MULTIPART_BLOB_OBJECT_MISMATCH");
    assert.equal(run.copies.length, 0);
    assert.notEqual(await sessionState(real), "completed");
  });
});

test("RustFS multipart: absent manifest and absent upload fail closed", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const baseInput = {
      workspaceId: real.input.workspaceId,
      mediaAssetId: real.input.mediaAssetId,
      stagingStorageKey: real.input.stagingStorageKey,
      blobStorageKey: real.input.blobStorageKey,
      s3UploadId: real.input.s3UploadId,
      mimeType: real.input.mimeType,
      sizeBytes: real.input.sizeBytes,
      sha256: real.input.sha256,
      lastOperationId: real.input.lastOperationId,
      partCount: 2,
      completedPartsFingerprint: createMediaAssetUploadSessionCompletedPartsFingerprint(real.parts),
      renewLease: async () => {},
      signal: new AbortController().signal,
      observationScope: applicationObservationScope(real.input),
    };
    await assert.rejects(
      reconcileMultipartMediaAssetUploadWithDependencies(baseInput, storageDependencies(privateClient())),
      (error: unknown) => error instanceof MultipartCompletionReconciliationStorageTerminalError
        && error.code === "MULTIPART_PARTS_INVALID",
    );
    await assert.rejects(
      reconcileMultipartMediaAssetUploadWithDependencies(baseInput, {
        s3Client: privateClient(), getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig,
      }),
      (error: unknown) => error instanceof MultipartCompletionReconciliationStorageTerminalError
        && error.code === "S3_REQUEST_REJECTED",
    );
    assert.equal(await objectExists(real.input.stagingStorageKey), false);
    await assert.rejects(
      reconcileMultipartMediaAssetUploadWithDependencies(
        { ...baseInput, s3UploadId: "missing-upload-id" },
        storageDependencies(privateClient()),
      ),
      (error: unknown) => error instanceof MultipartCompletionReconciliationStorageTerminalError,
    );
    assert.equal(await objectExists(real.input.blobStorageKey), false);
  });
});

test("RustFS multipart: cancellation stops verification without promotion", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const real = await createRealSession(fixture);
    const writer = await loseForegroundProcessAt(real, "CopyObjectCommand");
    const controller = new AbortController();
    const client = privateClient([], (name) => {
      if (name === "GetObjectCommand") controller.abort(new Error("cancelled by test"));
    });
    await assert.rejects(reconcileMultipartMediaAssetUploadWithDependencies({
      workspaceId: real.input.workspaceId,
      mediaAssetId: real.input.mediaAssetId,
      stagingStorageKey: real.input.stagingStorageKey,
      blobStorageKey: real.input.blobStorageKey,
      s3UploadId: real.input.s3UploadId,
      mimeType: real.input.mimeType,
      sizeBytes: real.input.sizeBytes,
      sha256: real.input.sha256,
      lastOperationId: real.input.lastOperationId,
      partCount: 2,
      completedPartsFingerprint: writer.completedPartsFingerprint,
      renewLease: async () => {},
      signal: controller.signal,
      observationScope: applicationObservationScope(real.input),
    }, storageDependencies(client)));
    assert.equal(await objectExists(real.input.blobStorageKey), false);
    // The durable job is still there and completes afterwards.
    const run = await runReconciliationWorker(writer.attemptToken);
    assert.equal(run.result.outcome, "applied", JSON.stringify(run.result));
  });
});

test("RustFS multipart: manifest table is content-addressed, immutable, and private", async () => {
  await withPostgresIntegrationFixture(async (fixture) => {
    const parts = [{ partNumber: 1, eTag: "\"a\"", sha256: sha256Hex(Buffer.from("a")) }];
    const manifest = createCompletedPartsManifest(parts);
    const fingerprint = createMediaAssetUploadSessionCompletedPartsFingerprint(parts);
    await postgresCompletedPartsManifestStore.record(fingerprint, 1, manifest);
    await postgresCompletedPartsManifestStore.record(fingerprint, 1, manifest);
    assert.deepEqual(await postgresCompletedPartsManifestStore.read(fingerprint), { partCount: 1, manifest });
    assert.equal(await postgresCompletedPartsManifestStore.read(sha256Hex(randomBytes(8))), null);

    const status = async (fp: string, count: number, text: string): Promise<string> =>
      (await fixture.runtimePool.query<{ s: string }>(
        "SELECT content.record_media_multipart_completed_parts_manifest($1,$2,$3) AS s",
        [fp, count, text],
      )).rows[0]!.s;
    const other = createCompletedPartsManifest([{ ...parts[0]!, eTag: "\"b\"" }]);
    assert.equal(await status(fingerprint, 1, other), "invalid", "a manifest must hash to its key");
    assert.equal(await status(sha256Hex(Buffer.from("[]")), 0, "[]"), "invalid");
    const twoParts = JSON.stringify([[2, "\"x\"", sha256Hex(Buffer.from("x"))]]);
    assert.equal(await status(sha256Hex(Buffer.from(twoParts)), 1, twoParts), "invalid", "parts must start at 1");

    await assert.rejects(
      fixture.ownerPool.query(
        "UPDATE content.media_multipart_completed_parts_manifests SET created_at = created_at WHERE completed_parts_fingerprint = $1",
        [fingerprint],
      ),
      /immutable/u,
    );
    await assert.rejects(
      fixture.runtimePool.query("SELECT * FROM content.media_multipart_completed_parts_manifests"),
      /permission denied/u,
    );
    await assert.rejects(
      fixture.runtimePool.query(
        "INSERT INTO content.media_multipart_completed_parts_manifests (completed_parts_fingerprint, part_count, manifest) VALUES ($1, 1, $2)",
        [sha256Hex(Buffer.from(other)), other],
      ),
      /permission denied/u,
    );
    await fixture.ownerPool.query(
      "DELETE FROM content.media_multipart_completed_parts_manifests WHERE completed_parts_fingerprint = $1",
      [fingerprint],
    );
  });
});
