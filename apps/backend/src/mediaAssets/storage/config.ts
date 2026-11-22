import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { HttpError } from "../../shared/errors";

/**
 * `aws` is the hosted default and builds clients from the SDK default chain.
 * `rustfs` is the standalone object store, verified against RustFS 1.0.6
 * (`rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a`);
 * it never falls back to AWS endpoints or ambient AWS credentials.
 */
export type MediaAssetsStorageProfile = "aws" | "rustfs";

export type MediaAssetsStorageConfig = Readonly<{
  bucketName: string;
  profile: MediaAssetsStorageProfile;
}>;

type RustfsEndpointConfig = Readonly<{
  privateEndpoint: string;
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

export const uploadUrlExpiresSeconds = 15 * 60;
export const downloadUrlExpiresSeconds = 60 * 60;
export const multipartUploadExpiresSeconds = 24 * 60 * 60;

const storageProfileEnvName = "MEDIA_ASSETS_STORAGE_PROFILE";
const rustfsEnvNames = {
  privateEndpoint: "MEDIA_ASSETS_S3_ENDPOINT",
  publicEndpoint: "MEDIA_ASSETS_S3_PUBLIC_ENDPOINT",
  region: "MEDIA_ASSETS_S3_REGION",
  accessKeyId: "MEDIA_ASSETS_S3_ACCESS_KEY_ID",
  secretAccessKey: "MEDIA_ASSETS_S3_SECRET_ACCESS_KEY",
} as const;

let mediaAssetsS3Client: S3Client | undefined;
let mediaBlobCleanupS3Client: S3Client | undefined;
let mediaAssetsPresignS3Client: S3Client | undefined;

function readOptionalEnv(envName: string): string | null {
  const value = process.env[envName];
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function getRequiredMediaAssetsEnv(envName: string): string {
  const value = readOptionalEnv(envName);
  if (value === null) {
    throw new Error(`${envName} is required for media asset storage.`);
  }

  return value;
}

/**
 * An unset profile keeps the hosted AWS behaviour, but only while no standalone
 * input is present: a half-configured standalone deployment must fail here
 * instead of silently signing requests for AWS.
 */
export function getMediaAssetsStorageProfile(): MediaAssetsStorageProfile {
  const profile = readOptionalEnv(storageProfileEnvName);
  if (profile === "aws" || profile === "rustfs") {
    if (profile === "aws") {
      assertNoStandaloneStorageEnv(profile);
    }
    return profile;
  }
  if (profile !== null) {
    throw new Error(
      `${storageProfileEnvName} must be "aws" or "rustfs" for media asset storage. value=${profile}`,
    );
  }

  assertNoStandaloneStorageEnv("unset");
  return "aws";
}

function assertNoStandaloneStorageEnv(profile: string): void {
  const presentNames = Object.values(rustfsEnvNames)
    .filter((envName) => readOptionalEnv(envName) !== null);
  if (presentNames.length > 0) {
    throw new Error(
      `${storageProfileEnvName}=${profile} conflicts with standalone media storage inputs ${presentNames.join(",")}; set ${storageProfileEnvName}=rustfs or remove them.`,
    );
  }
}

function readEndpoint(envName: string): string {
  const raw = getRequiredMediaAssetsEnv(envName);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} must be an absolute http(s) origin for media asset storage.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      `${envName} must be a bare http(s) origin without credentials, path, query, or fragment for media asset storage.`,
    );
  }

  return url.origin;
}

function getRustfsEndpointConfig(): RustfsEndpointConfig {
  return {
    privateEndpoint: readEndpoint(rustfsEnvNames.privateEndpoint),
    publicEndpoint: readEndpoint(rustfsEnvNames.publicEndpoint),
    region: getRequiredMediaAssetsEnv(rustfsEnvNames.region),
    accessKeyId: getRequiredMediaAssetsEnv(rustfsEnvNames.accessKeyId),
    secretAccessKey: getRequiredMediaAssetsEnv(rustfsEnvNames.secretAccessKey),
  };
}

export function getMediaAssetsStorageConfig(): MediaAssetsStorageConfig {
  const profile = getMediaAssetsStorageProfile();
  if (profile === "rustfs") {
    getRustfsEndpointConfig();
  }

  return {
    bucketName: getRequiredMediaAssetsEnv("MEDIA_ASSETS_S3_BUCKET_NAME"),
    profile,
  };
}

type MediaAssetsS3ClientPurpose = "private" | "public_presign";

/**
 * Builds a client for the configured profile. Private clients reach the store
 * over the internal service address; presign clients only sign URLs for the
 * browser- and phone-reachable origin and never send requests.
 */
export function createMediaAssetsS3Client(
  purpose: MediaAssetsS3ClientPurpose,
  options: Readonly<Pick<
    S3ClientConfig,
    "maxAttempts" | "requestChecksumCalculation" | "responseChecksumValidation"
  >>,
): S3Client {
  if (getMediaAssetsStorageProfile() === "aws") {
    return new S3Client({ ...options });
  }

  const endpointConfig = getRustfsEndpointConfig();
  const client = new S3Client({
    ...options,
    endpoint: purpose === "private"
      ? endpointConfig.privateEndpoint
      : endpointConfig.publicEndpoint,
    region: endpointConfig.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: endpointConfig.accessKeyId,
      secretAccessKey: endpointConfig.secretAccessKey,
    },
  });
  return purpose === "private"
    ? withRustfsFullObjectChecksumVerification(client)
    : client;
}

