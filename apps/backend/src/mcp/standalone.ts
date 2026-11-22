/**
 * Standalone (self-hosted) ingress for the MCP app, served by ../entrypoints/mcp-node.ts.
 *
 * On AWS, API Gateway accepts only the MCP custom domains, the dispatcher holds
 * per-token leases (lambda-mcp-dispatcher.ts) and reserved concurrency bounds the
 * worker. A single Node process has none of that, so this guard runs before every
 * route, including the protected-resource metadata:
 * - Host must be a configured MCP host (no fallback to the primary host, no
 *   X-Forwarded-Host): anything else gets 421.
 * - Origin, when present, must be listed exactly in MCP_ALLOWED_ORIGINS: anything
 *   else gets 403. Non-browser clients send no Origin and are unaffected.
 * - A request with a Bearer token holds one of the token's slots, and every request
 *   one process-wide slot, until its response is built; excess gets 429 with
 *   Retry-After, the same codes the dispatcher returns.
 */
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { extractBearerToken } from "./bearerChallenge";
import { getAllowedMcpHosts, getPrimaryMcpHost } from "./hosts";
import type { McpAppEnv } from "./httpApp";
import { normalizeRequestHost } from "../shared/requestHost";
import { parsePublicOrigin, validateStandalonePublicUrlConfiguration } from "../shared/publicUrls";

/** Same per-token fairness as the dispatcher's lease slots. */
export const STANDALONE_TOKEN_SLOT_COUNT = 4;
/** Same bound as the AWS worker's reserved concurrency (infra/aws/lib/lambda-database-capacity.ts). */
export const STANDALONE_PROCESS_SLOT_COUNT = 16;
const retryAfterSeconds = 1;
const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type StandaloneMcpConfig = Readonly<{
  baseDomain: string;
  alternateHost: string | null;
  allowedHosts: ReadonlyArray<string>;
  allowedOrigins: ReadonlySet<string>;
}>;

function requireHostname(variableName: string, value: string): string {
  if (!hostnamePattern.test(value)) {
    throw new Error(`${variableName} must be a lower-case DNS name without scheme, port or path`);
  }
  return value;
}

/**
 * Reads and validates the standalone MCP settings once at startup; any missing or
 * malformed value stops the process. The authorization server stays
 * `https://auth.<MCP_BASE_DOMAIN>` exactly as on AWS, so PUBLIC_AUTH_BASE_URL must
 * name it, and PUBLIC_MCP_BASE_URL must name the primary MCP host.
 */
export function loadStandaloneMcpConfig(env: NodeJS.ProcessEnv): StandaloneMcpConfig {
  if (env.AUTH_MODE !== "local") {
    throw new Error("The standalone MCP server requires AUTH_MODE=local");
  }
  const baseDomain = requireHostname("MCP_BASE_DOMAIN", (env.MCP_BASE_DOMAIN ?? "").trim());
  const rawAlternate = (env.MCP_ALTERNATE_HOST ?? "").trim();
  const alternateHost = rawAlternate === "" ? null : requireHostname("MCP_ALTERNATE_HOST", rawAlternate);
  const publicUrls = validateStandalonePublicUrlConfiguration();
  if (publicUrls.auth !== `https://auth.${baseDomain}`) {
    throw new Error(`PUBLIC_AUTH_BASE_URL must be https://auth.${baseDomain}, the OAuth issuer the MCP metadata names`);
  }
  if (publicUrls.mcp !== `https://${getPrimaryMcpHost(baseDomain)}`) {
    throw new Error(`PUBLIC_MCP_BASE_URL must be https://${getPrimaryMcpHost(baseDomain)}`);
  }
  const allowedOrigins = new Set<string>();
  for (const entry of (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim())) {
    if (entry === "") continue;
    const origin = parsePublicOrigin(entry, "MCP_ALLOWED_ORIGINS");
    if (!origin.startsWith("https://")) throw new Error("MCP_ALLOWED_ORIGINS entries must be https origins");
    allowedOrigins.add(origin);
  }
  return {
    baseDomain,
    alternateHost,
    allowedHosts: getAllowedMcpHosts(baseDomain, alternateHost),
    allowedOrigins,
  };
}

