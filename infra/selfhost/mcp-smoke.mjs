#!/usr/bin/env node
// MCP + OAuth acceptance smoke for a standalone test stack, through the gateway and public contracts
// only: MCP ingress refusals, per-host metadata, OTP sign-in from the development mailbox, DCR,
// authorize/consent/token with PKCE, the id_token signature, the shared MCP study tools with an
// idempotent review retry, token host binding, concurrency limits, refresh rotation and
// cross-account isolation. Run it only against a test project that uses compose.devmail.yml; it
// creates real fixture data. Each run sends three sign-in codes, so the OTP throttles allow only a
// few runs per address and hour (use a fresh test project).
//
//   SMOKE_GATEWAY=https://127.0.0.1:8443 SMOKE_CA_FILE=<test CA PEM> SMOKE_BASE_DOMAIN=study.example.com \
//   SMOKE_MAILBOX=http://127.0.0.1:18025 SMOKE_EMAIL_DOMAIN=<allowlisted test domain> \
//   [SMOKE_MCP_ALTERNATE_HOST=<NIBOMO_MCP_ALTERNATE_HOST>] [SMOKE_MCP_ALLOWED_ORIGIN=<one listed origin>] \
//   node mcp-smoke.mjs
//
// SMOKE_GATEWAY is the address dialled, http:// (loopback gateway) or https:// (a TLS front). Over
// https each request uses its public host (auth./api./mcp. or the alternate MCP host) as SNI and Host,
// and the certificate must verify for that name against SMOKE_CA_FILE (or the system store when
// unset); there is no option to skip verification. Output masks tokens, keys, codes and cookies.
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createTransport, readCa, redact, refuseInsecureTls } from "./smoke-transport.mjs";

refuseInsecureTls();

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const gateway = env("SMOKE_GATEWAY");
const mailbox = env("SMOKE_MAILBOX");
const base = env("SMOKE_BASE_DOMAIN");
const domain = env("SMOKE_EMAIL_DOMAIN");
const altHost = process.env.SMOKE_MCP_ALTERNATE_HOST ?? "";
const listedOrigin = process.env.SMOKE_MCP_ALLOWED_ORIGIN ?? "";
const authHost = `auth.${base}`;
const apiHost = `api.${base}`;
const mcpHost = `mcp.${base}`;
const issuer = `https://${authHost}`;
const resource = `https://${mcpHost}/mcp`;
// Never fetched: the authorization code is read from the consent response.
const redirectUri = "https://client.example.org/oauth/callback";
const { request, secure } = createTransport({ gateway, ca: readCa(process.env.SMOKE_CA_FILE) });
let stepCount = 0;
const step = (name) => { stepCount += 1; console.log(`- ${name}`); };

// Logical URL on the public host; the transport dials SMOKE_GATEWAY with that Host (and SNI).
const viaGateway = (path, host, options = {}) => request(`http://${host}${path}`, { ...options, host });
const auth = (path, options = {}) => viaGateway(path, authHost, options);
const api = (path, options = {}) => viaGateway(path, apiHost, options);

// The development mailbox is a separate loopback service, never routed through the gateway.
const { request: mailboxRequest } = createTransport({ ca: readCa(process.env.SMOKE_CA_FILE) });
const mailboxGet = (path) => mailboxRequest(`${mailbox}${path}`);

