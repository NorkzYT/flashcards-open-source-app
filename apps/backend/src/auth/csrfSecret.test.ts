import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetStandaloneBackendCsrfSecretForTests } from "./csrfSecret";
import { enforceGuestCookieCsrfProtection, getSessionCsrfToken, type RequestAuthInputs } from "./requestSecurity";

// Module boundary: a standalone API signs and checks browser CSRF tokens with the mounted
// per-instance file, never Secrets Manager, and refuses to start without it.
const origin = "https://app.example.test";
const saved = { ...process.env };

function withEnv(env: Record<string, string | undefined>): void {
  for (const key of ["NIBOMO_DEPLOYMENT", "BACKEND_CSRF_SECRET_FILE", "BACKEND_CSRF_SECRET_ARN"]) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  resetStandaloneBackendCsrfSecretForTests();
}

function secretFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "csrf-secret-")), "backend_csrf_secret");
  writeFileSync(path, content);
  return path;
}

function guestInputs(guestSessionToken: string, csrfTokenHeader: string): RequestAuthInputs {
  return {
    authorizationHeader: undefined, sessionToken: undefined, guestSessionToken, csrfTokenHeader,
    originHeader: origin, refererHeader: undefined, secFetchSiteHeader: "same-site",
  };
}

test.afterEach(() => {
  process.env = { ...saved };
  resetStandaloneBackendCsrfSecretForTests();
});

test("standalone guest-cookie CSRF uses the mounted file and still checks token and origin", async () => {
  const secret = "a".repeat(64);
  withEnv({ NIBOMO_DEPLOYMENT: "standalone", BACKEND_CSRF_SECRET_FILE: secretFile(`${secret}\n`) });
  const token = await getSessionCsrfToken("guest-cookie");
  assert.equal(token, createHmac("sha256", secret).update("guest-cookie").digest("base64url"));
  await enforceGuestCookieCsrfProtection("POST", guestInputs("guest-cookie", token), [origin]);
  await assert.rejects(enforceGuestCookieCsrfProtection("POST", guestInputs("guest-cookie", `${token}x`), [origin]),
    { statusCode: 403, code: "SESSION_CSRF_TOKEN_INVALID" });
  await assert.rejects(enforceGuestCookieCsrfProtection("POST", guestInputs("guest-cookie", token), ["https://other.test"]),
    { statusCode: 403, message: "Origin is not allowed for session request" });
});

test("standalone refuses a missing, short or unreadable file and any Secrets Manager ARN", async () => {
  withEnv({ NIBOMO_DEPLOYMENT: "standalone" });
  await assert.rejects(getSessionCsrfToken("t"), /BACKEND_CSRF_SECRET_FILE is required/);
  withEnv({ NIBOMO_DEPLOYMENT: "standalone", BACKEND_CSRF_SECRET_FILE: secretFile("short\n") });
  await assert.rejects(getSessionCsrfToken("t"), /at least 32 characters/);
  withEnv({ NIBOMO_DEPLOYMENT: "standalone", BACKEND_CSRF_SECRET_FILE: "/nonexistent/backend_csrf_secret" });
  await assert.rejects(getSessionCsrfToken("t"), /could not be read/);
  withEnv({ NIBOMO_DEPLOYMENT: "standalone", BACKEND_CSRF_SECRET_FILE: secretFile("b".repeat(64)),
    BACKEND_CSRF_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x" });
  await assert.rejects(getSessionCsrfToken("t"), /must not be set when NIBOMO_DEPLOYMENT=standalone/);
});

test("hosted mode keeps requiring the Secrets Manager ARN and ignores a CSRF file", async () => {
  withEnv({ BACKEND_CSRF_SECRET_FILE: secretFile("c".repeat(64)) });
  await assert.rejects(getSessionCsrfToken("t"), /BACKEND_CSRF_SECRET_ARN is required/);
});
