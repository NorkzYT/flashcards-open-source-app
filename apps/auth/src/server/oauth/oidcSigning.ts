import { createHash, createPublicKey } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { logWarning } from "../logger.js";
import { getIdentityProviderMode } from "../local/localIdentityConfig.js";
import { getFileOidcPublicKeys, signFileOidcIdToken } from "./oidcFileSigning.js";

const kms = new KMSClient({ maxAttempts: 3 });
const signingAlgorithm = "RSASSA_PKCS1_V1_5_SHA_256";

export type OidcClaims = Readonly<{
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
}>;

export type OidcPublicKey = Readonly<{
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: "RS256";
}>;

let cachedPublicKey: OidcPublicKey | undefined;

function getSigningKeyArn(): string {
  const keyArn = process.env.OIDC_SIGNING_KEY_ARN;
  if (keyArn === undefined || keyArn === "") {
    throw new Error("OIDC_SIGNING_KEY_ARN is not configured");
  }
  return keyArn;
}

kms.middlewareStack.add((next, context) => async (args) => {
  try {
    return await next(args);
  } catch (error) {
    logWarning({
      domain: "auth", action: "error", code: "OIDC_KMS_REQUEST_FAILED",
      route: context.commandName,
      errorClass: error instanceof Error ? error.name : "UnknownKmsFailure",
    });
    throw error;
  }
}, { step: "finalizeRequest", priority: "low", name: "oidcKmsAttemptLogger" });

/**
 * The OAuth ID-token signer follows the identity mode: KMS for the AWS deployment (unchanged), and
 * for AUTH_IDENTITY_PROVIDER=local only the key mounted at OIDC_SIGNING_KEY_FILE
 * (./oidcFileSigning.ts). Mixed settings refuse to sign rather than pick one.
 */
function isFileSigner(): boolean {
  const local = getIdentityProviderMode() === "local";
  const hasFile = (process.env.OIDC_SIGNING_KEY_FILE ?? "").trim() !== "";
  const hasArn = (process.env.OIDC_SIGNING_KEY_ARN ?? "").trim() !== "";
  if (local && hasArn) throw new Error("OIDC_SIGNING_KEY_ARN must be unset when AUTH_IDENTITY_PROVIDER=local");
  if (!local && hasFile) throw new Error("OIDC_SIGNING_KEY_FILE is only valid with AUTH_IDENTITY_PROVIDER=local");
  return local;
}

/** Startup check: the signer settings are consistent, and in standalone the mounted keys load. */
export function assertOidcSignerConfigured(): void {
  if (isFileSigner()) getFileOidcPublicKeys();
}

/** Every key a relying party may verify an ID token with: the active key first, then retired ones. */
export async function getOidcPublicKeys(): Promise<ReadonlyArray<OidcPublicKey>> {
  if (isFileSigner()) return getFileOidcPublicKeys();
  return [await getKmsOidcPublicKey()];
}

async function getKmsOidcPublicKey(): Promise<OidcPublicKey> {
  if (cachedPublicKey !== undefined) {
    return cachedPublicKey;
  }
  const keyArn = getSigningKeyArn();
  const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyArn }));
  if (response.PublicKey === undefined || response.KeyUsage !== "SIGN_VERIFY"
      || !response.SigningAlgorithms?.includes(signingAlgorithm)) {
    throw new Error("OIDC KMS key must expose an RSA signing public key supporting RS256");
  }
  const jwk = createPublicKey({ key: Buffer.from(response.PublicKey), format: "der", type: "spki" }).export({ format: "jwk" });
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new Error("OIDC KMS public key is not an RSA JWK");
  }
  cachedPublicKey = { kty: "RSA", n: jwk.n, e: jwk.e, kid: keyArn, use: "sig", alg: "RS256" };
  return cachedPublicKey;
}

export async function signOidcIdToken(claims: OidcClaims): Promise<string> {
  if (isFileSigner()) return signFileOidcIdToken(claims);
  const keyArn = getSigningKeyArn();
  // KMS signs remotely; only JWS serialization and hashing happen in the Lambda.
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyArn })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const response = await kms.send(new SignCommand({
    KeyId: keyArn,
    SigningAlgorithm: signingAlgorithm,
    MessageType: "DIGEST",
    Message: createHash("sha256").update(signingInput).digest(),
  }));
  if (response.Signature === undefined || response.SigningAlgorithm !== signingAlgorithm) {
    throw new Error("OIDC KMS signing returned no RS256 signature");
  }
  return `${signingInput}.${Buffer.from(response.Signature).toString("base64url")}`;
}
