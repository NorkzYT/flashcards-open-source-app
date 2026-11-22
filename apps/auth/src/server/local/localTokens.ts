import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { JwtVerifier } from "aws-jwt-verify";
import type { JwtPayload } from "aws-jwt-verify/jwt-model";
import { query } from "../../db.js";
import { PrincipalSessionError } from "../social/principalSessions.js";
import { getLocalIdentityConfig, type LocalIdentityConfig } from "./localIdentityConfig.js";

/**
 * Deployment-bound RS256 ID tokens for AUTH_IDENTITY_PROVIDER=local. Clients keep treating `idToken` as
 * an opaque bearer credential; only this deployment's issuer, audience and key verify. Verification
 * uses only the configured key (cached JWKS, verifySync), so no issuer URL is ever fetched. Every token
 * carries its session family (`sid`) and a `jti`; a valid signature alone is not enough, because
 * verifyLocalIdToken also requires the family to be live in auth.local_session_families (logout and
 * refresh-token reuse revoke it before the token's `exp`).
 */
export type LocalPublicJwk = Readonly<{ kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" }>;

type SigningMaterial = Readonly<{ privateKey: KeyObject; jwk: LocalPublicJwk }>;

let material: SigningMaterial | undefined;
let verifier: ReturnType<typeof JwtVerifier.create> | undefined;

/** RFC 7638 thumbprint, so auth and backend derive the same kid from the same public key. */
export function publicJwkFromKey(publicKey: KeyObject): LocalPublicJwk {
  const exported = publicKey.export({ format: "jwk" });
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("Local identity signing key must be an RSA key");
  }
  const kid = createHash("sha256").update(JSON.stringify({ e: exported.e, kty: "RSA", n: exported.n })).digest("base64url");
  return { kty: "RSA", n: exported.n, e: exported.e, kid, alg: "RS256", use: "sig" };
}

function getSigningMaterial(config: LocalIdentityConfig): SigningMaterial {
  if (material !== undefined) return material;
  const privateKey = createPrivateKey(config.signingKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("LOCAL_AUTH_SIGNING_KEY_FILE must hold an RSA private key of at least 2048 bits");
  }
  material = { privateKey, jwk: publicJwkFromKey(createPublicKey(privateKey)) };
  return material;
}

export function getLocalPublicJwks(): Readonly<{ keys: ReadonlyArray<LocalPublicJwk> }> {
  return { keys: [getSigningMaterial(getLocalIdentityConfig()).jwk] };
}

export type LocalTokenClaims = Readonly<{ subject: string; email: string; authTime: number; familyId: string }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function signJwt(config: LocalIdentityConfig, payload: Record<string, unknown>): string {
  const { privateKey, jwk } = getSigningMaterial(config);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

export function issueLocalTokens(claims: LocalTokenClaims, nowSeconds: number): Readonly<{
  idToken: string; accessToken: string; expiresIn: number;
}> {
  const config = getLocalIdentityConfig();
  const common = {
    iss: config.issuer,
    sub: claims.subject,
    sid: claims.familyId,
    auth_time: claims.authTime,
    iat: nowSeconds,
    exp: nowSeconds + config.idTokenTtlSeconds,
  };
  return {
    idToken: signJwt(config, {
      ...common, aud: config.audience, token_use: "id", email: claims.email, email_verified: true, jti: randomUUID(),
    }),
    accessToken: signJwt(config, { ...common, client_id: config.audience, token_use: "access", jti: randomUUID() }),
    expiresIn: config.idTokenTtlSeconds,
  };
}

function getVerifier(): ReturnType<typeof JwtVerifier.create> {
  if (verifier !== undefined) return verifier;
  const config = getLocalIdentityConfig();
  const created = JwtVerifier.create({
    issuer: config.issuer,
    audience: config.audience,
    jwksUri: `${config.issuer}/.well-known/nibomo-local-jwks.json`,
    customJwtCheck: ({ payload }) => {
      if (payload.token_use !== "id") throw new Error("Local identity token is not an ID token");
      if (typeof payload.sid !== "string" || !UUID_RE.test(payload.sid)) throw new Error("Local identity token is missing sid");
      if (typeof payload.jti !== "string" || !UUID_RE.test(payload.jti)) throw new Error("Local identity token is missing jti");
    },
  });
  created.cacheJwks({ keys: [getSigningMaterial(config).jwk] });
  verifier = created;
  return verifier;
}

/**
 * Signature/claim failures keep the Cognito verifier's error classes (aws-jwt-verify). A signed token
 * whose family is revoked, expired, disabled or bound to another deployment fails as a revoked
 * principal session; a database failure propagates and never grants access.
 */
export async function verifyLocalIdToken(token: string): Promise<JwtPayload & { sub: string }> {
  const payload = getVerifier().verifySync(token);
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("Local identity token is missing sub");
  const config = getLocalIdentityConfig();
  const result = await query<{ status: string }>(
    "SELECT auth.local_session_status($1, $2, $3, $4) AS status",
    [payload.sid as string, payload.sub, config.issuer, config.audience],
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new Error("Local session validation returned no result");
  if (status !== "valid") throw new PrincipalSessionError("revoked");
  return payload as JwtPayload & { sub: string };
}

export function resetLocalTokensForTests(): void {
  material = undefined;
  verifier = undefined;
}
