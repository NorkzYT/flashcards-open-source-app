/**
 * Storage-boundary integration against a real, isolated RustFS 1.0.6 store
 * (`rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a`).
 * Not part of `npm test`. It creates one uniquely named bucket and run it with:
 * RUSTFS_IT_ENDPOINT=<private origin> RUSTFS_IT_PUBLIC_ENDPOINT=<second origin to the same store>
 * RUSTFS_IT_ACCESS_KEY_ID=... RUSTFS_IT_SECRET_ACCESS_KEY=...
 * node --test --import tsx src/mediaAssets/storage/rustfs.integration.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { HttpError } from "../../shared/errors";
import {
  createChatFileUploadPutUrl,
  getChatFileObjectBytes,
  headChatFileObjectSize,
  putChatFileObject,
} from "../../chatFiles/storage";
import { buildMediaBlobStorageKey, buildMediaUploadStagingStorageKey } from "../storageKeys";
import {
  createMediaAssetsS3Client,
  getMediaAssetsS3Client,
  getMediaAssetsStorageConfig,
  getMediaBlobCleanupS3Client,
} from "./config";
import {
  abortMultipartMediaAssetUpload,
  assertMediaAssetObjectMatches,
  createMultipartMediaAssetUpload,
  createPresignedMediaAssetDownload,
  createPresignedMediaAssetUpload,
  createPresignedMediaAssetUploadParts,
  deletePermanentMediaBlob,
  loadMediaAssetObjectBytes,
  MediaBlobCleanupStorageConditionalConflictError,
} from "./index";
import { loadMediaAssetObjectMetadataWithDependencies } from "./objects";
import { storeCatalogImageBlobBytesIfAbsent } from "./direct";
import {
  promoteMediaAssetUploadToBlobWithCapabilityVerifier,
  storeMediaAssetBlobBytesIfAbsentWithCapabilityVerifier,
} from "./promotion/promotion";
import {
  loadGeneratedMediaStagingObject,
  promoteGeneratedMediaObjectWithCapabilityVerifier,
  storeGeneratedMediaStagingObject,
} from "./promotion/generatedPromotion";
import { testObservationScope } from "./testHelpers";
import { completeMultipartMediaAssetUploadWithCapabilityVerifier } from "./multipart/multipart";

function requiredTestEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the RustFS storage integration.`);
  }
  return value;
}

const privateEndpoint = requiredTestEnv("RUSTFS_IT_ENDPOINT");
const publicEndpoint = requiredTestEnv("RUSTFS_IT_PUBLIC_ENDPOINT");
const accessKeyId = requiredTestEnv("RUSTFS_IT_ACCESS_KEY_ID");
const secretAccessKey = requiredTestEnv("RUSTFS_IT_SECRET_ACCESS_KEY");
const bucketName = `nibomo-it-${randomUUID()}`;
const region = "us-east-1";
const standaloneEnv = {
  MEDIA_ASSETS_STORAGE_PROFILE: "rustfs",
  MEDIA_ASSETS_S3_BUCKET_NAME: bucketName,
  MEDIA_ASSETS_S3_ENDPOINT: privateEndpoint,
  MEDIA_ASSETS_S3_PUBLIC_ENDPOINT: publicEndpoint,
  MEDIA_ASSETS_S3_REGION: region,
  MEDIA_ASSETS_S3_ACCESS_KEY_ID: accessKeyId,
  MEDIA_ASSETS_S3_SECRET_ACCESS_KEY: secretAccessKey,
} as const;
Object.assign(process.env, standaloneEnv);

const raw = new S3Client({
  endpoint: privateEndpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
const workspaceId = randomUUID();
const noop = (): void => undefined;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uniqueBytes(label: string): Buffer {
  return Buffer.from(`${label}:${randomUUID()}:${"x".repeat(1024)}`);
}

async function withEnv(overrides: Readonly<Record<string, string | undefined>>, run: () => void): Promise<void> {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type Hook = (commandName: string) => Promise<void>;

/** Runs `hook` once, right before the next request of `commandName` on `client`. */
function interceptOnce(client: S3Client, commandName: string, hook: () => Promise<void>): void {
  let pending: Hook | null = async (name) => {
    if (name !== commandName) return;
    pending = null;
    await hook();
  };
  const middlewareName = `rustfs-it-${randomUUID()}`;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (pending !== null) await pending(context.commandName ?? "");
      if (pending === null) client.middlewareStack.remove(middlewareName);
      return next(args);
    },
    { step: "initialize", name: middlewareName },
  );
}

