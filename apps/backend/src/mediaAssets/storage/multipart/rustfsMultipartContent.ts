import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { MediaAssetObjectMetadata } from "../../types";
import {
  uploadProofLastOperationIdSha256Key,
  uploadProofMediaAssetIdKey,
  uploadProofSha256Key,
  uploadProofWorkspaceIdKey,
} from "../proof";

/**
 * What one conditional GET of a completed RustFS multipart object observed. RustFS 1.0.6
 * reports only a COMPOSITE checksum for multipart objects and cannot normalize it by
 * self-copy, so the whole-object SHA-256 is computed here from the bytes of the exact
 * entity whose ETag the caller verified. `sha256` is null once the stream exceeds
 * `maximumSizeBytes`.
 */
export type MultipartObjectContentObservation = Readonly<{
  metadata: MediaAssetObjectMetadata;
  sizeBytes: number;
  sha256: string | null;
}>;

type BodyChunk = Uint8Array | string;

function isReadableBody(value: unknown): value is AsyncIterable<BodyChunk> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value;
}

export async function readMultipartObjectContentUnderETag(
  s3Client: S3Client,
  bucketName: string,
  storageKey: string,
  eTag: string,
  maximumSizeBytes: number,
  signal: AbortSignal,
  onProgress: () => Promise<void>,
): Promise<MultipartObjectContentObservation> {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: storageKey,
    IfMatch: eTag,
  }), { abortSignal: signal });
  const body = response.Body;
  if (isReadableBody(body) === false) {
    throw new Error(
      `S3 get_object did not return a readable body for multipart verification. key=${storageKey}`,
    );
  }

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let exceeded = false;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    sizeBytes += bytes.byteLength;
    if (sizeBytes > maximumSizeBytes) {
      exceeded = true;
      break;
    }
    hash.update(bytes);
    await onProgress();
  }
  if (exceeded && "destroy" in body && typeof body.destroy === "function") {
    (body.destroy as () => void)();
  }

  return {
    metadata: {
      sizeBytes: typeof response.ContentLength === "number"
        ? response.ContentLength
        : null,
      mimeType: typeof response.ContentType === "string"
        ? response.ContentType
        : null,
      eTag: typeof response.ETag === "string" ? response.ETag : null,
      checksumSha256: null,
      checksumType: null,
      uploadProof: {
        workspaceId: response.Metadata?.[uploadProofWorkspaceIdKey] ?? null,
        mediaAssetId: response.Metadata?.[uploadProofMediaAssetIdKey] ?? null,
        lastOperationIdSha256:
          response.Metadata?.[uploadProofLastOperationIdSha256Key] ?? null,
        sha256: response.Metadata?.[uploadProofSha256Key] ?? null,
      },
    },
    sizeBytes,
    sha256: exceeded ? null : hash.digest("hex"),
  };
}

/** Throttles a lease renewal to at most once per interval while a large object streams. */
export function createThrottledProgress(
  renew: () => Promise<void>,
  intervalMs: number,
  nowFn: () => number,
): () => Promise<void> {
  let lastRenewedAtMs = nowFn();
  return async () => {
    const nowMs = nowFn();
    if (nowMs - lastRenewedAtMs < intervalMs) return;
    lastRenewedAtMs = nowMs;
    await renew();
  };
}
