#!/usr/bin/env node
// Acceptance smoke for a standalone stack through public contracts only: email OTP (browser and
// agent flows) read from the development mailbox with a fresh address per sign-in, refresh-token
// rotation and reuse detection, browser cookie rotation, logout ending the issued ID token, fail-closed
// checks, an agent create -> review -> idempotent retry loop on the FSRS schedule, and a real media
// upload: a two-part PNG through backend-signed multipart part URLs on the media host, completion,
// and a byte-exact signed download. Run it only against a test project that uses compose.devmail.yml;
// it creates real fixture data (synthetic addresses, random pixels). It never prints tokens, keys or
// signed URLs.
//
//   SMOKE_GATEWAY=https://127.0.0.1:8443 SMOKE_CA_FILE=<test CA PEM> SMOKE_BASE_DOMAIN=study.example.com \
//   SMOKE_MAILBOX=http://127.0.0.1:18025 SMOKE_EMAIL_DOMAIN=<allowlisted test domain> node smoke.mjs
//
// SMOKE_GATEWAY is the address actually dialled (http or https). Each request carries the public Host
// it is meant for (app./auth./api./media. or SMOKE_*_HOST) and, over https, the same name as TLS SNI;
// the certificate must verify for that name against SMOKE_CA_FILE (or the system store when unset).
// There is no option to skip verification. Without SMOKE_GATEWAY, SMOKE_AUTH_URL and SMOKE_API_URL
// (ending in /v1) address services directly and signed media URLs are dialled as issued.
// SMOKE_MEDIA=0 skips the media section (stacks without object storage).
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { deflateSync } from "node:zlib";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is refused: supply the test CA with SMOKE_CA_FILE");
}

const emailDomain = () => env("SMOKE_EMAIL_DOMAIN");
const freshEmail = () => `smoke-${randomUUID().slice(0, 8)}@${emailDomain()}`.toLowerCase();
// A fresh address per run under an allowlisted test domain: the per-email OTP throttle would
// otherwise (correctly) suppress repeated runs. SMOKE_EMAIL pins the primary address instead.
const email = (process.env.SMOKE_EMAIL ?? freshEmail()).toLowerCase();
const mailbox = env("SMOKE_MAILBOX");
const gateway = process.env.SMOKE_GATEWAY ?? "";
// Requests carry the configured public Host names: the services refuse cookies and routes for others.
const baseDomain = env("SMOKE_BASE_DOMAIN");
const authUrl = gateway === "" ? env("SMOKE_AUTH_URL") : `${gateway}`;
const apiUrl = gateway === "" ? env("SMOKE_API_URL") : `${gateway}/v1`;
const authHost = process.env.SMOKE_AUTH_HOST ?? `auth.${baseDomain}`;
const apiHost = process.env.SMOKE_API_HOST ?? `api.${baseDomain}`;
const appOrigin = `https://${process.env.SMOKE_APP_HOST ?? `app.${baseDomain}`}`;
const mediaHost = process.env.SMOKE_MEDIA_HOST ?? `media.${baseDomain}`;
const caFile = process.env.SMOKE_CA_FILE;
const ca = caFile === undefined || caFile === "" ? undefined : readFileSync(caFile);