async function presignedPut(sessionMediaAssetId: string, operationId: string, bytes: Buffer, mimeType: string): Promise<string> {
  const storageKey = buildMediaUploadStagingStorageKey(workspaceId, sessionMediaAssetId, operationId);
  const upload = await createPresignedMediaAssetUpload({
    workspaceId,
    mediaAssetId: sessionMediaAssetId,
    storageKey,
    mimeType,
    sha256: sha256Hex(bytes),
    lastOperationId: operationId,
    observationScope: testObservationScope,
  });
  assert.equal(new URL(upload.url).origin, new URL(publicEndpoint).origin);
  const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
  assert.equal(response.status, 200, await response.text());
  return storageKey;
}

test.before(async () => {
  await raw.send(new CreateBucketCommand({ Bucket: bucketName }));
});

test("config fails closed for missing, partial, conflicting, or malformed standalone inputs", async () => {
  await withEnv({ MEDIA_ASSETS_STORAGE_PROFILE: undefined }, () => {
    assert.throws(() => getMediaAssetsStorageConfig(), /conflicts with standalone media storage inputs/u);
    assert.throws(() => createMediaAssetsS3Client("private", {}), /conflicts with standalone/u);
  });
  await withEnv({ MEDIA_ASSETS_STORAGE_PROFILE: "aws" }, () => {
    assert.throws(() => createMediaAssetsS3Client("public_presign", {}), /conflicts with standalone/u);
  });
  await withEnv({ MEDIA_ASSETS_STORAGE_PROFILE: "minio" }, () => {
    assert.throws(() => getMediaAssetsStorageConfig(), /must be "aws" or "rustfs"/u);
  });
  for (const missing of [
    "MEDIA_ASSETS_S3_ENDPOINT",
    "MEDIA_ASSETS_S3_PUBLIC_ENDPOINT",
    "MEDIA_ASSETS_S3_REGION",
    "MEDIA_ASSETS_S3_ACCESS_KEY_ID",
    "MEDIA_ASSETS_S3_SECRET_ACCESS_KEY",
  ]) {
    await withEnv({ [missing]: undefined }, () => {
      assert.throws(() => getMediaAssetsStorageConfig(), new RegExp(`${missing} is required`, "u"));
      assert.throws(() => createMediaAssetsS3Client("private", {}), new RegExp(`${missing} is required`, "u"));
    });
  }
  await withEnv({ MEDIA_ASSETS_S3_PUBLIC_ENDPOINT: "https://user:pw@media.example.test/bucket" }, () => {
    assert.throws(() => getMediaAssetsStorageConfig(), /bare http\(s\) origin/u);
  });
  await withEnv({
    MEDIA_ASSETS_STORAGE_PROFILE: undefined,
    MEDIA_ASSETS_S3_ENDPOINT: undefined,
    MEDIA_ASSETS_S3_PUBLIC_ENDPOINT: undefined,
    MEDIA_ASSETS_S3_REGION: undefined,
    MEDIA_ASSETS_S3_ACCESS_KEY_ID: undefined,
    MEDIA_ASSETS_S3_SECRET_ACCESS_KEY: undefined,
  }, () => {
    assert.deepEqual(getMediaAssetsStorageConfig(), { bucketName, profile: "aws" });
  });
  assert.deepEqual(getMediaAssetsStorageConfig(), { bucketName, profile: "rustfs" });
});

