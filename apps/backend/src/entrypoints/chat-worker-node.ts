import { createServer, type Server } from "node:http";
import { initializeBackendSentry } from "../observability/sentry";

/**
 * Standalone chat worker process (NIBOMO_DEPLOYMENT=standalone). Polls `ai.chat_run_dispatches` and runs
 * each turn through the same worker code the AWS Lambda uses. It refuses to start rather than run with a
 * configuration that would reach a hosted cloud resource or queue work it cannot execute.
 *
 * Optional health endpoint: CHAT_WORKER_HEALTH_PORT (bind CHAT_WORKER_HEALTH_BIND_HOST, default
 * 127.0.0.1) serves `GET /health/live` (process loop running) and `GET /health/ready` (the last dispatch
 * poll reached Postgres recently and succeeded).
 */

function log(record: Readonly<Record<string, unknown>>): void {
  // Logged as an object, like every backend record (see entrypoints/index.ts). No record carries a key.
  console.log({ domain: "chat_worker", ...record });
}

class StartupRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StartupRefusedError";
  }
}

const HOSTED_ONLY_ENVIRONMENT_VARIABLES = ["CHAT_WORKER_FUNCTION_NAME", "CHAT_SANDBOX_FUNCTION_NAME"] as const;
const DISPATCH_SCHEMA_PROBE_SQL = `
  SELECT to_regprocedure('ai.lease_chat_run_dispatches(text,integer,integer)') IS NOT NULL
     AND to_regprocedure('ai.recover_chat_run_dispatches(text,integer,integer,integer,integer)') IS NOT NULL
     AND to_regprocedure('ai.complete_chat_run_dispatch(uuid,uuid)') IS NOT NULL
     AND to_regprocedure('ai.assert_chat_run_dispatch_lease(uuid,uuid,text,uuid,uuid,text)') IS NOT NULL
     AND to_regprocedure('ai.take_chat_run_dispatch_credential(uuid,uuid,text,uuid,uuid,text)') IS NOT NULL
     AND to_regprocedure('ai.purge_expired_chat_run_dispatch_credentials(integer)') IS NOT NULL AS ready
`;

function parseHealthPort(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const port = /^[0-9]+$/u.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new StartupRefusedError("CHAT_WORKER_HEALTH_PORT must be a TCP port from 1 to 65535");
  }
  return port;
}

