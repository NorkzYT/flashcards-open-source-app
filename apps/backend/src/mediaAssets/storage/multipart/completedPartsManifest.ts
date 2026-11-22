import { createHash } from "node:crypto";
import { unsafeQuery } from "../../../database/unsafe";
import type { CompleteMediaAssetUploadPartInput } from "../../types";

/**
 * RustFS 1.0.6 ListParts carries no part SHA-256, so the immutable completed-parts
 * fingerprint (SHA-256 of this exact JSON) cannot be rebuilt from storage. The JSON is
 * kept content-addressed by that fingerprint in
 * `content.media_multipart_completed_parts_manifests` (migration 0256); reading it back
 * re-checks the digest, so a manifest can only restate the parts the durable writer
 * attempt already committed to.
 */
export type CompletedPartsManifestStore = Readonly<{
  record: (
    completedPartsFingerprint: string,
    partCount: number,
    manifest: string,
  ) => Promise<void>;
  read: (
    completedPartsFingerprint: string,
  ) => Promise<Readonly<{ partCount: number; manifest: string }> | null>;
}>;

export type CompletedPartsManifestPart = CompleteMediaAssetUploadPartInput;

const sha256Pattern = /^[0-9a-f]{64}$/u;
const printableAsciiPattern = /^[ -~]+$/u;
const maximumPartCount = 10_000;

export class CompletedPartsManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletedPartsManifestInvalidError";
  }
}

/** Exactly the JSON hashed by `createMediaAssetUploadSessionCompletedPartsFingerprint`. */
export function createCompletedPartsManifest(
  parts: ReadonlyArray<CompletedPartsManifestPart>,
): string {
  return JSON.stringify(
    [...parts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => [part.partNumber, part.eTag, part.sha256] as const),
  );
}

export function digestCompletedPartsManifest(manifest: string): string {
  return createHash("sha256").update(manifest, "utf8").digest("hex");
}

/**
 * Parses a manifest only if it hashes to the fingerprint and lists parts 1..partCount
 * in order, each with a non-empty ETag and a lowercase SHA-256.
 */
export function parseCompletedPartsManifest(
  manifest: string,
  completedPartsFingerprint: string,
  partCount: number,
): ReadonlyArray<CompletedPartsManifestPart> {
  if (
    sha256Pattern.test(completedPartsFingerprint) === false
    || printableAsciiPattern.test(manifest) === false
    || digestCompletedPartsManifest(manifest) !== completedPartsFingerprint
  ) {
    throw new CompletedPartsManifestInvalidError(
      "Completed-parts manifest does not hash to its fingerprint.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new CompletedPartsManifestInvalidError(
      "Completed-parts manifest is not JSON.",
    );
  }
  if (
    Array.isArray(parsed) === false
    || parsed.length !== partCount
    || partCount < 1
    || partCount > maximumPartCount
  ) {
    throw new CompletedPartsManifestInvalidError(
      "Completed-parts manifest has the wrong part count.",
    );
  }
  return parsed.map((entry: unknown, index): CompletedPartsManifestPart => {
    if (
      Array.isArray(entry) === false
      || entry.length !== 3
      || entry[0] !== index + 1
      || typeof entry[1] !== "string"
      || entry[1].length < 1
      || entry[1].length > 256
      || typeof entry[2] !== "string"
      || sha256Pattern.test(entry[2]) === false
    ) {
      throw new CompletedPartsManifestInvalidError(
        "Completed-parts manifest lists an invalid part.",
      );
    }
    return { partNumber: index + 1, eTag: entry[1], sha256: entry[2] };
  });
}

/** Rejects anything Postgres could not store byte-identically (the digest must survive). */
export function assertCompletedPartsManifestStorable(manifest: string): void {
  if (printableAsciiPattern.test(manifest) === false) {
    throw new CompletedPartsManifestInvalidError(
      "Completed-parts manifest must be printable ASCII.",
    );
  }
}

type RecordRow = Readonly<{ status: string }>;
type ReadRow = Readonly<{ part_count: number; manifest: string }>;

export const postgresCompletedPartsManifestStore: CompletedPartsManifestStore =
  Object.freeze({
    async record(
      completedPartsFingerprint: string,
      partCount: number,
      manifest: string,
    ): Promise<void> {
      assertCompletedPartsManifestStorable(manifest);
      const result = await unsafeQuery<RecordRow>(
        `SELECT content.record_media_multipart_completed_parts_manifest($1, $2, $3) AS status`,
        [completedPartsFingerprint, partCount, manifest],
      );
      const status = result.rows[0]?.status;
      if (status === "recorded" || status === "already_recorded") return;
      throw new CompletedPartsManifestInvalidError(
        `PostgreSQL refused the completed-parts manifest. status=${String(status)}`,
      );
    },
    async read(
      completedPartsFingerprint: string,
    ): Promise<Readonly<{ partCount: number; manifest: string }> | null> {
      const result = await unsafeQuery<ReadRow>(
        `SELECT part_count, manifest
         FROM content.read_media_multipart_completed_parts_manifest($1)`,
        [completedPartsFingerprint],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new TypeError(
          "PostgreSQL returned an invalid completed-parts manifest row count.",
        );
      }
      const row = result.rows[0];
      return { partCount: row.part_count, manifest: row.manifest };
    },
  });
