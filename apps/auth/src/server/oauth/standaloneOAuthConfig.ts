import { getLocalIdentityConfig } from "../local/localIdentityConfig.js";
import { getMcpAlternateResource } from "../publicUrls.js";
import { assertOidcSignerConfigured } from "./oidcSigning.js";

function requiredUrl(name: string): URL {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") throw new Error(`${name} is required when AUTH_IDENTITY_PROVIDER=local`);
  return new URL(raw);
}

function assertMcpResource(name: string, value: string): void {
  const url = new URL(value);
  // Exact canonical form: the stored token resource is compared byte-for-byte by the MCP server.
  if (url.href !== value || url.protocol !== "https:" || url.pathname !== "/mcp" || url.search !== "" || url.hash !== ""
      || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new Error(`${name} must be exactly https://<mcp host>/mcp`);
  }
}

/**
 * Startup check for the standalone OAuth authorization server, so a missing or mismatched setting
 * stops the service instead of failing on the first /authorize or /token request:
 * - the OAuth issuer (PUBLIC_AUTH_BASE_URL) is the same origin as the identity issuer;
 * - MCP_RESOURCE (and MCP_ALTERNATE_RESOURCE when set) names an exact https `/mcp` resource;
 * - only the mounted OIDC signing key is configured (no KMS ARN), and it and any retired
 *   verification keys load.
 */
export function assertStandaloneOAuthConfig(): void {
  const authBase = requiredUrl("PUBLIC_AUTH_BASE_URL");
  // Literal, not just parsed, equality: the raw value is the published OAuth issuer and the
  // same-origin value the consent and sign-in guard compares with the browser's Origin header
  // (app.ts), so `https://Auth.<base>` or a trailing `/` would pass a parsed check yet break both.
  const issuer = getLocalIdentityConfig().issuer;
  if (process.env.PUBLIC_AUTH_BASE_URL !== issuer || authBase.origin !== issuer) {
    throw new Error("PUBLIC_AUTH_BASE_URL must equal LOCAL_AUTH_ISSUER exactly (a lower-case origin without path or trailing slash)");
  }
  requiredUrl("MCP_RESOURCE");
  assertMcpResource("MCP_RESOURCE", process.env.MCP_RESOURCE ?? "");
  const alternate = getMcpAlternateResource();
  if (alternate !== null) assertMcpResource("MCP_ALTERNATE_RESOURCE", alternate);
  assertOidcSignerConfigured();
}