export function getMediaAssetsS3Client(): S3Client {
  mediaAssetsS3Client ??= createMediaAssetsS3Client("private", {});
  return mediaAssetsS3Client;
}

export function getMediaBlobCleanupS3Client(): S3Client {
  mediaBlobCleanupS3Client ??= createMediaAssetsS3Client("private", { maxAttempts: 1 });
  return mediaBlobCleanupS3Client;
}

/** On AWS the private client also signs, exactly as before this profile existed. */
export function getMediaAssetsPresignS3Client(): S3Client {
  if (getMediaAssetsStorageProfile() === "aws") {
    return getMediaAssetsS3Client();
  }

  mediaAssetsPresignS3Client ??= createMediaAssetsS3Client("public_presign", {});
  return mediaAssetsPresignS3Client;
}

/**
 * RustFS 1.0.6 omits per-part checksums from ListParts and keeps a composite
 * checksum after the normalizing self-copy. Multipart completion there is only
 * sound with the content-addressed completed-parts manifest (migration 0256) and
 * whole-object read verification, so a `rustfs` completion without the manifest
 * store is refused before any storage call.
 */
export function assertMultipartCompletionSupportedByStorageProfile(
  config: MediaAssetsStorageConfig,
  hasCompletedPartsManifestStore: boolean,
  workspaceId: string,
  mediaAssetId: string,
): void {
  if (config.profile === "rustfs" && hasCompletedPartsManifestStore === false) {
    throw new HttpError(
      501,
      [
        "Multipart media upload completion requires the completed-parts manifest store for the configured media storage profile",
        `profile=${config.profile}`,
        `workspaceId=${workspaceId}`,
        `mediaAssetId=${mediaAssetId}`,
      ].join(" "),
      "MEDIA_ASSET_MULTIPART_UNSUPPORTED_BY_STORAGE",
    );
  }
}

export function createExpiresAt(expiresSeconds: number): string {
  return new Date(Date.now() + expiresSeconds * 1_000).toISOString();
}

/** A bare 32-byte base64 SHA-256; a multipart `<digest>-<parts>` value is composite. */
function isFullObjectSha256ChecksumValue(value: string | undefined): value is string {
  return value !== undefined
    && /^[A-Za-z0-9+/]{43}=$/u.test(value)
    && Buffer.from(value, "base64").byteLength === 32;
}

function sameMetadata(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) =>
      rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

type SendOptions = Readonly<{ abortSignal?: AbortSignal }> | undefined;

/**
 * RustFS 1.0.6 stores and enforces `x-amz-checksum-sha256` but returns no
 * `ChecksumType` for single-part objects (multipart ones report `COMPOSITE`),
 * while the media proof requires `FULL_OBJECT`. For a
 * checksum-mode HEAD that reports a bare SHA-256 without a type, this reads the
 * whole object conditionally on the observed ETag, hashes every byte, and sets
 * `FULL_OBJECT` only when the length, SHA-256, content type, and user metadata
 * of that same entity match the HEAD. Any other outcome leaves `ChecksumType`
 * absent, so the existing proof checks reject the object.
 */
function withRustfsFullObjectChecksumVerification(client: S3Client): S3Client {
  const send = client.send.bind(client) as (
    command: unknown,
    options?: SendOptions,
  ) => Promise<unknown>;
  client.send = (async (command: unknown, options?: SendOptions) => {
    const output = await send(command, options);
    if (
      !(command instanceof HeadObjectCommand)
      || command.input.ChecksumMode !== "ENABLED"
    ) {
      return output;
    }

    const head = output as HeadObjectCommandOutput;
    if (
      head.ChecksumType !== undefined
      || !isFullObjectSha256ChecksumValue(head.ChecksumSHA256)
      || typeof head.ETag !== "string"
      || typeof head.ContentLength !== "number"
    ) {
      return head;
    }

    const verified = await readFullObjectSha256(
      send,
      command,
      head,
      options,
    );
    return verified ? { ...head, ChecksumType: "FULL_OBJECT" } : head;
  }) as S3Client["send"];
  return client;
}

async function readFullObjectSha256(
  send: (command: unknown, options?: SendOptions) => Promise<unknown>,
  headCommand: HeadObjectCommand,
  head: HeadObjectCommandOutput,
  options: SendOptions,
): Promise<boolean> {
  const response = await send(new GetObjectCommand({
    Bucket: headCommand.input.Bucket,
    Key: headCommand.input.Key,
    IfMatch: head.ETag,
  }), options) as Awaited<ReturnType<S3Client["send"]>> & Readonly<{
    Body?: unknown;
    ETag?: string;
    ContentType?: string;
    ContentLength?: number;
    Metadata?: Record<string, string>;
  }>;
  const body = response.Body;
  if (typeof body !== "object" || body === null || !(Symbol.asyncIterator in body)) {
    throw new Error(
      `S3 get_object did not return a readable body while verifying a full-object checksum. key=${String(headCommand.input.Key)}`,
    );
  }

  const hash = createHash("sha256");
  let sizeBytes = 0;
  const expectedSizeBytes = head.ContentLength ?? -1;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    sizeBytes += bytes.byteLength;
    if (sizeBytes > expectedSizeBytes) {
      return false;
    }
    hash.update(bytes);
  }

  return response.ETag === head.ETag
    && response.ContentType === head.ContentType
    && sizeBytes === expectedSizeBytes
    && sameMetadata(response.Metadata, head.Metadata)
    && hash.digest("base64") === head.ChecksumSHA256;
}
