import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resetFileOidcSigningForTests } from "./oidcFileSigning.js";
import { getOidcPublicKeys, signOidcIdToken } from "./oidcSigning.js";
import { getMcpResource, getPublicAuthBaseUrl } from "../publicUrls.js";

// The standalone OAuth ID-token signer and the explicit-URL rule, through the public signing module.
const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "oidc-file-signing-"));
function writeKey(name: string): Readonly<{ privatePath: string; publicPem: string }> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePath = path.join(dir, `${name}.pem`);
  writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }));
  return { privatePath, publicPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}
const oauthKey = writeKey("oauth");
const retiredKey = writeKey("retired");
const sessionKey = writeKey("session");
const retiredPath = path.join(dir, "retired.pub.pem");
writeFileSync(retiredPath, retiredKey.publicPem);

const names = ["AUTH_IDENTITY_PROVIDER", "OIDC_SIGNING_KEY_FILE", "OIDC_SIGNING_KEY_ARN", "OIDC_VERIFICATION_KEYS_FILE",
  "LOCAL_AUTH_SIGNING_KEY_FILE", "PUBLIC_AUTH_BASE_URL", "MCP_RESOURCE"] as const;
type Env = Partial<Record<(typeof names)[number], string>>;

async function withEnv<T>(env: Env, body: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  resetFileOidcSigningForTests();
  try {
    return await body();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetFileOidcSigningForTests();
  }
}

const local: Env = {
  AUTH_IDENTITY_PROVIDER: "local",
  OIDC_SIGNING_KEY_FILE: oauthKey.privatePath,
  OIDC_VERIFICATION_KEYS_FILE: retiredPath,
  LOCAL_AUTH_SIGNING_KEY_FILE: sessionKey.privatePath,
};
const claims = { iss: "https://auth.study.example.com", sub: "user-1", aud: "client-1", iat: 1, exp: 2 };

test("standalone signs with the mounted key and publishes it before retired keys", async () => {
  await withEnv(local, async () => {
    const keys = await getOidcPublicKeys();
    assert.equal(keys.length, 2);
    const token = await signOidcIdToken(claims);
    const [header, payload, signature] = token.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).kid, keys[0].kid);
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), claims);
    assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), { key: { ...keys[0] }, format: "jwk" },
      Buffer.from(signature, "base64url")));
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), { key: { ...keys[1] }, format: "jwk" },
      Buffer.from(signature, "base64url")), false);
  });
});

test("the signer fails closed on missing, mixed or reused key settings", async () => {
  const failing: ReadonlyArray<Env> = [
    { ...local, OIDC_SIGNING_KEY_FILE: undefined },
    { ...local, OIDC_SIGNING_KEY_FILE: path.join(dir, "missing.pem") },
    { ...local, OIDC_SIGNING_KEY_ARN: "arn:aws:kms:region:account:key/id" },
    { ...local, OIDC_SIGNING_KEY_FILE: sessionKey.privatePath },
    { ...local, OIDC_VERIFICATION_KEYS_FILE: oauthKey.privatePath },
    { OIDC_SIGNING_KEY_FILE: oauthKey.privatePath },
  ];
  for (const env of failing) {
    await withEnv(env, async () => {
      await assert.rejects(signOidcIdToken(claims), JSON.stringify(env));
      await assert.rejects(getOidcPublicKeys(), JSON.stringify(env));
    });
  }
});

test("standalone never derives the issuer or MCP resource from the request host", async () => {
  await withEnv(local, () => {
    assert.throws(() => getPublicAuthBaseUrl("https://evil.example.com/authorize"));
    assert.throws(() => getMcpResource("https://auth.study.example.com/authorize"));
  });
  await withEnv({ ...local, PUBLIC_AUTH_BASE_URL: "https://auth.study.example.com", MCP_RESOURCE: "https://mcp.study.example.com/mcp" }, () => {
    assert.equal(getPublicAuthBaseUrl("https://evil.example.com/authorize"), "https://auth.study.example.com");
    assert.equal(getMcpResource("https://evil.example.com/authorize"), "https://mcp.study.example.com/mcp");
  });
});
