import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { publicJwkFromKey } from "../local/localTokens.js";
import type { OidcClaims, OidcPublicKey } from "./oidcSigning.js";

/**
 * Standalone OAuth ID-token signer: an RSA key the operator mounts at OIDC_SIGNING_KEY_FILE.
 * It is deliberately a different key from the session identity key (LOCAL_AUTH_SIGNING_KEY_FILE),
 * so an MCP connector's id_token can never verify as a first-party session token. Rotation: put the
 * new key in OIDC_SIGNING_KEY_FILE and the retired public keys in OIDC_VERIFICATION_KEYS_FILE (PEM
 * bundle) until every token they signed has expired; `kid` is the RFC 7638 thumbprint.
 * Any unreadable or invalid key fails closed: nothing is signed or published.
 */
type FileSigningMaterial = Readonly<{
  privateKey: KeyObject;
  activeKid: string;
  publicKeys: ReadonlyArray<OidcPublicKey>;
}>;

let material: FileSigningMaterial | undefined;

const pemBlockPattern = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;

function readRequiredFile(name: string): string {
  const path = (process.env[name] ?? "").trim();
  if (path === "") throw new Error(`${name} is required when AUTH_IDENTITY_PROVIDER=local`);
  const contents = readFileSync(path, "utf8").trim();
  if (contents === "") throw new Error(`${name} points to an empty file`);
  return contents;
}

function toOidcPublicKey(publicKey: KeyObject): OidcPublicKey {
  const jwk = publicJwkFromKey(publicKey);
  return { kty: "RSA", n: jwk.n, e: jwk.e, kid: jwk.kid, use: "sig", alg: "RS256" };
}

function assertRsa2048(key: KeyObject, name: string): void {
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error(`${name} must hold an RSA key of at least 2048 bits`);
  }
}

function sessionIdentityKid(): string | null {
  const path = (process.env.LOCAL_AUTH_SIGNING_KEY_FILE ?? "").trim();
  if (path === "") return null;
  return publicJwkFromKey(createPublicKey(createPrivateKey(readFileSync(path, "utf8")))).kid;
}

function loadMaterial(): FileSigningMaterial {
  if (material !== undefined) return material;
  const privateKey = createPrivateKey(readRequiredFile("OIDC_SIGNING_KEY_FILE"));
  assertRsa2048(privateKey, "OIDC_SIGNING_KEY_FILE");
  const active = toOidcPublicKey(createPublicKey(privateKey));
  if (active.kid === sessionIdentityKid()) {
    throw new Error("OIDC_SIGNING_KEY_FILE must not reuse the LOCAL_AUTH_SIGNING_KEY_FILE key");
  }
  const publicKeys: Array<OidcPublicKey> = [active];
  const retiredPath = (process.env.OIDC_VERIFICATION_KEYS_FILE ?? "").trim();
  if (retiredPath !== "") {
    const blocks = readFileSync(retiredPath, "utf8").match(pemBlockPattern) ?? [];
    if (blocks.length === 0) throw new Error("OIDC_VERIFICATION_KEYS_FILE holds no PEM public key");
    for (const block of blocks) {
      const retired = createPublicKey(block);
      assertRsa2048(retired, "OIDC_VERIFICATION_KEYS_FILE");
      const jwk = toOidcPublicKey(retired);
      if (!publicKeys.some((key) => key.kid === jwk.kid)) publicKeys.push(jwk);
    }
  }
  material = { privateKey, activeKid: active.kid, publicKeys };
  return material;
}

export function getFileOidcPublicKeys(): ReadonlyArray<OidcPublicKey> {
  return loadMaterial().publicKeys;
}

export function signFileOidcIdToken(claims: OidcClaims): string {
  const { privateKey, activeKid } = loadMaterial();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: activeKid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

export function resetFileOidcSigningForTests(): void {
  material = undefined;
}
