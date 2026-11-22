/**
 * Standalone (self-hosted) MCP server: the same app the AWS Lambda serves
 * (../mcp/httpApp), on a Node HTTP listener, behind the standalone Host/Origin and
 * concurrency guard (../mcp/standalone). docs/self-hosting.md lists its settings.
 */
import { serve } from "@hono/node-server";
import { createMcpHttpApp } from "../mcp/httpApp";
import { createStandaloneMcpGuard, loadStandaloneMcpConfig } from "../mcp/standalone";
import { initializeBackendSentry } from "../observability/sentry";

async function main(): Promise<void> {
  initializeBackendSentry("backend-api");
  const config = loadStandaloneMcpConfig(process.env);
  const app = createMcpHttpApp(createStandaloneMcpGuard(config));
  const port = Number.parseInt(process.env.PORT ?? "8082", 10);
  const hostname = process.env.MCP_BIND_HOST;

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log({ domain: "mcp", action: "start", port: info.port, hosts: config.allowedHosts });
  });
  // Containers stop with SIGTERM: stop accepting connections and let in-flight requests finish.
  process.once("SIGTERM", () => {
    console.log({ domain: "mcp", action: "shutdown" });
    server.close(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({ domain: "mcp", action: "startup_failed", error: message });
  process.exit(1);
});