test("presigned direct upload is verified by full read, and its proof still binds owner, length, type", async () => {
  const mediaAssetId = randomUUID();
  const operationId = `op-${randomUUID()}`;
  const bytes = uniqueBytes("direct");
  const storageKey = await presignedPut(mediaAssetId, operationId, bytes, "image/png");
  const input = {
    workspaceId, mediaAssetId, storageKey, mimeType: "image/png", sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes), lastOperationId: operationId, observationScope: testObservationScope,
  };

  const rawHead = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: storageKey, ChecksumMode: "ENABLED" }));
  assert.equal(rawHead.ChecksumType, undefined, "RustFS 1.0.6 omits ChecksumType (gap G1)");
  await assertMediaAssetObjectMatches(input);

  await assert.rejects(assertMediaAssetObjectMatches({ ...input, workspaceId: randomUUID() }),
    (error) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_PROOF_MISMATCH");
  await assert.rejects(assertMediaAssetObjectMatches({ ...input, lastOperationId: "other-op" }),
    (error) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_PROOF_MISMATCH");
  await assert.rejects(assertMediaAssetObjectMatches({ ...input, sizeBytes: bytes.byteLength + 1 }),
    (error) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_MISMATCH");
  await assert.rejects(assertMediaAssetObjectMatches({ ...input, mimeType: "image/jpeg" }),
    (error) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_MISMATCH");
  await assert.rejects(assertMediaAssetObjectMatches({ ...input, sha256: sha256Hex(uniqueBytes("other")) }),
    (error) => error instanceof HttpError && error.code === "MEDIA_ASSET_UPLOAD_MISMATCH");

  const replay = await createPresignedMediaAssetUpload({ ...input });
  const replayResponse = await fetch(replay.url, { method: "PUT", headers: replay.headers, body: uniqueBytes("replay") });
  assert.notEqual(replayResponse.status, 200, "an overwrite through a fresh signed URL must not succeed");

  const download = await createPresignedMediaAssetDownload(input);
  assert.equal(new URL(download.url).origin, new URL(publicEndpoint).origin);
  const ranged = await fetch(download.url, { headers: { range: "bytes=0-9" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 10));

  const loaded = await loadMediaAssetObjectBytes({ ...input, maxByteSize: 1_000_000 });
  assert.equal(loaded.sha256, input.sha256);
});

test("full-object verification is tied to the observed ETag entity", async () => {
  const mediaAssetId = randomUUID();
  const operationId = `op-${randomUUID()}`;
  const bytes = uniqueBytes("etag");
  const storageKey = await presignedPut(mediaAssetId, operationId, bytes, "image/png");
  const input = {
    workspaceId, mediaAssetId, storageKey, mimeType: "image/png", sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes), lastOperationId: operationId, observationScope: testObservationScope,
  };
  const head = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: storageKey }));
  await assert.rejects(
    raw.send(new GetObjectCommand({ Bucket: bucketName, Key: storageKey, IfMatch: "\"0000\"" })),
    (error) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412,
  );
  assert.ok(head.ETag);

  // Replace the object (same length, same proof metadata) between the HEAD and the verifying GET.
  const swapped = Buffer.from(bytes);
  swapped[0] = swapped[0] === 0x41 ? 0x42 : 0x41;
  const client = getMediaAssetsS3Client();
  interceptOnce(client, "GetObjectCommand", async () => {
    const original = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: storageKey }));
    await raw.send(new PutObjectCommand({
      Bucket: bucketName, Key: storageKey, Body: swapped, ContentType: "image/png",
      Metadata: original.Metadata,
    }));
  });
  const observed = await loadMediaAssetObjectMetadataWithDependencies(input, {
    s3Client: client, getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig,
  }).then((metadata) => metadata.checksumType, (error: unknown) => error);
  assert.notEqual(observed, "FULL_OBJECT", "a replaced entity must never be reported as FULL_OBJECT");
  await assert.rejects(assertMediaAssetObjectMatches(input));
});

