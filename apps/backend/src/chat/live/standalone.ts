/**
 * Standalone (self-hosted) live chat stream. On AWS the stream is a separate Lambda function URL
 * (entrypoints/lambda-chat-live.ts) signed with a Secrets Manager secret; a Compose deployment has
 * neither, so the Node backend serves the same handler at `<PUBLIC_API_BASE_URL>/chat/live` and
 * reads the HMAC secret from one mounted file (docs/self-hosting.md). The attach contract is
 * unchanged: clients use the `liveStream.url` and `Live` authorization from POST /chat, the token
 * stays run-scoped and expires as on AWS, and every request is authenticated by handleLiveRequest.
 */
import { randomUUID } from "node:crypto";
import { PassThrough, Readable, type Writable } from "node:stream";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { parsePublicOrigin } from "../../shared/publicUrls";
import { captureBackendException, createBackendObservationScope, normalizeCaughtError } from "../../observability/sentry";
import type { ChatLiveStreamResult } from "./index";
import { createChatLiveErrorResponse } from "./errors";
import type { LiveStreamParams } from "./request";
import { readStandaloneChatLiveSecretFile } from "./secretFile";

export { resetStandaloneChatLiveSecretCacheForTests } from "./secretFile";

export const STANDALONE_CHAT_LIVE_PATH = "/chat/live";

export type StandaloneChatLiveConfig = Readonly<{ liveUrl: string }>;

/**
 * Null on the hosted stack (no CHAT_LIVE_AUTH_SECRET_FILE). Otherwise every setting must agree or
 * startup fails: local auth only, no AWS secret beside the file, a readable strong secret, and
 * CHAT_LIVE_URL naming exactly this API's live route over https.
 */
export function loadStandaloneChatLiveConfig(env: NodeJS.ProcessEnv): StandaloneChatLiveConfig | null {
  const secretFile = (env.CHAT_LIVE_AUTH_SECRET_FILE ?? "").trim();
  if (secretFile === "") {
    return null;
  }
  if (env.AUTH_MODE !== "local") {
    throw new Error("CHAT_LIVE_AUTH_SECRET_FILE is only supported with AUTH_MODE=local");
  }
  if ((env.BACKEND_CHAT_LIVE_AUTH_SECRET_ARN ?? "").trim() !== "") {
    throw new Error("CHAT_LIVE_AUTH_SECRET_FILE and BACKEND_CHAT_LIVE_AUTH_SECRET_ARN must not both be set");
  }
  const apiBaseUrl = env.PUBLIC_API_BASE_URL ?? "";
  if (!apiBaseUrl.endsWith("/v1")) {
    throw new Error("PUBLIC_API_BASE_URL must be an https origin followed by /v1 for the standalone live stream");
  }
  const apiOrigin = parsePublicOrigin(apiBaseUrl.slice(0, -"/v1".length), "PUBLIC_API_BASE_URL");
  const expectedLiveUrl = `${apiOrigin}/v1${STANDALONE_CHAT_LIVE_PATH}`;
  if (!apiOrigin.startsWith("https://") || env.CHAT_LIVE_URL !== expectedLiveUrl) {
    throw new Error(`CHAT_LIVE_URL must be ${expectedLiveUrl} in standalone mode`);
  }
  readStandaloneChatLiveSecretFile(secretFile);
  return { liveUrl: expectedLiveUrl };
}

export type StandaloneChatLiveDependencies = Readonly<{
  handleLiveRequestFn: (
    url: URL,
    authorizationHeader: string | undefined,
    headers: Headers,
  ) => Promise<LiveStreamParams>;
  runLiveStreamFn: (stream: Writable, params: LiveStreamParams) => Promise<ChatLiveStreamResult>;
}>;

const activeStreams = new Set<PassThrough>();

/**
 * Ends every attached stream cleanly (on SIGTERM) so the HTTP server can close; clients see the
 * stream end without run_terminal and resume from their cursor, as after the AWS connection limit.
 */
export function closeStandaloneChatLiveStreams(): void {
  for (const stream of activeStreams) {
    stream.end();
  }
  activeStreams.clear();
}

// Logged instead of the header: only a known scheme name, never any token material.
function getAuthorizationScheme(header: string | undefined): string {
  if (header === undefined || header === "") return "missing";
  const scheme = header.split(" ", 1)[0];
  return ["Live", "Bearer", "Guest", "ApiKey"].includes(scheme) ? scheme.toLowerCase() : "unknown";
}

type LiveRouteEnv = { Variables: { requestId?: string } };

export function createStandaloneChatLiveRoutes(dependencies: StandaloneChatLiveDependencies): Hono<LiveRouteEnv> {
  const app = new Hono<LiveRouteEnv>();
  app.get(STANDALONE_CHAT_LIVE_PATH, async (context) => {
    const requestId = context.get("requestId") ?? randomUUID();
    context.header("X-Request-Id", requestId);
    const url = new URL(context.req.url);
    let params: LiveStreamParams;
    try {
      params = await dependencies.handleLiveRequestFn(url, context.req.header("authorization"), context.req.raw.headers);
    } catch (error) {
      const response = createChatLiveErrorResponse(error, requestId);
      return context.json(response.body, response.statusCode as ContentfulStatusCode);
    }

    const stream = new PassThrough();
    activeStreams.add(stream);
    stream.once("close", () => activeStreams.delete(stream));
    // The response is returned now; the run loop keeps writing until the run ends, the connection
    // limit is reached or the client disconnects (which destroys `stream`).
    void dependencies.runLiveStreamFn(stream, { ...params, requestId })
      .catch((error: unknown) => {
        captureBackendException({
          action: "chat_live_stream_crashed",
          error: normalizeCaughtError(error),
          scope: createBackendObservationScope(
            "chat-live", requestId, url.pathname, "GET", params.userId, params.workspaceId,
            params.clientRequestId ?? null, params.runId, params.sessionId,
            params.clientVersion ?? null, params.clientPlatform ?? null,
          ),
          details: {
            statusCode: 500,
            path: url.pathname,
            sessionId: params.sessionId,
            runId: params.runId,
            afterCursor: params.afterCursor ?? null,
            hasToken: url.searchParams.has("token"),
            hasWorkspaceId: url.searchParams.has("workspaceId"),
            origin: context.req.header("origin") ?? null,
            authScheme: getAuthorizationScheme(context.req.header("authorization")),
            clientRequestId: params.clientRequestId ?? null,
            resumeAttemptId: params.resumeAttemptId ?? null,
            clientPlatform: params.clientPlatform ?? null,
            clientVersion: params.clientVersion ?? null,
          },
        });
      })
      .finally(() => {
        if (!stream.destroyed && !stream.writableEnded) stream.end();
      });

    return context.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    });
  });
  return app;
}
