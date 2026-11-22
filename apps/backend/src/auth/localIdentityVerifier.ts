import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { JwtVerifier } from "aws-jwt-verify";
import type { JwtPayload } from "aws-jwt-verify/jwt-model";
import { JwtInvalidClaimError } from "aws-jwt-verify/error";
import { unsafeQuery } from "../database/unsafe";
import { HttpError } from "../shared/errors";

/**
 * AUTH_MODE=local: verifies ID tokens issued by the standalone auth service
 * (apps/auth/src/server/local/localTokens.ts) with this deployment's issuer, audience and public key.
 * The JWKS is derived from the configured key and never fetched (verifySync), so a token signed by
 * any other key fails with the same aws-jwt-verify errors as the Cognito path. A valid signature is
 * not enough: the token's session family (`sid`) must be live for this subject, issuer and audience
 * (auth.local_session_status, a SECURITY DEFINER status read; the backend role reads no auth.local_*
 * table). Logout and refresh-token reuse therefore end an ID token before its `exp`.
 */
let verifier: ReturnType<typeof JwtVerifier.create> | undefined;
let bound: Readonly<{ issuer: string; audience: string }> | undefined;

/** A JwtInvalidClaimError, so the backend boundary classifies it as a terminal 401 like other claim failures. */
class LocalIdentityClaimError extends JwtInvalidClaimError {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required when AUTH_MODE=local`);
  return value;
}

function createLocalVerifier(): ReturnType<typeof JwtVerifier.create> {
  // Same normalization as the auth service (URL origin), so both sides compare one issuer string.
  const issuer = new URL(required("LOCAL_AUTH_ISSUER")).origin;
  const audience = required("LOCAL_AUTH_CLIENT_ID");
  const publicKey = createPublicKey(readFileSync(required("LOCAL_AUTH_PUBLIC_KEY_FILE"), "utf8"));
  const exported = publicKey.export({ format: "jwk" });
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("LOCAL_AUTH_PUBLIC_KEY_FILE must hold an RSA public key");
  }
  // RFC 7638 thumbprint; must match the kid the auth service derives from its private key.
  const kid = createHash("sha256").update(JSON.stringify({ e: exported.e, kty: "RSA", n: exported.n })).digest("base64url");
  const created = JwtVerifier.create({
    issuer,
    audience,
    jwksUri: `${issuer}/.well-known/nibomo-local-jwks.json`,
    customJwtCheck: ({ payload }) => {
      if (payload.token_use !== "id") throw new LocalIdentityClaimError("Local identity token is not an ID token", payload.token_use, "id");
      if (typeof payload.sid !== "string" || !UUID_RE.test(payload.sid)) {
        throw new LocalIdentityClaimError("Local identity token is missing sid", payload.sid, "uuid");
      }
      if (typeof payload.jti !== "string" || !UUID_RE.test(payload.jti)) {
        throw new LocalIdentityClaimError("Local identity token is missing jti", payload.jti, "uuid");
      }
    },
  });
  created.cacheJwks({ keys: [{ kty: "RSA", n: exported.n, e: exported.e, kid, alg: "RS256", use: "sig" }] });
  bound = { issuer, audience };
  return created;
}

export const localIdTokenVerifier = {
  verify: async (token: string): Promise<JwtPayload & { sub: string }> => {
    verifier ??= createLocalVerifier();
    const payload = verifier.verifySync(token);
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("Local identity token is missing sub");
    if (bound === undefined) throw new Error("Local identity verifier is not bound to an issuer");
    // A database failure propagates as a server error and never authenticates.
    const result = await unsafeQuery<Readonly<{ status: string }>>(
      "SELECT auth.local_session_status($1, $2, $3, $4) AS status",
      [payload.sid as string, payload.sub, bound.issuer, bound.audience],
    );
    const status = result.rows[0]?.status;
    if (status === undefined) throw new Error("Local session validation returned no result");
    if (status !== "valid") throw new HttpError(401, "This session was revoked. Sign in again.", "SESSION_REVOKED");
    return payload as JwtPayload & { sub: string };
  },
};

/** Fails startup on a missing or invalid key/issuer instead of on the first request. */
export function assertLocalIdTokenVerifierConfigured(): void {
  verifier ??= createLocalVerifier();
}
