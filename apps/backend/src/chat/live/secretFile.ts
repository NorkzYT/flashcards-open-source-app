import { readFileSync, statSync } from "node:fs";

// 256 bits as hex (setup.sh writes `openssl rand -hex 32`); anything shorter is refused.
const MIN_SECRET_LENGTH = 64;

let cached: Readonly<{ path: string; value: string }> | null = null;

/**
 * Reads the standalone live-stream HMAC secret from its mounted file once per process. The file is
 * the only source in standalone mode: there is no AWS lookup and no default.
 */
export function readStandaloneChatLiveSecretFile(path: string): string {
  if (cached !== null && cached.path === path) {
    return cached.value;
  }
  if (!statSync(path).isFile()) {
    throw new Error("CHAT_LIVE_AUTH_SECRET_FILE must name a regular file");
  }
  const value = readFileSync(path, "utf8").trim();
  if (value.length < MIN_SECRET_LENGTH || /\s/.test(value)) {
    throw new Error(`CHAT_LIVE_AUTH_SECRET_FILE must hold one secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  cached = { path, value };
  return value;
}

export function resetStandaloneChatLiveSecretCacheForTests(): void {
  cached = null;
}
