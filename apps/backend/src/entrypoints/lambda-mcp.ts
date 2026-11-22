/**
 * Lambda entry point for the dedicated MCP API Gateway on mcp.<domain>. The
 * routes, OAuth identifiers and transport are the shared app in ../mcp/httpApp.
 */
import { handle } from "hono/aws-lambda";
import { createMcpHttpApp } from "../mcp/httpApp";
import { initializeBackendSentry, wrapBackendHandler } from "../observability/sentry";

initializeBackendSentry("backend-api");

const app = createMcpHttpApp(null);

// Sentry.wrapHandler: performs the per-invocation flush before the Lambda
// freezes, so the buffered captureBackendException events (and the
// mcp/server.ts 5xx/unexpected captures) are actually delivered. This is the
// buffered-handler equivalent of lambda.ts:134 and matches how lambda.ts
// delivers buffered events.
export const handler = wrapBackendHandler(handle(app));