async function main(): Promise<void> {
  initializeBackendSentry("chat-worker");
  const {
    assertStandaloneAiFundingConfigured,
    hasOperatorOpenAIApiKey,
    readChatDeploymentMode,
    readStandaloneAiFunding,
    readStandaloneAiMonthlyMessages,
  } = await import("../chat/deployment");

  const refuseOnConfigError = <Value>(read: () => Value): Value => {
    try {
      return read();
    } catch (error) {
      throw new StartupRefusedError(error instanceof Error ? error.message : String(error));
    }
  };
  if (refuseOnConfigError(() => readChatDeploymentMode()) !== "standalone") {
    throw new StartupRefusedError(
      "The standalone chat worker requires NIBOMO_DEPLOYMENT=standalone; AWS deployments dispatch chat runs to Lambda.",
    );
  }
  for (const name of HOSTED_ONLY_ENVIRONMENT_VARIABLES) {
    if ((process.env[name]?.trim() ?? "") !== "") {
      throw new StartupRefusedError(
        `${name} must not be set in standalone mode: the standalone worker never invokes hosted Lambda functions.`,
      );
    }
  }
  const funding = refuseOnConfigError(() => readStandaloneAiFunding());
  if (funding === "operator" && !hasOperatorOpenAIApiKey()) {
    throw new StartupRefusedError(
      "AI_PROVIDER_NOT_CONFIGURED: OPENAI_API_KEY is not set, so this worker cannot execute chat runs.",
    );
  }
  // `user-key` funding has no operator allowance: every run is billed to the sealed personal key.
  const monthlyMessages = funding === "operator"
    ? refuseOnConfigError(() => readStandaloneAiMonthlyMessages())
    : null;
  const healthPort = parseHealthPort(process.env.CHAT_WORKER_HEALTH_PORT);

  const [{ handleChatWorkerEvent }, standalone, { unsafeQuery }] = await Promise.all([
    import("../chat/worker"),
    import("../chat/worker/standalone"),
    import("../database/unsafe"),
  ]);
  const config = refuseOnConfigError(() => standalone.readStandaloneChatWorkerConfig());
  // Checked before the database: `user-key` needs the keyring and must not see an operator key.
  refuseOnConfigError(() => assertStandaloneAiFundingConfigured(config.credentialKeyring != null));
  // A malformed OPENAI_BASE_URL or NIBOMO_OPENAI_MODEL stops the worker before it leases a run.
  const { readOpenAIProviderEndpoint } = await import("../chat/openai/providerEndpoint");
  const providerEndpoint = refuseOnConfigError(() => readOpenAIProviderEndpoint());

  const probe = await unsafeQuery<Readonly<{ ready: boolean }>>(DISPATCH_SCHEMA_PROBE_SQL, []);
  if (probe.rows[0]?.ready !== true) {
    throw new StartupRefusedError(
      "The standalone dispatch schema is missing: apply db/migrations/0255_chat_run_standalone_dispatch.sql and 0258_chat_run_dispatch_lease_fence.sql before starting the worker.",
    );
  }

  const worker = standalone.createStandaloneChatWorker(config, {
    ...standalone.DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES,
    handleEvent: handleChatWorkerEvent,
    log,
  });

  log({
    action: "chat_worker_config",
    workerId: config.workerId,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    leaseDurationMs: config.leaseDurationMs,
    maxAttempts: config.maxAttempts,
    runTimeoutMs: config.runTimeoutMs,
    aiFunding: funding,
    aiMonthlyMessagesPerPerson: monthlyMessages,
    sandbox: "disabled",
    // Sealed keys need NIBOMO_CHAT_CREDENTIAL_KEY_FILE on both API and worker; without it they are refused
    // by the API and any sealed run reaching this worker is interrupted.
    personalOpenAIKeys: config.credentialKeyring ? "sealed" : "refused",
    instanceId: config.credentialKeyring?.instanceId ?? null,
    // Validated to carry no credentials, so both are safe to log.
    openaiBaseUrl: providerEndpoint.baseURL,
    openaiModelOverride: providerEndpoint.modelOverride,
  });

  let healthServer: Server | null = null;
  if (healthPort !== null) {
    const readyWindowMs = Math.max(3 * config.pollIntervalMs, 15_000);
    healthServer = createServer((request, response) => {
      const health = worker.health();
      const live = health.started && !health.stopping;
      const ready = live && !health.lastPollFailed && health.lastPollSucceededAtMs !== null
        && Date.now() - health.lastPollSucceededAtMs <= readyWindowMs;
      const path = request.url?.split("?")[0];
      const ok = path === "/health/live" ? live : path === "/health/ready" ? ready : null;
      if (request.method !== "GET" || ok === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok, inFlight: health.inFlight }));
    });
    const bindHost = process.env.CHAT_WORKER_HEALTH_BIND_HOST?.trim() || "127.0.0.1";
    await new Promise<void>((resolve) => healthServer?.listen(healthPort, bindHost, resolve));
    log({ action: "chat_worker_health_listening", port: healthPort, host: bindHost });
  }

  let stopping: Promise<void> | null = null;
  const shutdown = (signal: string): void => {
    stopping ??= (async () => {
      log({ action: "chat_worker_stopping", signal });
      const left = await worker.stop();
      healthServer?.close();
      // Runs still in flight stop heartbeating; the next worker's recovery interrupts them.
      process.exit(left === 0 ? 0 : 1);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.run();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({ domain: "chat_worker", action: "startup_failed", error: message });
  process.exit(error instanceof StartupRefusedError ? 78 : 1);
});
