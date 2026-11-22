import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Standalone identity boundary (docs/self-hosting.md): the real auth routes with
 * AUTH_IDENTITY_PROVIDER=local against migrated PostgreSQL as auth_app, a local SMTP sink, and the
 * backend AUTH_MODE=local verifier. Synthetic @fixture.nibomo-selfhost.lan fixture accounts only.
 */

type MailSink = Readonly<{ server: Server; port: number; messages: Array<string> }>;

/** Minimal SMTP receiver for the plaintext development-mailbox profile. */
async function startMailSink(): Promise<MailSink> {
  const messages: Array<string> = [];
  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let data = "";
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(data);
            data = "";
            socket.write("250 queued\r\n");
          } else {
            data += `${line}\n`;
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write("250 sink\r\n");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
        index = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("SMTP sink did not bind");
  return { server, port: address.port, messages };
}

function foreignToken(issuer: string, audience: string): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "foreign" })).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const body = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: "00000000-0000-4000-8000-000000000000", token_use: "id",
    email: "intruder@fixture.nibomo-selfhost.lan", auth_time: now, iat: now, exp: now + 600,
  })).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}

test("standalone local identity issues, refreshes and revokes deployment-bound sessions", async () => {
  const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const backendUrl = process.env.DATABASE_URL;
  if (ownerUrl === undefined || backendUrl === undefined) throw new Error("TEST_DATABASE_ADMIN_URL and DATABASE_URL are required");
  const owner = new pg.Client({ connectionString: ownerUrl });
  const backend = new pg.Client({ connectionString: backendUrl });
  const sink = await startMailSink();
  const logged: Array<string> = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const savedEnv = { ...process.env };
  try {
    await owner.connect();
    await backend.connect();
    const authPassword = randomBytes(24).toString("hex");
    await owner.query(`ALTER ROLE auth_app WITH LOGIN PASSWORD '${authPassword}'`);
    const authUrl = new URL(ownerUrl);
    authUrl.username = "auth_app";
    authUrl.password = authPassword;

    const keyDirectory = mkdtempSync(join(tmpdir(), "nibomo-local-identity-"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePath = join(keyDirectory, "signing.pem");
    const publicPath = join(keyDirectory, "signing.pub.pem");
    writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));

    // The backend verifier's pool must connect as backend_app (the harness DATABASE_URL); the auth app
    // below gets auth_app. Both pools bind their URL on first use.
    const { unsafeQuery } = await import("../database/unsafe");
    const backendRole = await unsafeQuery<{ role: string }>("SELECT current_user AS role", []);
    assert.equal(backendRole.rows[0]?.role, "backend_app");

    const issuer = "https://auth.study.example.test";
    const audience = `client_${randomBytes(12).toString("hex")}`;
    Object.assign(process.env, {
      AUTH_IDENTITY_PROVIDER: "local",
      AUTH_MODE: "local",
      DATABASE_URL: authUrl.toString(),
      SESSION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      LOCAL_AUTH_ISSUER: issuer,
      LOCAL_AUTH_CLIENT_ID: audience,
      LOCAL_AUTH_SIGNING_KEY_FILE: privatePath,
      LOCAL_AUTH_PUBLIC_KEY_FILE: publicPath,
      LOCAL_AUTH_ALLOWED_EMAILS: "learner@fixture.nibomo-selfhost.lan,second@fixture.nibomo-selfhost.lan,third@fixture.nibomo-selfhost.lan",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(sink.port),
      SMTP_TLS_MODE: "none",
      LOCAL_AUTH_DEV_MAILBOX: "true",
      SMTP_FROM: "Nibomo <no-reply@fixture.nibomo-selfhost.lan>",
      ALLOWED_REDIRECT_URIS: "https://study.example.test",
    });
    console.log = (...values: Array<unknown>) => { logged.push(values.map(String).join(" ")); };
    console.warn = (...values: Array<unknown>) => { logged.push(values.map(String).join(" ")); };

    const authRoot = resolve(__dirname, "../../../auth/src");
    const { createApp } = await import(pathToFileURL(join(authRoot, "app.ts")).href) as Readonly<{
      createApp: (basePath: string) => Readonly<{ fetch: (request: Request) => Promise<Response> }>;
    }>;
    const { localIdTokenVerifier } = await import("./localIdentityVerifier");
    const app = createApp("/");
    const post = async (path: string, body: unknown): Promise<Readonly<{ status: number; json: Record<string, unknown> }>> => {
      const response = await app.fetch(new Request(`${issuer}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify(body),
      }));
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    };
    // Mail is sent after the response, so its timing cannot reveal which addresses may sign in.
    const waitForMessages = async (count: number): Promise<void> => {
      for (let attempt = 0; attempt < 50 && sink.messages.length < count; attempt += 1) {
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    const codeFrom = (message: string): string => {
      const match = /sign-in code is (\d{8})/.exec(message);
      assert.ok(match, "mail carries an 8-digit code");
      return match[1] as string;
    };

    // Allowed account: one mail, wrong code rejected and counted, right code issues tokens once.
    const sent = await post("/api/send-code", { email: "learner@fixture.nibomo-selfhost.lan" });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    await waitForMessages(1);
    assert.equal(sink.messages.length, 1);
    const code = codeFrom(sink.messages[0] as string);
    const wrongCode = code === "00000000" ? "11111111" : "00000000";
    const verifyBody = { csrfToken: sent.json.csrfToken, otpSessionToken: sent.json.otpSessionToken };
    const wrong = await post("/api/verify-code", { ...verifyBody, code: wrongCode });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, "OTP_CODE_INVALID");
    const verified = await post("/api/verify-code", { ...verifyBody, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    const idToken = verified.json.idToken as string;
    const refreshToken = verified.json.refreshToken as string;
    const claims = await localIdTokenVerifier.verify(idToken);
    assert.equal(claims.email, "learner@fixture.nibomo-selfhost.lan");
    assert.equal(claims.iss, issuer);
    assert.equal(claims.aud, audience);
    const replay = await post("/api/verify-code", { ...verifyBody, code });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.code, "OTP_CHALLENGE_CONSUMED");

    // Only digests are stored; the backend role cannot read identity secrets.
    const stored = await owner.query<{ code_hmac: string; failed_attempts: number }>(
      "SELECT code_hmac, failed_attempts FROM auth.local_email_otp_challenges WHERE email = $1", ["learner@fixture.nibomo-selfhost.lan"]);
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0]?.code_hmac, code);
    assert.equal(stored.rows[0]?.failed_attempts, 1);
    await assert.rejects(backend.query("SELECT 1 FROM auth.local_refresh_tokens"), { code: "42501" });

    const sessionStatus = async (familyId: unknown, subject: string, iss = issuer, aud = audience): Promise<string> => {
      const result = await backend.query<{ status: string }>(
        "SELECT auth.local_session_status($1, $2, $3, $4) AS status", [familyId, subject, iss, aud]);
      return result.rows[0]?.status as string;
    };
    const backendRejects = async (token: string): Promise<void> => {
      await assert.rejects(localIdTokenVerifier.verify(token), (error: unknown) =>
        (error as { code?: string }).code === "SESSION_REVOKED");
    };

    // ID tokens carry a session family and jti; the backend role may only ask for its status.
    assert.match(String(claims.sid), /^[0-9a-f-]{36}$/);
    assert.match(String(claims.jti), /^[0-9a-f-]{36}$/);
    assert.equal(await sessionStatus(claims.sid, claims.sub), "valid");
    assert.equal(await sessionStatus(claims.sid, claims.sub, "https://other.example.test"), "revoked");
    assert.equal(await sessionStatus(claims.sid, claims.sub, issuer, `${audience}x`), "revoked");
    assert.equal(await sessionStatus(claims.sid, "00000000-0000-4000-8000-000000000000"), "revoked");
    await assert.rejects(backend.query("SELECT 1 FROM auth.local_session_families"), { code: "42501" });

    // Refresh rotates (Cognito rotation wire shape: `refreshToken` present) and keeps sid/auth_time.
    const refreshed = await post("/api/refresh-token", { refreshToken });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    const rotated = refreshed.json.refreshToken as string;
    assert.match(rotated, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotated, refreshToken);
    const refreshedClaims = await localIdTokenVerifier.verify(refreshed.json.idToken as string);
    assert.equal(refreshedClaims.sub, claims.sub);
    assert.equal(refreshedClaims.sid, claims.sid);
    assert.equal(refreshedClaims.auth_time, claims.auth_time);
    assert.notEqual(refreshedClaims.jti, claims.jti);

    // Concurrent refreshes and a lost-response retry of one token (within the grace) get the same
    // successor, so whichever response a client stores stays valid; no second live token is created.
    const [concurrentA, concurrentB] = await Promise.all([
      post("/api/refresh-token", { refreshToken: rotated }),
      post("/api/refresh-token", { refreshToken: rotated }),
    ]);
    assert.equal(concurrentA.status, 200, JSON.stringify(concurrentA.json));
    assert.equal(concurrentB.status, 200, JSON.stringify(concurrentB.json));
    assert.equal(concurrentA.json.refreshToken, concurrentB.json.refreshToken);
    const third = concurrentA.json.refreshToken as string;
    const retry = await post("/api/refresh-token", { refreshToken: rotated });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.refreshToken, third);
    const live = await owner.query<{ live: number }>(
      "SELECT count(*)::INT AS live FROM auth.local_refresh_tokens WHERE family_id = $1 AND rotated_at IS NULL AND revoked_at IS NULL",
      [claims.sid]);
    assert.equal(live.rows[0]?.live, 1);

    // Browser refresh stores the successor in the refresh cookie.
    const browserRefresh = await app.fetch(new Request(`${issuer}/api/refresh-session`, {
      method: "POST", headers: { cookie: `refresh=${third}`, "x-forwarded-for": "198.51.100.7" },
    }));
    assert.equal(browserRefresh.status, 200);
    const setCookies = browserRefresh.headers.getSetCookie();
    const refreshCookie = setCookies.find((value) => value.startsWith("refresh="));
    assert.ok(refreshCookie, "refresh cookie is replaced");
    const fourth = /^refresh=([^;]+)/.exec(refreshCookie)?.[1] as string;
    assert.notEqual(fourth, third);

    // Reusing a token two rotations old revokes the family: its newest refresh token and every ID
    // token already issued from it stop working before their exp, in auth and in the backend.
    const reuse = await post("/api/refresh-token", { refreshToken: rotated });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.json.code, "REFRESH_TOKEN_FAILED");
    assert.equal(await sessionStatus(claims.sid, claims.sub), "revoked");
    const afterReuse = await post("/api/refresh-token", { refreshToken: fourth });
    assert.equal(afterReuse.status, 401);
    await backendRejects(idToken);
    await backendRejects(refreshed.json.idToken as string);
    const family = await owner.query<{ revoke_reason: string }>(
      "SELECT revoke_reason FROM auth.local_session_families WHERE family_id = $1", [claims.sid]);
    assert.equal(family.rows[0]?.revoke_reason, "refresh_reuse");

    // A rotated token presented after the retry grace is reuse even if its successor is unused.
    const sentSecond = await post("/api/send-code", { email: "second@fixture.nibomo-selfhost.lan" });
    assert.equal(sentSecond.status, 200, JSON.stringify(sentSecond.json));
    await waitForMessages(2);
    const secondCode = codeFrom(sink.messages[1] as string);
    const second = await post("/api/verify-code", {
      csrfToken: sentSecond.json.csrfToken, otpSessionToken: sentSecond.json.otpSessionToken, code: secondCode });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    const secondClaims = await localIdTokenVerifier.verify(second.json.idToken as string);
    assert.notEqual(secondClaims.sid, claims.sid);
    const secondRotation = await post("/api/refresh-token", { refreshToken: second.json.refreshToken });
    assert.equal(secondRotation.status, 200);
    await owner.query(
      "UPDATE auth.local_refresh_tokens SET rotated_at = rotated_at - INTERVAL '2 minutes' WHERE family_id = $1 AND rotated_at IS NOT NULL",
      [secondClaims.sid]);
    const lateRetry = await post("/api/refresh-token", { refreshToken: second.json.refreshToken });
    assert.equal(lateRetry.status, 401);
    await backendRejects(second.json.idToken as string);

    // Logout: a fresh sign-in's ID token is accepted, then rejected immediately after revoke-token.
    const sentThird = await post("/api/send-code", { email: "third@fixture.nibomo-selfhost.lan" });
    assert.equal(sentThird.status, 200, JSON.stringify(sentThird.json));
    await waitForMessages(3);
    const third2 = await post("/api/verify-code", {
      csrfToken: sentThird.json.csrfToken, otpSessionToken: sentThird.json.otpSessionToken,
      code: codeFrom(sink.messages[2] as string) });
    assert.equal(third2.status, 200, JSON.stringify(third2.json));
    const logoutIdToken = third2.json.idToken as string;
    const logoutClaims = await localIdTokenVerifier.verify(logoutIdToken);
    const revoked = await post("/api/revoke-token", { refreshToken: third2.json.refreshToken });
    assert.equal(revoked.status, 200);
    const afterRevoke = await post("/api/refresh-token", { refreshToken: third2.json.refreshToken });
    assert.equal(afterRevoke.status, 401);
    assert.equal(afterRevoke.json.code, "REFRESH_TOKEN_FAILED");
    assert.ok((logoutClaims.exp as number) > Math.floor(Date.now() / 1_000), "token is still unexpired");
    await backendRejects(logoutIdToken);
    const { verifyLocalIdToken } = await import(pathToFileURL(join(authRoot, "server/local/localTokens.ts")).href) as Readonly<{
      verifyLocalIdToken: (token: string) => Promise<unknown>;
    }>;
    await assert.rejects(verifyLocalIdToken(logoutIdToken), { name: "PrincipalSessionError" });

    // Foreign, tampered and wrong-audience tokens fail closed.
    await assert.rejects(localIdTokenVerifier.verify(foreignToken(issuer, audience)));
    const [header, payload, signature] = idToken.split(".") as [string, string, string];
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), email: "other@fixture.nibomo-selfhost.lan" })).toString("base64url");
    await assert.rejects(localIdTokenVerifier.verify(`${header}.${tampered}.${signature}`));

    // The hosted demo bypass is off in standalone: an @example.com review address gets no session from
    // send-code (reserved domain, refused), and any demo input refuses auth and backend startup.
    const demoSend = await post("/api/send-code", { email: "review@example.com" });
    assert.equal(demoSend.status, 400, JSON.stringify(demoSend.json));
    assert.equal("idToken" in demoSend.json, false);
    const demoModule = await import(pathToFileURL(join(authRoot, "server/demoEmailAccess.ts")).href) as Readonly<{
      getDemoEmailAccessConfig: () => unknown; resetDemoEmailAccessConfigForTests: () => void;
    }>;
    const backendConfig = await import("./config");
    process.env.DEMO_EMAIL_DOSTIP = "review@example.com";
    process.env.DEMO_PASSWORD_DOSTIP = "synthetic-demo-password";
    demoModule.resetDemoEmailAccessConfigForTests();
    assert.throws(() => demoModule.getDemoEmailAccessConfig(), /must not be set when AUTH_IDENTITY_PROVIDER=local/);
    backendConfig.resetAuthConfigForTests();
    assert.throws(() => backendConfig.getAuthConfig(), /must not be set when AUTH_MODE=local/);
    delete process.env.DEMO_EMAIL_DOSTIP;
    delete process.env.DEMO_PASSWORD_DOSTIP;
    demoModule.resetDemoEmailAccessConfigForTests();
    backendConfig.resetAuthConfigForTests();

    // An address outside the allowlist gets the same response shape, no mail, and no account.
    const outsider = await post("/api/send-code", { email: "stranger@fixture.nibomo-selfhost.lan" });
    assert.equal(outsider.status, 200);
    await waitForMessages(4);
    assert.equal(sink.messages.length, 3);
    const guess = await post("/api/verify-code", {
      csrfToken: outsider.json.csrfToken, otpSessionToken: outsider.json.otpSessionToken, code: "12345678",
    });
    assert.equal(guess.status, 400);
    assert.equal(guess.json.code, "OTP_CODE_INVALID");
    const accounts = await owner.query("SELECT email FROM auth.local_identities ORDER BY email");
    assert.deepEqual(accounts.rows.map((row) => row.email), ["learner@fixture.nibomo-selfhost.lan", "second@fixture.nibomo-selfhost.lan", "third@fixture.nibomo-selfhost.lan"]);

    // Codes and refresh tokens never reach logs.
    const allLogs = logged.join("\n");
    assert.equal(allLogs.includes(code), false);
    for (const secret of [refreshToken, rotated, third, fourth]) assert.equal(allLogs.includes(secret), false);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    sink.server.close();
    await backend.end();
    await owner.query("ALTER ROLE auth_app WITH LOGIN PASSWORD NULL").catch(() => undefined);
    await owner.end();
  }
});