test("composite multipart checksums are never upgraded to FULL_OBJECT", async () => {
  const key = `media/it/composite/${randomUUID()}`;
  const part = Buffer.alloc(5 * 1024 * 1024, 7);
  const tail = Buffer.from("tail");
  const created = await raw.send(new CreateMultipartUploadCommand({
    Bucket: bucketName, Key: key, ContentType: "image/png", ChecksumAlgorithm: "SHA256",
  }));
  const parts = [];
  for (const [index, body] of [part, tail].entries()) {
    const uploaded = await raw.send(new UploadPartCommand({
      Bucket: bucketName, Key: key, UploadId: created.UploadId, PartNumber: index + 1, Body: body,
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
    }));
    parts.push({ PartNumber: index + 1, ETag: uploaded.ETag, ChecksumSHA256: uploaded.ChecksumSHA256 });
  }
  await raw.send(new CompleteMultipartUploadCommand({
    Bucket: bucketName, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts },
  }));
  const head = await getMediaAssetsS3Client().send(new HeadObjectCommand({ Bucket: bucketName, Key: key, ChecksumMode: "ENABLED" }));
  assert.match(head.ChecksumSHA256 ?? "", /-2$/u);
  assert.notEqual(head.ChecksumType, "FULL_OBJECT");
});

test("multipart create and part presign work; completion without the manifest store fails closed", async () => {
  const mediaAssetId = randomUUID();
  const stagingStorageKey = `media/uploads/multipart/${workspaceId}/${mediaAssetId}/${randomUUID()}`;
  const created = await createMultipartMediaAssetUpload({
    signal: new AbortController().signal, workspaceId, mediaAssetId, stagingStorageKey,
    mimeType: "video/mp4", sha256: sha256Hex(Buffer.from("x")), lastOperationId: "op",
    observationScope: testObservationScope,
  });
  const [part] = await createPresignedMediaAssetUploadParts({
    workspaceId, mediaAssetId, stagingStorageKey, s3UploadId: created.s3UploadId,
    parts: [{ partNumber: 1, sha256: sha256Hex(Buffer.from("x")) }],
    observationScope: testObservationScope,
  });
  assert.ok(part?.url.startsWith(publicEndpoint));
  let storageCalls = 0;
  const client = createMediaAssetsS3Client("private", {});
  client.middlewareStack.add((next) => async (args) => {
    storageCalls += 1;
    return next(args);
  }, { step: "initialize", name: "count-storage-calls" });
  const writer = {
    workspaceId, mediaAssetId, stagingStorageKey, blobStorageKey: buildMediaBlobStorageKey(sha256Hex(Buffer.from("x"))),
    s3UploadId: created.s3UploadId, mimeType: "video/mp4", sizeBytes: 1, sha256: sha256Hex(Buffer.from("x")),
    lastOperationId: "op", partCount: 1,
    completedPartsFingerprint: createHash("sha256").update(JSON.stringify([[1, "\"e\"", sha256Hex(Buffer.from("x"))]])).digest("hex"),
  };
  await assert.rejects(completeMultipartMediaAssetUploadWithCapabilityVerifier({
    ...writer, writer: writer as never, getStorageCapability: async () => ({}) as never,
    assertStorageMutationAuthorized: noop, signal: new AbortController().signal,
    parts: [{ partNumber: 1, eTag: "\"e\"", sha256: sha256Hex(Buffer.from("x")) }],
    observationScope: testObservationScope,
  }, { s3Client: client, getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig }, noop),
  (error) => error instanceof HttpError
    && error.statusCode === 501
    && error.code === "MEDIA_ASSET_MULTIPART_UNSUPPORTED_BY_STORAGE");
  assert.equal(storageCalls, 0);
  await abortMultipartMediaAssetUpload({
    signal: new AbortController().signal, workspaceId, mediaAssetId, stagingStorageKey,
    s3UploadId: created.s3UploadId, observationScope: testObservationScope,
  });
  const uploads = await raw.send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
  assert.equal(uploads.Uploads?.some((upload) => upload.UploadId === created.s3UploadId) ?? false, false);
});