const redact = (text) => String(text)
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
  .replace(/fca_[A-Za-z0-9_-]+/g, "fca_<redacted>")
  .replace(/("(?:refreshToken|idToken|apiKey|otpSessionToken|csrfToken|code)"\s*:\s*")[^"]*/g, "$1<redacted>")
  .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"]*/gi, "$1<redacted>")
  .replace(/(uploadId=)[^&\s"]*/g, "$1<redacted>");

// `url` names the logical target (its host is the public Host). With a gateway, the connection goes
// to the gateway address instead, keeping that Host and using it as SNI.
function request(url, { method = "GET", host, headers = {}, body, raw } = {}) {
  const target = new URL(url);
  const publicHost = host ?? target.host;
  const dial = gateway === "" ? target : new URL(gateway);
  const transport = dial.protocol === "https:" ? https : http;
  const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: dial.protocol,
      hostname: dial.hostname,
      port: dial.port || (dial.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        host: publicHost,
        ...(payload === undefined ? {} : { "content-length": payload.length }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(dial.protocol === "https:" ? { servername: publicHost.replace(/:\d+$/, ""), ...(ca === undefined ? {} : { ca }) } : {}),
      timeout: 60_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, bytes, text: redact(text), json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${target.pathname}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const authPath = (path) => (gateway === "" ? `${authUrl}${path}` : `http://${authHost}${path}`);
const apiPath = (path) => (gateway === "" ? `${apiUrl}${path}` : `http://${apiHost}/v1${path}`);
const auth = (path, options = {}) => request(authPath(path), { ...options, host: authHost });
const api = (path, options = {}) => request(apiPath(path), { ...options, host: apiHost });
const mailboxGet = (path) => new Promise((resolve, reject) => {
  // The development mailbox is a separate loopback service, never routed through the gateway.
  const target = new URL(`${mailbox}${path}`);
  (target.protocol === "https:" ? https : http).get(target, { timeout: 30_000, ...(ca === undefined ? {} : { ca }) }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (error) { reject(error); } });
  }).on("error", reject);
});
const step = (name) => console.log(`- ${name}`);

async function latestCode(sentAfter, address = email) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const list = await mailboxGet("/api/v1/messages?limit=50");
    assert.equal(list.status, 200, "development mailbox API reachable");
    const message = (list.json.messages ?? []).find((item) =>
      item.To?.some((to) => to.Address?.toLowerCase() === address) && Date.parse(item.Created) >= sentAfter);
    if (message !== undefined) {
      const full = await mailboxGet(`/api/v1/message/${message.ID}`);
      const match = /sign-in code is (\d{8})/.exec(full.json.Text ?? "");
      assert.ok(match, "mail carries an 8-digit code");
      return match[1];
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("no sign-in mail arrived (the per-email OTP throttle suppresses repeated sends; use a fresh address)");
}

const bearerOf = (token) => ({ authorization: `Bearer ${token}` });
const setCookies = (response) => {
  const value = response.headers["set-cookie"];
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]);
};
const cookieValue = (response, name) => {
  const line = setCookies(response).find((item) => item.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  const value = line.slice(name.length + 1).split(";")[0];
  return value === "" ? undefined : value;
};

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The server derives a workspace replica id from `${workspaceId}:${installationId}` this way.
function uuidFromSeed(seed) {
  const hex = sha256Hex(seed).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return [joined.slice(0, 8), joined.slice(8, 12), joined.slice(12, 16), joined.slice(16, 20), joined.slice(20)].join("-");
}

// A decodable PNG of random RGB pixels (stored, not compressed) just over one 5 MiB part, so the
// upload uses two parts and the bytes are not compressible by any layer in between.
function fixturePng() {
  const width = 1400;
  const height = 1260;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0]), randomBytes(width * 3));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function browserSignIn(address) {
  const sentAfter = Date.now() - 1_000;
  const sent = await auth("/api/send-code", { method: "POST", body: { email: address } });
  assert.equal(sent.status, 200, sent.text);
  const code = await latestCode(sentAfter, address);
  const verified = await auth("/api/verify-code", {
    method: "POST", body: { code, csrfToken: sent.json.csrfToken, otpSessionToken: sent.json.otpSessionToken },
  });
  assert.equal(verified.status, 200, verified.text);
  assert.ok(typeof verified.json.idToken === "string" && typeof verified.json.refreshToken === "string", "sign-in returns tokens");
  return verified;
}

