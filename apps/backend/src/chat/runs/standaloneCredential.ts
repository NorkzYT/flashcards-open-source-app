import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { UserOpenAIApiKey } from "../userOpenAIApiKey";

/**
 * A standalone person's own provider key on its way from `POST /chat` to the worker. It is sealed with
 * AES-256-GCM under a key derived (HKDF-SHA256) from an operator-mounted secret file and bound by AAD to
 * the instance, run, session, user, workspace and expiry, then stored in `ai.chat_run_dispatch_credentials`
 * (0258) apart from the dispatch row. The worker can take it only inside the claim transaction, after the
 * exact dispatch lease is proved, and taking deletes it. The plaintext lives in process memory only.
 *
 * `NIBOMO_CHAT_CREDENTIAL_KEY_FILE` unset = personal keys are refused in standalone (fail closed).
 */

export const STANDALONE_CREDENTIAL_KEY_FILE_ENV = "NIBOMO_CHAT_CREDENTIAL_KEY_FILE";
export const STANDALONE_INSTANCE_ID_ENV = "NIBOMO_INSTANCE_ID";
/** Covers POST -> claim only; the worker never holds the credential past one run. */
export const STANDALONE_CREDENTIAL_TTL_MS = 10 * 60_000;

const MINIMUM_KEY_FILE_BYTES = 32;
const MAXIMUM_KEY_FILE_BYTES = 4_096;
const HKDF_SALT = "nibomo/chat-run-credential/v1";
const AAD_PREFIX = "nibomo-chat-run-credential-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type StandaloneCredentialKeyring = Readonly<{
  instanceId: string;
  keyId: string;
  /** Not enumerable, so the derived key never reaches a log or JSON body. */
  key: Buffer;
}>;

export type StandaloneCredentialBinding = Readonly<{
  runId: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
}>;

export type SealedStandaloneCredential = Readonly<{
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  expiresAt: Date;
}>;

export class StandaloneCredentialUnavailableError extends Error {
  constructor(reason: string) {
    super(`Standalone personal credential unavailable: ${reason}`);
    this.name = "StandaloneCredentialUnavailableError";
  }
}

/** Null when the operator did not enable personal keys; throws when the setting is present but unusable. */
export function readStandaloneCredentialKeyring(env: NodeJS.ProcessEnv = process.env): StandaloneCredentialKeyring | null {
  const path = env[STANDALONE_CREDENTIAL_KEY_FILE_ENV]?.trim() ?? "";
  if (path === "") return null;
  if (!isAbsolute(path)) {
    throw new Error(`${STANDALONE_CREDENTIAL_KEY_FILE_ENV} must be an absolute path to a mounted secret file`);
  }
  const instanceId = env[STANDALONE_INSTANCE_ID_ENV]?.trim() ?? "";
  if (instanceId === "" || instanceId.length > 200 || /[\u0000-\u001f\u007f]/u.test(instanceId)) {
    throw new Error(`${STANDALONE_INSTANCE_ID_ENV} must be 1 to 200 printable characters when ${STANDALONE_CREDENTIAL_KEY_FILE_ENV} is set`);
  }
  let material: Buffer;
  try {
    material = readFileSync(path);
  } catch (error) {
    // The path is configuration, not a secret; the file content never appears in an error.
    throw new Error(`${STANDALONE_CREDENTIAL_KEY_FILE_ENV} could not be read: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  if (material.length < MINIMUM_KEY_FILE_BYTES || material.length > MAXIMUM_KEY_FILE_BYTES) {
    throw new Error(`${STANDALONE_CREDENTIAL_KEY_FILE_ENV} must hold ${MINIMUM_KEY_FILE_BYTES} to ${MAXIMUM_KEY_FILE_BYTES} bytes of secret material`);
  }
  const key = Buffer.from(hkdfSync("sha256", material, HKDF_SALT, `instance:${instanceId}`, 32));
  material.fill(0);
  const keyId = createHash("sha256").update("key-id\0").update(key).digest("hex").slice(0, 16);
  const keyring = { instanceId, keyId } as { instanceId: string; keyId: string; key: Buffer };
  Object.defineProperty(keyring, "key", { value: key, enumerable: false });
  return Object.freeze(keyring);
}

function additionalData(keyring: StandaloneCredentialKeyring, binding: StandaloneCredentialBinding, expiresAt: Date): Buffer {
  return Buffer.from([
    AAD_PREFIX, keyring.instanceId, keyring.keyId, binding.runId, binding.sessionId, binding.userId,
    binding.workspaceId, expiresAt.toISOString(),
  ].join("\0"), "utf8");
}

export function sealStandaloneCredential(
  keyring: StandaloneCredentialKeyring,
  binding: StandaloneCredentialBinding,
  credential: UserOpenAIApiKey,
  now: Date,
): SealedStandaloneCredential {
  // Millisecond precision survives the timestamptz round trip, so the AAD reproduces exactly.
  const expiresAt = new Date(now.getTime() + STANDALONE_CREDENTIAL_TTL_MS);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(keyring, binding, expiresAt));
  const ciphertext = Buffer.concat([cipher.update(credential.revealRawValue(), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { keyId: keyring.keyId, nonce, ciphertext, expiresAt };
}

/** Throws `StandaloneCredentialUnavailableError` for every reason the plaintext cannot be produced. */
export function openStandaloneCredential(
  keyring: StandaloneCredentialKeyring | null,
  binding: StandaloneCredentialBinding,
  sealed: SealedStandaloneCredential | null,
  now: Date,
): UserOpenAIApiKey {
  if (keyring === null) throw new StandaloneCredentialUnavailableError(`${STANDALONE_CREDENTIAL_KEY_FILE_ENV} is not set on the worker`);
  if (sealed === null) throw new StandaloneCredentialUnavailableError("missing or expired");
  if (sealed.expiresAt.getTime() <= now.getTime()) throw new StandaloneCredentialUnavailableError("expired");
  if (sealed.keyId !== keyring.keyId) throw new StandaloneCredentialUnavailableError("sealed under a different key or instance");
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= TAG_BYTES) {
    throw new StandaloneCredentialUnavailableError("malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyring.key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(keyring, binding, sealed.expiresAt));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]);
    const value = plaintext.toString("utf8");
    plaintext.fill(0);
    return new UserOpenAIApiKey(value);
  } catch {
    throw new StandaloneCredentialUnavailableError("authentication failed");
  }
}