test("direct ingestion store-if-absent, promotion, and generated media verify on RustFS", async () => {
  const mediaAssetId = randomUUID();
  const operationId = `op-${randomUUID()}`;
  const bytes = uniqueBytes("ingest");
  const sha256 = sha256Hex(bytes);
  const storageKey = buildMediaBlobStorageKey(sha256);
  const writer = { workspaceId, mediaAssetId, storageKey, mimeType: "image/png", sha256, operationId, sizeBytes: bytes.byteLength };
  const storeInput = {
    writer: writer as never, storageCapability: {} as never, signal: new AbortController().signal,
    workspaceId, mediaAssetId, storageKey, mimeType: "image/png", sha256, lastOperationId: operationId,
    bytes, observationScope: testObservationScope,
  };
  const dependencies = { s3Client: getMediaAssetsS3Client(), getMediaAssetsStorageConfigFn: getMediaAssetsStorageConfig };
  await storeMediaAssetBlobBytesIfAbsentWithCapabilityVerifier(storeInput, dependencies, noop);
  // Second write takes the 412 winner path and must verify the existing entity.
  await storeMediaAssetBlobBytesIfAbsentWithCapabilityVerifier(storeInput, dependencies, noop);

  // Upload-session promotion from a presigned staging object to its blob key.
  const promoteBytes = uniqueBytes("promote");
  const promoteSha = sha256Hex(promoteBytes);
  const promoteAssetId = randomUUID();
  const promoteOp = `op-${randomUUID()}`;
  const uploadStorageKey = await presignedPut(promoteAssetId, promoteOp, promoteBytes, "application/pdf");
  const blobStorageKey = buildMediaBlobStorageKey(promoteSha);
  const promoteWriter = {
    workspaceId, mediaAssetId: promoteAssetId, stagingStorageKey: uploadStorageKey, blobStorageKey,
    mimeType: "application/pdf", sizeBytes: promoteBytes.byteLength, sha256: promoteSha, lastOperationId: promoteOp,
  };
  await promoteMediaAssetUploadToBlobWithCapabilityVerifier({
    writer: promoteWriter as never, getStorageCapability: async () => ({}) as never,
    assertStorageMutationAuthorized: noop, signal: new AbortController().signal,
    workspaceId, mediaAssetId: promoteAssetId, uploadStorageKey, blobStorageKey, mimeType: "application/pdf",
    sizeBytes: promoteBytes.byteLength, sha256: promoteSha, lastOperationId: promoteOp,
    observationScope: testObservationScope,
  }, dependencies, noop);
  const promoted = await raw.send(new GetObjectCommand({ Bucket: bucketName, Key: blobStorageKey }));
  assert.equal(sha256Hex(Buffer.from(await promoted.Body!.transformToByteArray())), promoteSha);

  // A content-addressed key that already holds other bytes is rejected.
  const catalogBytes = uniqueBytes("catalog");
  const catalogSha = sha256Hex(catalogBytes);
  const catalogKey = buildMediaBlobStorageKey(catalogSha);
  const foreign = uniqueBytes("foreign");
  await raw.send(new PutObjectCommand({
    Bucket: bucketName, Key: catalogKey, Body: foreign, ContentType: "image/jpeg",
    ChecksumSHA256: createHash("sha256").update(foreign).digest("base64"),
  }));
  await assert.rejects(storeCatalogImageBlobBytesIfAbsent({
    signal: new AbortController().signal, storageKey: catalogKey, mimeType: "image/jpeg",
    sizeBytes: catalogBytes.byteLength, sha256: catalogSha, bytes: catalogBytes, observationScope: testObservationScope,
  }), (error) => error instanceof HttpError && error.code === "CATALOG_IMAGE_BLOB_OBJECT_MISMATCH");

  // Generated media: staging store, reload, and promotion.
  const generatedAssetId = randomUUID();
  const generatedOp = `op-${randomUUID()}`;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), uniqueBytes("jpeg")]);
  const jpegSha = sha256Hex(jpeg);
  const stagingStorageKey = buildMediaUploadStagingStorageKey(workspaceId, generatedAssetId, generatedOp);
  const generatedInput = {
    workspaceId, mediaAssetId: generatedAssetId, operationId: generatedOp, signal: new AbortController().signal,
    observationScope: testObservationScope, stagingStorageKey,
  };
  const staged = await storeGeneratedMediaStagingObject({
    ...generatedInput, bytes: jpeg, mimeType: "image/jpeg", sizeBytes: jpeg.byteLength, sha256: jpegSha,
  });
  assert.equal(staged.sha256, jpegSha);
  assert.deepEqual(await loadGeneratedMediaStagingObject(generatedInput), staged);
  const generatedBlobKey = buildMediaBlobStorageKey(jpegSha);
  const generatedWriter = {
    workspaceId, mediaAssetId: generatedAssetId, operationId: generatedOp, stagingStorageKey,
    blobStorageKey: generatedBlobKey, mimeType: "image/jpeg", sizeBytes: jpeg.byteLength, sha256: jpegSha,
  };
  await promoteGeneratedMediaObjectWithCapabilityVerifier({
    ...generatedInput, writer: generatedWriter as never, storageCapability: {} as never,
    blobStorageKey: generatedBlobKey, mimeType: "image/jpeg", sizeBytes: jpeg.byteLength, sha256: jpegSha,
  }, dependencies, noop);
  const generatedBlob = await raw.send(new GetObjectCommand({ Bucket: bucketName, Key: generatedBlobKey }));
  assert.equal(sha256Hex(Buffer.from(await generatedBlob.Body!.transformToByteArray())), jpegSha);
});