async function main() {
  step("readiness");
  const health = await api("/health");
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json.status, "ok");
  if (gateway !== "") {
    const unknown = await request(apiPath("/health"), { host: "unknown.invalid" }).catch((error) => ({ status: `tls:${error.code ?? error.message}` }));
    // Plain HTTP answers 421; a TLS listener may instead refuse the handshake for an unknown SNI.
    assert.ok(unknown.status === 421 || String(unknown.status).startsWith("tls:"), `gateway refuses unknown hosts: ${unknown.status}`);
  }

  step("unauthenticated and forged credentials fail closed");
  assert.equal((await api("/me")).status, 401);
  assert.equal((await api("/me", { headers: { authorization: "Bearer not-a-jwt" } })).status, 401);
  assert.equal((await api("/agent/me", { headers: { authorization: "ApiKey fca_invalid" } })).status, 401);

  step("browser-style email OTP sign-in, /me");
  const signInA = await browserSignIn(email);
  const meA = await api("/me", { headers: bearerOf(signInA.json.idToken) });
  assert.equal(meA.status, 200, meA.text);

  step("refresh rotates the token; an in-grace retry is idempotent; reuse revokes the family");
  const rt0 = signInA.json.refreshToken;
  const r1 = await auth("/api/refresh-token", { method: "POST", body: { refreshToken: rt0 } });
  assert.equal(r1.status, 200, r1.text);
  assert.ok(typeof r1.json.refreshToken === "string" && r1.json.refreshToken !== rt0, "refresh returns a new refresh token");
  assert.equal((await api("/me", { headers: bearerOf(r1.json.idToken) })).status, 200);
  const r1Retry = await auth("/api/refresh-token", { method: "POST", body: { refreshToken: rt0 } });
  assert.equal(r1Retry.status, 200, r1Retry.text);
  assert.ok(r1Retry.json.refreshToken === r1.json.refreshToken, "retry within grace returns the same successor");
  const r2 = await auth("/api/refresh-token", { method: "POST", body: { refreshToken: r1.json.refreshToken } });
  assert.equal(r2.status, 200, r2.text);
  assert.ok(r2.json.refreshToken !== r1.json.refreshToken, "second refresh rotates again");
  assert.equal((await api("/me", { headers: bearerOf(r2.json.idToken) })).status, 200);
  const reuse = await auth("/api/refresh-token", { method: "POST", body: { refreshToken: rt0 } });
  assert.equal(reuse.status, 401, "a token whose successor already rotated is refused");
  assert.equal((await auth("/api/refresh-token", { method: "POST", body: { refreshToken: r2.json.refreshToken } })).status, 401,
    "reuse revoked the whole family (current token refused)");
  assert.equal((await api("/me", { headers: bearerOf(r2.json.idToken) })).status, 401, "reuse ends the family's ID tokens");
  assert.equal((await api("/me", { headers: bearerOf(signInA.json.idToken) })).status, 401, "reuse ends the original ID token");

  step("browser cookie refresh rotates a Secure refresh cookie; logout ends old and new ID tokens");
  const signInB = await browserSignIn(freshEmail());
  const cookieRt0 = cookieValue(signInB, "refresh");
  assert.ok(cookieRt0 !== undefined, "sign-in sets the refresh cookie");
  const cookieRefresh = await auth("/api/refresh-session", { method: "POST", headers: { origin: appOrigin, cookie: `refresh=${cookieRt0}` } });
  assert.equal(cookieRefresh.status, 200, cookieRefresh.text);
  const cookieRt1 = cookieValue(cookieRefresh, "refresh");
  const cookieSession = cookieValue(cookieRefresh, "session");
  assert.ok(cookieRt1 !== undefined && cookieRt1 !== cookieRt0, "refresh-session rotates the refresh cookie");
  const refreshCookieHeader = setCookies(cookieRefresh).find((line) => line.startsWith("refresh="));
  assert.ok(/;\s*Secure/i.test(refreshCookieHeader) && /;\s*HttpOnly/i.test(refreshCookieHeader), "refresh cookie is Secure and HttpOnly");
  assert.equal((await api("/me", { headers: bearerOf(cookieSession) })).status, 200);
  const logout = await auth("/api/revoke-token", { method: "POST", body: { refreshToken: cookieRt1 } });
  assert.equal(logout.status, 200, logout.text);
  assert.equal((await api("/me", { headers: bearerOf(signInB.json.idToken) })).status, 401, "logout ends the sign-in ID token");
  assert.equal((await api("/me", { headers: bearerOf(cookieSession) })).status, 401, "logout ends the refreshed ID token");
  assert.equal((await auth("/api/refresh-token", { method: "POST", body: { refreshToken: cookieRt1 } })).status, 401,
    "revoked refresh token is refused");
  assert.equal((await auth("/api/refresh-session", { method: "POST", headers: { origin: appOrigin, cookie: `refresh=${cookieRt1}` } })).status, 401,
    "revoked refresh cookie is refused");

  step("agent sign-in issues an API key bound to the same account");
  let sentAfter = Date.now() - 1_000;
  const agentSent = await auth("/api/agent/send-code", { method: "POST", body: { email } });
  assert.equal(agentSent.status, 200, agentSent.text);
  const agentCode = await latestCode(sentAfter);
  const agentVerified = await auth("/api/agent/verify-code", {
    method: "POST", body: { code: agentCode, otpSessionToken: agentSent.json.data.otpSessionToken, label: "selfhost smoke" },
  });
  assert.equal(agentVerified.status, 200, agentVerified.text);
  const key = { authorization: `ApiKey ${agentVerified.json.data.apiKey}` };
  const workspaces = await api("/agent/workspaces?limit=100", { headers: key });
  assert.equal(workspaces.status, 200, workspaces.text);
  let workspaceId = workspaces.json.data.workspaces?.[0]?.workspaceId;
  if (workspaceId === undefined) {
    const created = await api("/agent/workspaces", { method: "POST", headers: key, body: { name: "Smoke" } });
    assert.equal(created.status, 200, created.text);
    workspaceId = created.json.data.workspace.workspaceId;
  }
  const selected = await api(`/agent/workspaces/${workspaceId}/select`, { method: "POST", headers: key });
  assert.equal(selected.status, 200, selected.text);

  step("create a card, review it, retry the same reviewId");
  const marker = `smoke-${randomUUID().slice(0, 8)}`;
  const inserted = await api("/agent/sql/execute", {
    method: "POST", headers: key,
    body: { sql: `INSERT INTO cards (front_text, back_text, tags) VALUES ('Capital of the fixture country ${marker}?', 'Fixtureville', ('${marker}')) RETURNING card_id` },
  });
  assert.equal(inserted.status, 200, inserted.text);
  const next = await api("/agent/reviews/next", { method: "POST", headers: key, body: { workspaceId, tags: [marker] } });
  assert.equal(next.status, 200, next.text);
  const card = next.json.data.card;
  assert.ok(card !== null && card.frontText.includes(marker), next.text);
  const reveal = await api("/agent/reviews/reveal", { method: "POST", headers: key, body: { workspaceId, cardId: card.cardId } });
  assert.equal(reveal.status, 200, reveal.text);
  assert.equal(reveal.json.data.backText, "Fixtureville");
  const submission = { workspaceId, cardId: card.cardId, reviewId: randomUUID(), rating: "Good", reviewedTimeZone: "UTC" };
  const first = await api("/agent/reviews/submit", { method: "POST", headers: key, body: submission });
  assert.equal(first.status, 200, first.text);
  const retry = await api("/agent/reviews/submit", { method: "POST", headers: key, body: submission });
  assert.ok(retry.status === 200 || retry.status === 409, retry.text);
  const count = await api("/agent/sql/query", {
    method: "POST", headers: key,
    body: { sql: `SELECT count(*) AS reviews FROM review_events WHERE card_id = '${card.cardId}'` },
  });
  assert.equal(count.status, 200, count.text);
  assert.equal(JSON.stringify(count.json.data).includes("\"reviews\":1"), true, `exactly one review event: ${count.text}`);

  let mediaAssetId = null;
  if (process.env.SMOKE_MEDIA !== "0") {
    step("media: two-part PNG through signed multipart part URLs, completion, byte-exact signed download");
    const installationId = randomUUID();
    const replicaId = uuidFromSeed(`${workspaceId}:${installationId}`);
    const pull = await api(`/workspaces/${workspaceId}/sync/pull`, {
      method: "POST", headers: key,
      body: { installationId, platform: "web", isAutomation: true, afterHotChangeId: 0, limit: 1 },
    });
    assert.equal(pull.status, 200, pull.text);
    const image = fixturePng();
    const partSizeBytes = 5 * 1024 * 1024;
    const parts = [image.subarray(0, partSizeBytes), image.subarray(partSizeBytes)];
    assert.equal(parts.length, 2);
    mediaAssetId = randomUUID();
    const now = new Date().toISOString();
    const created = await api(`/workspaces/${workspaceId}/media-assets/upload-sessions`, {
      method: "POST", headers: key,
      body: {
        mediaAssetId, mimeType: "image/png", sizeBytes: image.length, sha256: sha256Hex(image),
        partSizeBytes, partCount: parts.length, sourceUrl: null, createdAt: now, clientUpdatedAt: now,
        lastModifiedByReplicaId: replicaId, lastOperationId: randomUUID(),
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.status, "upload_required", created.text);
    const sessionId = created.json.uploadSession.sessionId;
    const sessionPath = `/workspaces/${workspaceId}/media-assets/upload-sessions/${sessionId}`;
    const partUrls = await api(`${sessionPath}/parts`, {
      method: "POST", headers: key,
      body: { parts: parts.map((part, index) => ({ partNumber: index + 1, sha256: sha256Hex(part) })) },
    });
    assert.equal(partUrls.status, 200, partUrls.text);
    const completedParts = [];
    for (const [index, part] of parts.entries()) {
      const signed = partUrls.json.partUrls.find((item) => item.partNumber === index + 1);
      assert.ok(signed !== undefined && signed.method === "PUT", `part ${index + 1} URL issued`);
      const signedUrl = new URL(signed.url);
      assert.equal(signedUrl.hostname, mediaHost.replace(/:\d+$/, ""), "part URL is signed for the public media host");
      if (index === 0) {
        // The gateway admits only the part upload itself; the same signed URL used for another
        // multipart call (POST = complete shape) is refused before the store.
        const misuse = await request(signed.url, { method: "POST", headers: signed.headers });
        assert.equal(misuse.status, 403, `gateway refuses non-PUT use of a part URL: ${misuse.status}`);
      }
      const put = await request(signed.url, { method: "PUT", headers: { ...signed.headers, origin: appOrigin }, raw: part });
      assert.equal(put.status, 200, `part ${index + 1} upload: ${put.status} ${put.text.slice(0, 300)}`);
      assert.equal(put.headers["access-control-allow-origin"], appOrigin, "part response is readable by the web app");
      assert.ok(/etag/i.test(put.headers["access-control-expose-headers"] ?? ""), "ETag exposed to the web app");
      assert.ok(typeof put.headers.etag === "string" && put.headers.etag !== "", "part ETag returned");
      completedParts.push({ partNumber: index + 1, eTag: put.headers.etag, sha256: sha256Hex(part) });
    }
    const completed = await api(`${sessionPath}/complete`, { method: "POST", headers: key, body: { parts: completedParts } });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(completed.json.applied, true, completed.text);
    assert.equal(completed.json.mediaAsset.sha256, sha256Hex(image));
    assert.equal(completed.json.mediaAsset.sizeBytes, image.length);
    const replay = await api(`${sessionPath}/complete`, { method: "POST", headers: key, body: { parts: completedParts } });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.applied, false, "completion replay is idempotent");
    const download = await api(`/workspaces/${workspaceId}/media-assets/${mediaAssetId}/download-url`, { headers: key });
    assert.equal(download.status, 200, download.text);
    assert.equal(new URL(download.json.download.url).hostname, mediaHost.replace(/:\d+$/, ""), "download URL is signed for the media host");
    const fetched = await request(download.json.download.url, { method: "GET", headers: { origin: appOrigin } });
    assert.equal(fetched.status, 200, `download: ${fetched.status}`);
    assert.equal(fetched.bytes.length, image.length, "downloaded length");
    assert.equal(sha256Hex(fetched.bytes), sha256Hex(image), "downloaded bytes are the uploaded image");
    assert.equal(fetched.headers["access-control-allow-origin"], appOrigin);
  }

  if (process.env.SMOKE_EMAIL === undefined) {
    step("a second account cannot use the first account's workspace");
    const other = freshEmail();
    const otherSentAfter = Date.now() - 1_000;
    const otherSent = await auth("/api/agent/send-code", { method: "POST", body: { email: other } });
    assert.equal(otherSent.status, 200, otherSent.text);
    const otherCode = await latestCode(otherSentAfter, other);
    const otherVerified = await auth("/api/agent/verify-code", {
      method: "POST", body: { code: otherCode, otpSessionToken: otherSent.json.data.otpSessionToken, label: "selfhost smoke isolation" },
    });
    assert.equal(otherVerified.status, 200, otherVerified.text);
    const otherKey = { authorization: `ApiKey ${otherVerified.json.data.apiKey}` };
    const foreignSelect = await api(`/agent/workspaces/${workspaceId}/select`, { method: "POST", headers: otherKey });
    assert.ok(foreignSelect.status >= 400 && foreignSelect.status < 500, `foreign select refused: ${foreignSelect.status}`);
    const foreignReveal = await api("/agent/reviews/reveal", { method: "POST", headers: otherKey, body: { workspaceId, cardId: card.cardId } });
    assert.ok(foreignReveal.status >= 400 && foreignReveal.status < 500, `foreign reveal refused: ${foreignReveal.status}`);
    assert.equal(foreignReveal.text.includes("Fixtureville"), false);
    if (mediaAssetId !== null) {
      const foreignDownload = await api(`/workspaces/${workspaceId}/media-assets/${mediaAssetId}/download-url`, { headers: otherKey });
      assert.ok(foreignDownload.status >= 400 && foreignDownload.status < 500, `foreign media download refused: ${foreignDownload.status}`);
      assert.equal(foreignDownload.text.includes("X-Amz-"), false);
    }
  }

  console.log("SMOKE PASS");
}

main().catch((error) => {
  console.error(`SMOKE FAIL: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
