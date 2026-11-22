import { readFileSync } from "node:fs";
import {
  getBackendCsrfSecret,
  getBackendCsrfSecretWithAbortSignal,
} from "../aws/secrets";

/** setup.sh writes 32 random bytes as 64 hex characters; anything shorter is not that file. */
const STANDALONE_CSRF_SECRET_MIN_LENGTH = 32;

let standaloneCsrfSecret: string | undefined;

/**
 * Same reading as chat/deployment.ts (which rejects other values at startup), kept local because
 * auth sits in entrypoints, such as direct image ingestion, that must not import chat code.
 */
export function isStandaloneDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIBOMO_DEPLOYMENT?.trim() === "standalone";
}

/**
 * The session-CSRF HMAC key of a standalone deployment: the per-instance file
 * `secrets/backend_csrf_secret` that setup.sh generates once, mounted at `BACKEND_CSRF_SECRET_FILE`.
 * Standalone never reads Secrets Manager, so a configured `BACKEND_CSRF_SECRET_ARN` is refused rather
 * than silently ignored. The API reads it at startup (entrypoints/index.ts), so a missing or short
 * file stops the process instead of failing the first browser write.
 */
export function loadStandaloneBackendCsrfSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (standaloneCsrfSecret !== undefined) {
    return standaloneCsrfSecret;
  }

  if ((env.BACKEND_CSRF_SECRET_ARN?.trim() ?? "") !== "") {
    throw new Error("BACKEND_CSRF_SECRET_ARN must not be set when NIBOMO_DEPLOYMENT=standalone; use BACKEND_CSRF_SECRET_FILE");
  }
  const path = env.BACKEND_CSRF_SECRET_FILE?.trim() ?? "";
  if (path === "") {
    throw new Error("BACKEND_CSRF_SECRET_FILE is required when NIBOMO_DEPLOYMENT=standalone (setup.sh creates secrets/backend_csrf_secret)");
  }

  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    // The fs error carries nothing secret, but the path alone says enough.
    throw new Error(`BACKEND_CSRF_SECRET_FILE ${path} could not be read`);
  }
  if (value.length < STANDALONE_CSRF_SECRET_MIN_LENGTH) {
    throw new Error(`BACKEND_CSRF_SECRET_FILE ${path} must hold at least ${STANDALONE_CSRF_SECRET_MIN_LENGTH} characters; run setup.sh`);
  }

  standaloneCsrfSecret = value;
  return value;
}

function getBackendCsrfSecretArn(): string {
  const secretArn = process.env.BACKEND_CSRF_SECRET_ARN;
  if (secretArn === undefined || secretArn.trim() === "") {
    throw new Error("BACKEND_CSRF_SECRET_ARN is required for session-based CSRF protection");
  }

  return secretArn;
}

/** Standalone: the mounted per-instance file. Hosted: the Secrets Manager secret, unchanged. */
export async function resolveBackendCsrfSecret(abortSignal: AbortSignal | null): Promise<string> {
  if (isStandaloneDeployment()) {
    abortSignal?.throwIfAborted();
    return loadStandaloneBackendCsrfSecret();
  }

  return abortSignal === null
    ? getBackendCsrfSecret(getBackendCsrfSecretArn())
    : getBackendCsrfSecretWithAbortSignal(getBackendCsrfSecretArn(), abortSignal);
}

/** Test seam: forget the cached standalone key so a test can load another file. */
export function resetStandaloneBackendCsrfSecretForTests(): void {
  standaloneCsrfSecret = undefined;
}
