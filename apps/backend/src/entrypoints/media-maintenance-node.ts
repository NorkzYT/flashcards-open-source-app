import { createServer, type Server } from "node:http";

/**
 * Standalone media maintenance process (NIBOMO_DEPLOYMENT=standalone, MEDIA_ASSETS_STORAGE_PROFILE=rustfs).
 * Replaces the scheduled generated-media-promotion and multipart-completion-reconciliation Lambdas; see
 * maintenance/standaloneMediaMaintenance.ts. It refuses to start with any input that could reach a
 * hosted cloud resource or with a database role that bypasses the row-level fences.
 *
 * Optional health endpoint: MEDIA_MAINTENANCE_HEALTH_PORT (bind MEDIA_MAINTENANCE_HEALTH_BIND_HOST, default
 * 127.0.0.1) serves `GET /health/live` and `GET /health/ready` (a cycle succeeded recently).
 *
 * Exit codes: 0 clean stop, 1 runtime failure or a cycle still running after the shutdown grace,
 * 78 configuration or schema refused.
 */

function log(record: Readonly<Record<string, unknown>>): void {
  console.log({ domain: "media_maintenance", ...record });
}

class StartupRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StartupRefusedError";
  }
}

/** Inputs that would select a hosted identity, credential chain or secret source. */
const HOSTED_ONLY_ENVIRONMENT_VARIABLES = [
  "DB_SECRET_ARN",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

const REQUIRED_FUNCTIONS = [
  "content.claim_generated_media_promotion_jobs",
  "content.reschedule_generated_media_promotion_job",
  "content.claim_next_media_blob_cleanup",
  "content.authorize_media_blob_cleanup",
  "content.renew_media_blob_cleanup_lease",
  "content.complete_media_blob_cleanup",
  "content.record_media_blob_cleanup_failure",
  "content.claim_media_upload_session_completion_reconciliations",
  "content.renew_media_upload_session_completion_reconciliation",
  "content.claim_media_upload_session_completion_failure_reports",
  "content.read_media_multipart_completed_parts_manifest",
] as const;

/**
 * Every function must exist with at least one overload this role may execute; the chat-file tombstones
 * must be readable and deletable; and the role must not bypass row security or administer the database.
 */
const SCHEMA_AND_ROLE_PROBE_SQL = `
  WITH required(name) AS (SELECT unnest($1::text[])),
  missing AS (
    SELECT required.name FROM required
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc proc
      JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname || '.' || proc.proname = required.name
        AND pg_catalog.has_function_privilege(proc.oid, 'EXECUTE')
    )
  )
  SELECT
    (SELECT coalesce(array_agg(name ORDER BY name), '{}') FROM missing) AS missing_functions,
    pg_catalog.to_regclass('ai.chat_file_deletions') IS NOT NULL
      AND pg_catalog.has_table_privilege('ai.chat_file_deletions', 'SELECT,DELETE') AS chat_file_tombstones,
    roles.rolsuper OR roles.rolbypassrls OR roles.rolcreaterole OR roles.rolcreatedb AS privileged_role,
    current_user AS role_name
  FROM pg_catalog.pg_roles roles WHERE roles.rolname = current_user
`;

type ProbeRow = Readonly<{
  missing_functions: ReadonlyArray<string>;
  chat_file_tombstones: boolean;
  privileged_role: boolean;
  role_name: string;
}>;

function parseHealthPort(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const port = /^[0-9]+$/u.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new StartupRefusedError("MEDIA_MAINTENANCE_HEALTH_PORT must be a TCP port from 1 to 65535");
  }
  return port;
}

const refuseOnConfigError = <Value>(read: () => Value): Value => {
  try {
    return read();
  } catch (error) {
    throw new StartupRefusedError(error instanceof Error ? error.message : String(error));
  }
};