async function latestCode(sentAfter, address) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await mailboxGet("/api/v1/messages?limit=50");
    const message = (list.json?.messages ?? []).find((m) =>
      m.To?.some((to) => to.Address?.toLowerCase() === address) && Date.parse(m.Created) >= sentAfter);
    if (message !== undefined) {
      const full = await mailboxGet(`/api/v1/message/${message.ID}`);
      return /sign-in code is (\d{8})/.exec(full.json.Text)[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in mail for ${address}`);
}

async function browserSignIn(email) {
  const after = Date.now() - 1000;
  // The sign-in page posts from the auth origin itself; behind TLS the service sees http://.
  const sent = await auth("/api/send-code", { method: "POST", headers: { origin: issuer }, body: { email } });
  assert.equal(sent.status, 200, sent.text);
  const code = await latestCode(after, email);
  const verified = await auth("/api/verify-code", { method: "POST", headers: { origin: issuer }, body: {
    code, csrfToken: sent.json.csrfToken, otpSessionToken: sent.json.otpSessionToken } });
  assert.equal(verified.status, 200, verified.text);
  const cookie = (verified.headers["set-cookie"] ?? []).find((value) => value.startsWith("session="));
  assert.ok(cookie, "session cookie set");
  return { idToken: verified.json.idToken, cookie: cookie.split(";")[0] };
}

async function agentKey(email) {
  const after = Date.now() - 1000;
  const sent = await auth("/api/agent/send-code", { method: "POST", body: { email } });
  assert.equal(sent.status, 200, sent.text);
  const code = await latestCode(after, email);
  const verified = await auth("/api/agent/verify-code", { method: "POST", body: {
    code, otpSessionToken: sent.json.data.otpSessionToken, label: "mcp smoke" } });
  assert.equal(verified.status, 200, verified.text);
  return verified.json.data.apiKey;
}

const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

function authorizeQuery(clientId, challenge, extra = {}) {
  return new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", scope: "openid email flashcards", resource,
    state: "st-1", nonce: "nonce-1", ...extra }).toString();
}

async function oauthCode(cookie, clientId, challenge) {
  const consent = await auth("/authorize/consent", { method: "POST", headers: { cookie, origin: issuer }, body: {
    client_id: clientId, redirect_uri: redirectUri, state: "st-1", code_challenge: challenge,
    scope: "openid email flashcards", resource, nonce: "nonce-1" } });
  assert.equal(consent.status, 200, consent.text);
  const to = new URL(consent.json.redirect_to);
  assert.equal(to.origin + to.pathname, redirectUri);
  assert.equal(to.searchParams.get("iss"), issuer);
  assert.equal(to.searchParams.get("state"), "st-1");
  return to.searchParams.get("code");
}

let rpcId = 0;
function mcp(token, method, params, { host = mcpHost, headers = {} } = {}) {
  rpcId += 1;
  return viaGateway("/mcp", host, { method: "POST", headers: {
    accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25",
    ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers,
  }, body: { jsonrpc: "2.0", id: rpcId, method, params } });
}
async function tool(token, name, args) {
  const response = await mcp(token, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200, response.text);
  return response.json.result;
}
const toolJson = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
async function queryText(token, workspaceId, sql) {
  const result = await tool(token, "sql_query", { workspaceId, sql });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.stringify(toolJson(result));
}

async function main() {
  step("MCP ingress: unknown host 421, unlisted Origin 403, token-less 401 challenge");
  if (secure) {
    // Unknown SNI: the front has no certificate for it, so verification (or the front) refuses.
    const unknownSni = await viaGateway("/mcp", "mcp.unknown.invalid", { method: "POST", body: {} })
      .then((response) => response.status, (error) => `tls:${error.code ?? error.message}`);
    assert.ok(unknownSni === 421 || String(unknownSni).startsWith("tls:"), `unknown SNI refused: ${unknownSni}`);
  }
  // Verified connection to the MCP name, unknown Host: the gateway itself must refuse it.
  const unknownHost = await viaGateway("/mcp", "mcp.unknown.invalid", { method: "POST", body: {}, servername: mcpHost });
  assert.equal(unknownHost.status, 421, unknownHost.text);
  const unlistedOrigin = await mcp(null, "initialize", {}, { headers: { origin: "https://unlisted.example.org" } });
  assert.equal(unlistedOrigin.status, 403, unlistedOrigin.text);
  const challenge = await mcp(null, "initialize", {});
  assert.equal(challenge.status, 401, challenge.text);
  assert.equal(challenge.headers["www-authenticate"],
    `Bearer resource_metadata="https://${mcpHost}/.well-known/oauth-protected-resource/mcp"`);

  step("discovery: protected-resource and AS metadata, JWKS, API discovery names the MCP URL");
  const prm = await viaGateway("/.well-known/oauth-protected-resource/mcp", mcpHost);
  assert.equal(prm.json.resource, resource);
  assert.deepEqual(prm.json.authorization_servers, [issuer]);
  if (altHost !== "") {
    const altPrm = await viaGateway("/.well-known/oauth-protected-resource", altHost);
    assert.equal(altPrm.json.resource, `https://${altHost}/mcp`);
  }
  const asMeta = await auth("/.well-known/oauth-authorization-server");
  assert.equal(asMeta.json.issuer, issuer);
  assert.deepEqual(asMeta.json.code_challenge_methods_supported, ["S256"]);
  assert.equal((await auth("/.well-known/openid-configuration")).json.issuer, issuer);
  const forged = await auth("/.well-known/oauth-authorization-server", { headers: { "x-forwarded-host": "forged.example.com" } });
  assert.equal(forged.json.issuer, issuer, "issuer ignores X-Forwarded-Host");
  const jwks = await auth("/.well-known/jwks.json");
  assert.equal(jwks.status, 200, jwks.text);
  const discovery = await api("/v1/");
  assert.equal(discovery.status, 200, discovery.text);
  assert.ok(discovery.text.includes(resource), "API discovery advertises the configured MCP URL");

  const emailA = `mcp-a-${randomUUID().slice(0, 8)}@${domain}`;
  const emailB = `mcp-b-${randomUUID().slice(0, 8)}@${domain}`;
  step("account A signs in on the auth host (browser OTP, auth Origin)");
  const sessionA = await browserSignIn(emailA);

  step("dynamic client registration");
  const registration = await auth("/register", { method: "POST", body: { redirect_uris: [redirectUri], client_name: "MCP smoke" } });
  assert.equal(registration.status, 201, registration.text);
  const clientId = registration.json.client_id;
  const otherClientId = (await auth("/register", { method: "POST", body: {
    redirect_uris: [redirectUri], client_name: "MCP smoke other" } })).json.client_id;

  step("authorize: exact redirect, S256 only, exact resource; consent needs a session");
  const p1 = pkce();
  assert.equal((await auth(`/authorize?${authorizeQuery(clientId, p1.challenge)}`)).status, 200);
  assert.equal((await auth(`/authorize?${authorizeQuery(clientId, p1.challenge, {
    redirect_uri: "https://client.example.org/oauth/other" })}`)).status, 400);
  for (const extra of [{ code_challenge_method: "plain" }, { resource: `${resource}/` }, { resource: "https://mcp.unknown.invalid/mcp" }]) {
    const response = await auth(`/authorize?${authorizeQuery(clientId, p1.challenge, extra)}`);
    assert.equal(response.status, 302, JSON.stringify(extra));
    assert.equal(new URL(response.headers.location).searchParams.get("error"), "invalid_request");
  }
  const noSession = await auth("/authorize/consent", { method: "POST", headers: { origin: issuer }, body: {
    client_id: clientId, redirect_uri: redirectUri, code_challenge: p1.challenge, scope: "flashcards", resource } });
  assert.equal(noSession.status, 401, noSession.text);

  step("token: changed redirect/verifier/client refused without consuming the code; code single-use");
  const code = await oauthCode(sessionA.cookie, clientId, p1.challenge);
  const grant = { grant_type: "authorization_code", code, code_verifier: p1.verifier, redirect_uri: redirectUri, client_id: clientId };
  for (const bad of [{ redirect_uri: "https://client.example.org/oauth/other" }, { code_verifier: pkce().verifier }, { client_id: otherClientId }]) {
    const response = await auth("/token", { method: "POST", form: { ...grant, ...bad } });
    assert.equal(response.json?.error, "invalid_grant", JSON.stringify(bad));
  }
  const tokens = await auth("/token", { method: "POST", form: grant });
  assert.equal(tokens.status, 200, tokens.text);
  assert.ok(tokens.json.access_token?.startsWith("fco_"), "access token is an fco_ token");
  assert.equal((await auth("/token", { method: "POST", form: grant })).json.error, "invalid_grant");

  step("id_token: published kid, exact issuer/audience/nonce, key differs from the session key");
  const [encodedHeader, encodedClaims, signature] = tokens.json.id_token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url"));
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url"));
  const jwk = jwks.json.keys.find((key) => key.kid === header.kid);
  assert.ok(jwk, "kid published");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`),
    createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url")));
  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, clientId);
  assert.equal(claims.nonce, "nonce-1");
  assert.notEqual(JSON.parse(Buffer.from(sessionA.idToken.split(".")[0], "base64url")).kid, header.kid);

  const access = tokens.json.access_token;
  step("MCP tools: initialize, tools/list, create a card, review it, retry the same reviewId");
  const init = await mcp(access, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-smoke", version: "1" } });
  assert.equal(init.status, 200, init.text);
  const list = await mcp(access, "tools/list", {});
  assert.equal(list.status, 200, list.text);
  const toolNames = list.json.result.tools.map((entry) => entry.name);
  for (const name of ["list_workspaces", "sql_query", "sql_execute", "next_review_card", "reveal_answer", "submit_review"]) {
    assert.ok(toolNames.includes(name), name);
  }
  const workspaces = toolJson(await tool(access, "list_workspaces", {}));
  const workspaceA = (workspaces.workspaces ?? workspaces.data?.workspaces ?? [])[0]?.workspaceId;
  assert.ok(workspaceA, "workspace resolved");
  const marker = `mcp-${randomUUID().slice(0, 8)}`;
  const inserted = await tool(access, "sql_execute", { workspaceId: workspaceA, sql:
    `INSERT INTO cards (front_text, back_text, tags) VALUES ('Capital of fixture ${marker}?', 'Fixtureville', ('${marker}'))` });
  assert.notEqual(inserted.isError, true, JSON.stringify(inserted));
  const next = toolJson(await tool(access, "next_review_card", { workspaceId: workspaceA, tags: [marker] }));
  const card = next.card ?? next.data?.card;
  assert.ok(card && card.frontText.includes(marker), JSON.stringify(next));
  assert.equal(JSON.stringify(next).includes("Fixtureville"), false, "next card hides the answer");
  assert.ok(JSON.stringify(toolJson(await tool(access, "reveal_answer", { workspaceId: workspaceA, cardId: card.cardId }))).includes("Fixtureville"));
  const scheduleSql = `SELECT reps, due_at FROM cards WHERE card_id = '${card.cardId}'`;
  const before = await queryText(access, workspaceA, scheduleSql);
  const submission = { workspaceId: workspaceA, cardId: card.cardId, reviewId: randomUUID(), rating: "Good", reviewedTimeZone: "UTC" };
  const first = await tool(access, "submit_review", submission);
  assert.notEqual(first.isError, true, JSON.stringify(first));
  const afterFirst = await queryText(access, workspaceA, scheduleSql);
  await tool(access, "submit_review", submission);
  const afterRetry = await queryText(access, workspaceA, scheduleSql);
  const events = await queryText(access, workspaceA, `SELECT count(*) AS reviews FROM review_events WHERE card_id = '${card.cardId}'`);
  assert.notEqual(afterFirst, before, "schedule advanced");
  assert.equal(afterRetry, afterFirst, "retry did not advance the schedule again");
  assert.match(events, /"reviews":1\b/, events);

  if (altHost !== "") {
    step("token bound to its host: refused on the alternate MCP host");
    const cross = await mcp(access, "tools/list", {}, { host: altHost });
    assert.equal(cross.status, 401, cross.text);
    assert.equal(cross.headers["www-authenticate"],
      `Bearer resource_metadata="https://${altHost}/.well-known/oauth-protected-resource/mcp"`);
  }
  if (listedOrigin !== "") {
    step("listed Origin allowed with an exact CORS echo");
    const allowed = await mcp(access, "tools/list", {}, { headers: { origin: listedOrigin } });
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(allowed.headers["access-control-allow-origin"], listedOrigin);
  }

  step("per-token concurrency: bounded, excess 429 with Retry-After");
  const burst = await Promise.all(Array.from({ length: 24 }, () =>
    mcp(access, "tools/call", { name: "sql_query", arguments: { workspaceId: workspaceA, sql: "SELECT count(*) FROM cards" } })));
  assert.ok(burst.every((response) => response.status === 200 || response.status === 429));
  assert.ok(burst.some((response) => response.status === 429), "burst exceeded the per-token limit");
  for (const response of burst.filter((r) => r.status === 429)) {
    assert.equal(response.headers["retry-after"], "1");
    assert.equal(response.json.code, "MCP_CLIENT_CONCURRENCY_LIMIT_REACHED");
  }

  step("refresh rotation: new pair works, old refresh and another client refused");
  const refreshGrant = { grant_type: "refresh_token", refresh_token: tokens.json.refresh_token, client_id: clientId };
  const refreshed = await auth("/token", { method: "POST", form: refreshGrant });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal((await mcp(refreshed.json.access_token, "tools/list", {})).status, 200);
  assert.equal((await auth("/token", { method: "POST", form: refreshGrant })).json.error, "invalid_grant");
  assert.equal((await auth("/token", { method: "POST", form: {
    ...refreshGrant, refresh_token: refreshed.json.refresh_token, client_id: otherClientId } })).json.error, "invalid_grant");

  step("account B (agent key on MCP) cannot read A's workspace; invalid tokens 401");
  const keyB = await agentKey(emailB);
  assert.equal(JSON.stringify(toolJson(await tool(keyB, "list_workspaces", {}))).includes(workspaceA), false);
  const foreignQuery = await tool(keyB, "sql_query", { workspaceId: workspaceA, sql: "SELECT count(*) AS n FROM cards" });
  assert.equal(foreignQuery.isError, true, JSON.stringify(foreignQuery));
  const foreignReveal = await mcp(keyB, "tools/call", { name: "reveal_answer", arguments: { workspaceId: workspaceA, cardId: card.cardId } });
  assert.equal(foreignReveal.text.includes("Fixtureville"), false);
  assert.equal((await mcp("fca_invalid_key_value", "tools/list", {})).status, 401);
  assert.equal((await mcp("fco_INVALIDTOKEN", "tools/list", {})).status, 401);

  console.log(`MCP SMOKE PASS (${stepCount} steps)`);
}

main().catch((error) => {
  console.error(`MCP SMOKE FAIL: ${redact(error.stack ?? error)}`);
  process.exit(1);
});