test("guarded blob cleanup keeps If-Match, maps RustFS missing-key 412 to not_found, and still conflicts on change", async () => {
  async function putBlob(label: string): Promise<{ sha256: string; storageKey: string; bytes: Buffer }> {
    const bytes = uniqueBytes(label);
    const sha256 = sha256Hex(bytes);
    const storageKey = buildMediaBlobStorageKey(sha256);
    await raw.send(new PutObjectCommand({ Bucket: bucketName, Key: storageKey, Body: bytes, ContentType: "image/png" }));
    return { sha256, storageKey, bytes };
  }
  function cleanupInput(blob: { sha256: string; storageKey: string }) {
    return {
      sha256: blob.sha256, storageKey: blob.storageKey, cleanupGeneration: 1,
      renewLease: async () => undefined, signal: new AbortController().signal, observationScope: testObservationScope,
    };
  }
  const cleanupClient = getMediaBlobCleanupS3Client();

  const plain = await putBlob("cleanup-plain");
  assert.equal(await deletePermanentMediaBlob(cleanupInput(plain)), "deleted");
  assert.equal(await deletePermanentMediaBlob(cleanupInput(plain)), "not_found");

  const vanished = await putBlob("cleanup-vanished");
  interceptOnce(cleanupClient, "DeleteObjectCommand", async () => {
    await raw.send(new DeleteObjectCommand({ Bucket: bucketName, Key: vanished.storageKey }));
  });
  assert.equal(await deletePermanentMediaBlob(cleanupInput(vanished)), "not_found");

  const changed = await putBlob("cleanup-changed");
  interceptOnce(cleanupClient, "DeleteObjectCommand", async () => {
    await raw.send(new PutObjectCommand({
      Bucket: bucketName, Key: changed.storageKey, Body: uniqueBytes("rewritten"), ContentType: "image/png",
    }));
  });
  await assert.rejects(deletePermanentMediaBlob(cleanupInput(changed)),
    (error) => error instanceof MediaBlobCleanupStorageConditionalConflictError);
  const kept = await raw.send(new HeadObjectCommand({ Bucket: bucketName, Key: changed.storageKey }));
  assert.ok(kept.ETag, "a changed object must survive the guarded delete");
});

test("chat files use the private client for I/O and the public origin for signed URLs", async () => {
  const key = `chat-files/uploads/it-user/${randomUUID()}`;
  const bytes = uniqueBytes("chat");
  await putChatFileObject(key, bytes, "text/plain");
  assert.deepEqual(await getChatFileObjectBytes(key), bytes);
  assert.equal(await headChatFileObjectSize(key), bytes.byteLength);
  assert.equal(await headChatFileObjectSize(`${key}-missing`), null);

  const putKey = `chat-files/uploads/it-user/${randomUUID()}`;
  const url = await createChatFileUploadPutUrl(putKey, "text/plain", bytes.byteLength, new Date(), 300);
  assert.equal(new URL(url).origin, new URL(publicEndpoint).origin);
  const wrongType = await fetch(url, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes });
  assert.equal(wrongType.status, 403);
  const ok = await fetch(url, { method: "PUT", headers: { "content-type": "text/plain" }, body: bytes });
  assert.equal(ok.status, 200);
  assert.equal(await headChatFileObjectSize(putKey), bytes.byteLength);
});