/** Counting semaphore without waiting: a full key is refused, never queued. */
export class SlotCounter {
  private readonly held = new Map<string, number>();

  constructor(private readonly limit: number) {}

  tryAcquire(key: string): boolean {
    const current = this.held.get(key) ?? 0;
    if (current >= this.limit) return false;
    this.held.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.held.get(key) ?? 0;
    if (current <= 1) this.held.delete(key);
    else this.held.set(key, current - 1);
  }

  inUse(key: string): number {
    return this.held.get(key) ?? 0;
  }
}

export type StandaloneMcpGuard = Readonly<{
  middleware: MiddlewareHandler<McpAppEnv>;
  tokenSlots: SlotCounter;
  processSlots: SlotCounter;
}>;

const processKey = "process";

const corsExposedHeaders = "WWW-Authenticate, Mcp-Session-Id, Retry-After, X-Request-Id";

/** For responses the transport built itself, which do not carry headers set on the context. */
function setCorsHeaders(headers: Headers, origin: string): void {
  headers.set("Access-Control-Allow-Origin", origin);
  if (!(headers.get("Vary") ?? "").includes("Origin")) headers.append("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", corsExposedHeaders);
}

function getBearerToken(authorization: string | undefined): string | null {
  return authorization === undefined ? null : extractBearerToken(authorization);
}

export function createStandaloneMcpGuard(config: StandaloneMcpConfig): StandaloneMcpGuard {
  const tokenSlots = new SlotCounter(STANDALONE_TOKEN_SLOT_COUNT);
  const processSlots = new SlotCounter(STANDALONE_PROCESS_SLOT_COUNT);
  const allowedHosts = new Set(config.allowedHosts);

  const middleware: MiddlewareHandler<McpAppEnv> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Liveness only, for the container healthcheck, which reaches the process directly.
    if (c.req.method === "GET" && c.req.path === "/health") {
      return next();
    }

    const host = normalizeRequestHost(c.req.header("host"));
    if (host === null || !allowedHosts.has(host)) {
      return c.json({ error: "misdirected_request", error_description: "Unknown MCP host." }, 421);
    }

    const origin = c.req.header("origin");
    if (origin !== undefined && !config.allowedOrigins.has(origin)) {
      return c.json({ error: "forbidden_origin", error_description: "This Origin may not call the MCP resource." }, 403);
    }
    if (origin !== undefined) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Expose-Headers", corsExposedHeaders);
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
        );
        c.header("Access-Control-Max-Age", "600");
        return c.body(null, 204);
      }
    }

    const token = getBearerToken(c.req.header("authorization"));
    const tokenKey = token === null ? null : createHash("sha256").update(token).digest("hex");
    if (tokenKey !== null && !tokenSlots.tryAcquire(tokenKey)) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({
        error: `This access token already has ${STANDALONE_TOKEN_SLOT_COUNT} MCP requests in progress. Wait for Retry-After before retrying this request.`,
        code: "MCP_CLIENT_CONCURRENCY_LIMIT_REACHED",
        requestId: c.get("requestId"),
      }, 429);
    }
    if (!processSlots.tryAcquire(processKey)) {
      if (tokenKey !== null) tokenSlots.release(tokenKey);
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({
        error: "MCP request capacity is temporarily full. Wait for Retry-After before retrying this request.",
        code: "MCP_CONCURRENCY_LIMIT_REACHED",
        requestId: c.get("requestId"),
      }, 429);
    }
    try {
      // The transport runs in JSON-response mode, so the whole tool call is done when next() returns.
      await next();
      // The transport builds its own Response, so headers set before next() are not carried onto it.
      c.res.headers.set("Cache-Control", "no-store");
      if (origin !== undefined) setCorsHeaders(c.res.headers, origin);
    } finally {
      processSlots.release(processKey);
      if (tokenKey !== null) tokenSlots.release(tokenKey);
    }
  };

  return { middleware, tokenSlots, processSlots };
}