async function main(): Promise<void> {
  const { readChatDeploymentMode } = await import("../chat/deployment");
  if (refuseOnConfigError(() => readChatDeploymentMode()) !== "standalone") {
    throw new StartupRefusedError(
      "The standalone media maintenance process requires NIBOMO_DEPLOYMENT=standalone; AWS deployments run the scheduled Lambdas.",
    );
  }
  for (const name of HOSTED_ONLY_ENVIRONMENT_VARIABLES) {
    if ((process.env[name]?.trim() ?? "") !== "") {
      throw new StartupRefusedError(`${name} must not be set for standalone media maintenance.`);
    }
  }
  if (process.env.AWS_EC2_METADATA_DISABLED !== "true") {
    throw new StartupRefusedError(
      "AWS_EC2_METADATA_DISABLED must be \"true\" so no SDK path can probe instance metadata for an identity.",
    );
  }
  if ((process.env.DATABASE_URL?.trim() ?? "") === "") {
    throw new StartupRefusedError("DATABASE_URL is required (the least-privileged backend role).");
  }
  const { getMediaAssetsStorageConfig } = await import("../mediaAssets/storage/config");
  const storage = refuseOnConfigError(() => getMediaAssetsStorageConfig());
  if (storage.profile !== "rustfs") {
    throw new StartupRefusedError(
      "MEDIA_ASSETS_STORAGE_PROFILE=rustfs with an explicit MEDIA_ASSETS_S3_ENDPOINT is required.",
    );
  }
  const healthPort = parseHealthPort(process.env.MEDIA_MAINTENANCE_HEALTH_PORT);

  // The scheduled-job modules initialize Sentry (a no-op without SENTRY_DSN) when loaded.
  const [media, multipart, maintenance, { unsafeQuery }, lock] = await Promise.all([
    import("./scheduledJobs/lambda-generated-media-promotion"),
    import("./scheduledJobs/lambda-multipart-completion-reconciliation"),
    import("../maintenance/standaloneMediaMaintenance"),
    import("../database/unsafe"),
    import("../database/sessionAdvisoryLock"),
  ]);
  const cleanupEnabled = refuseOnConfigError(() => media.readMediaBlobCleanupEnabled(
    process.env[media.mediaBlobCleanupEnabledEnvironmentName],
  ));
  const config = refuseOnConfigError(() => maintenance.readStandaloneMediaMaintenanceConfig(
    process.env,
    cleanupEnabled,
  ));

  const probe = (await unsafeQuery<ProbeRow>(SCHEMA_AND_ROLE_PROBE_SQL, [REQUIRED_FUNCTIONS])).rows[0];
  if (probe === undefined) {
    throw new StartupRefusedError("The database role of DATABASE_URL could not be inspected.");
  }
  if (probe.missing_functions.length > 0 || !probe.chat_file_tombstones) {
    throw new StartupRefusedError(
      `The media maintenance schema is missing or not granted to ${probe.role_name}: `
        + `functions=${probe.missing_functions.join(",") || "ok"} chatFileTombstones=${String(probe.chat_file_tombstones)}. `
        + "Apply db/migrations through 0256 and connect as backend_app.",
    );
  }
  if (probe.privileged_role) {
    throw new StartupRefusedError(
      `Database role ${probe.role_name} is superuser, bypasses RLS or administers roles/databases; connect as backend_app.`,
    );
  }

  const dependencies: Parameters<typeof maintenance.createStandaloneMediaMaintenance>[1] = {
    runMediaFn: (input) => media.runGeneratedMediaScheduledWorkloads(input, media.generatedMediaScheduledWorkloadDependencies),
    runMultipartFn: multipart.runMultipartCompletionScheduledWorkloads,
    withExclusiveLockFn: async (signal, callback) => {
      try {
        return await lock.withSessionAdvisoryLock({
          lockName: "standalone-media-maintenance",
          lockKey: maintenance.standaloneMediaMaintenanceLockKey,
          timeoutMs: maintenance.standaloneMediaMaintenanceLockAcquireTimeoutMs,
          pollIntervalMs: maintenance.standaloneMediaMaintenanceLockPollIntervalMs,
          signal,
        }, callback);
      } catch (error) {
        if (error instanceof lock.SessionAdvisoryLockTimeoutError) return maintenance.maintenanceLockHeld;
        throw error;
      }
    },
    nowFn: Date.now,
    createCycleIdFn: maintenance.defaultCycleId,
    waitFn: maintenance.defaultWait,
    log,
  };
  const runner = maintenance.createStandaloneMediaMaintenance(config, dependencies);

  log({
    action: "media_maintenance_config",
    workerId: config.workerId,
    intervalMs: config.intervalMs,
    cycleBudgetMs: config.cycleBudgetMs,
    shutdownGraceMs: config.shutdownGraceMs,
    blobCleanup: config.cleanupEnabled ? "enabled" : "disabled",
    storageProfile: storage.profile,
    bucket: storage.bucketName,
    databaseRole: probe.role_name,
  });

  let healthServer: Server | null = null;
  if (healthPort !== null) {
    healthServer = createServer((request, response) => {
      const health = runner.health();
      const path = request.url?.split("?")[0];
      const live = health.started && !health.stopping;
      const ok = path === "/health/live"
        ? live
        : path === "/health/ready"
          ? maintenance.isStandaloneMediaMaintenanceReady(health, config, Date.now())
          : null;
      if (request.method !== "GET" || ok === null) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok,
        lastCycleStatus: health.lastCycleStatus,
        consecutiveFailures: health.consecutiveFailures,
      }));
    });
    const bindHost = process.env.MEDIA_MAINTENANCE_HEALTH_BIND_HOST?.trim() || "127.0.0.1";
    await new Promise<void>((resolve) => healthServer?.listen(healthPort, bindHost, resolve));
    log({ action: "media_maintenance_health_listening", port: healthPort, host: bindHost });
  }

  let stopping: Promise<void> | null = null;
  const shutdown = (signal: string): void => {
    stopping ??= (async () => {
      log({ action: "media_maintenance_stopping", signal });
      const settled = await runner.stop();
      healthServer?.close();
      // An unsettled cycle stops renewing its leases; the next holder of the lock reclaims the jobs.
      log({ action: "media_maintenance_stopped", settled });
      process.exit(settled ? 0 : 1);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await runner.run();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({ domain: "media_maintenance", action: "startup_failed", error: message });
  process.exit(error instanceof StartupRefusedError ? 78 : 1);
});
