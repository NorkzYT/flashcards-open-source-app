import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  createBackendObservationScope,
  type BackendObservationScope,
  type BackendService,
} from "../observability/sentry";
import type {
  GeneratedMediaScheduledWorkloadInput,
  GeneratedMediaScheduledWorkloadResult,
} from "../entrypoints/scheduledJobs/lambda-generated-media-promotion";
import type {
  MultipartCompletionScheduledWorkloadInput,
} from "../entrypoints/scheduledJobs/lambda-multipart-completion-reconciliation";
import type {
  MultipartCompletionReconciliationBatchResult,
} from "../mediaAssets/multipart/completion/completionReconciliation";

/**
 * Standalone (no-AWS) replacement for the two scheduled media Lambdas: generated-media promotion with
 * orphaned-blob and deleted-chat-file cleanup, and multipart completion reconciliation. Every cycle runs
 * the same shared batch functions with the Lambda's batch sizes and leases; only the trigger differs.
 * Deletion stays behind the existing database claim/authorize fences and the storage `If-Match` delete.
 *
 * One cycle at a time across all processes: a cycle runs only while it holds a PostgreSQL session
 * advisory lock, and loses its signal if that lock connection drops. Row leases stay the per-job fence.
 */

/** The Lambda budget: 2-minute timeout minus the 10 s finalization reserve, below both 180 s leases. */
export const standaloneMediaMaintenanceMaximumCycleBudgetMs = 110_000;
export const standaloneMediaMaintenanceLockKey = "nibomo:standalone-media-maintenance:v1";
const lockAcquireTimeoutMs = 2_000;
const lockPollIntervalMs = 500;

export type StandaloneMediaMaintenanceConfig = Readonly<{
  workerId: string;
  intervalMs: number;
  cycleBudgetMs: number;
  shutdownGraceMs: number;
  cleanupEnabled: boolean;
}>;

type BoundedIntegerSetting = Readonly<{
  name: string;
  defaultValue: number;
  minimum: number;
  maximum: number;
}>;

export const standaloneMediaMaintenanceSettings = {
  intervalMs: { name: "MEDIA_MAINTENANCE_INTERVAL_MS", defaultValue: 60_000, minimum: 10_000, maximum: 3_600_000 },
  cycleBudgetMs: {
    name: "MEDIA_MAINTENANCE_CYCLE_BUDGET_MS",
    defaultValue: standaloneMediaMaintenanceMaximumCycleBudgetMs,
    minimum: 10_000,
    maximum: standaloneMediaMaintenanceMaximumCycleBudgetMs,
  },
  shutdownGraceMs: { name: "MEDIA_MAINTENANCE_SHUTDOWN_GRACE_MS", defaultValue: 20_000, minimum: 1_000, maximum: 60_000 },
} as const satisfies Record<string, BoundedIntegerSetting>;

function readBoundedInteger(env: NodeJS.ProcessEnv, setting: BoundedIntegerSetting): number {
  const raw = env[setting.name]?.trim() ?? "";
  if (raw === "") return setting.defaultValue;
  const value = /^[0-9]+$/u.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < setting.minimum || value > setting.maximum) {
    throw new Error(`${setting.name} must be an integer from ${setting.minimum} to ${setting.maximum}`);
  }
  return value;
}

const workerIdPattern = /^[A-Za-z0-9._-]{1,64}$/u;

export function defaultStandaloneMediaMaintenanceWorkerId(): string {
  const host = hostname().replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 40) || "host";
  return `${host}-${process.pid}`;
}

/** `cleanupEnabled` comes from the existing MEDIA_BLOB_CLEANUP_ENABLED reader (unset means off). */
export function readStandaloneMediaMaintenanceConfig(
  env: NodeJS.ProcessEnv,
  cleanupEnabled: boolean,
): StandaloneMediaMaintenanceConfig {
  const workerId = env.MEDIA_MAINTENANCE_WORKER_ID?.trim() || defaultStandaloneMediaMaintenanceWorkerId();
  if (!workerIdPattern.test(workerId)) {
    throw new Error("MEDIA_MAINTENANCE_WORKER_ID must be 1-64 letters, digits, '.', '_' or '-'");
  }
  return {
    workerId,
    intervalMs: readBoundedInteger(env, standaloneMediaMaintenanceSettings.intervalMs),
    cycleBudgetMs: readBoundedInteger(env, standaloneMediaMaintenanceSettings.cycleBudgetMs),
    shutdownGraceMs: readBoundedInteger(env, standaloneMediaMaintenanceSettings.shutdownGraceMs),
    cleanupEnabled,
  };
}

/** Returned by the lock dependency when another process holds the maintenance lock. */
export const maintenanceLockHeld: unique symbol = Symbol("maintenanceLockHeld");

export type StandaloneMediaMaintenanceDependencies = Readonly<{
  runMediaFn: (input: GeneratedMediaScheduledWorkloadInput) => Promise<GeneratedMediaScheduledWorkloadResult>;
  runMultipartFn: (input: MultipartCompletionScheduledWorkloadInput) => Promise<MultipartCompletionReconciliationBatchResult>;
  withExclusiveLockFn: <Result>(
    signal: AbortSignal,
    callback: (signal: AbortSignal) => Promise<Result>,
  ) => Promise<Result | typeof maintenanceLockHeld>;
  nowFn: () => number;
  createCycleIdFn: () => string;
  waitFn: (delayMs: number, signal: AbortSignal) => Promise<void>;
  log: (record: Readonly<Record<string, unknown>>) => void;
}>;

export type StandaloneMediaMaintenanceCycleOutcome =
  | Readonly<{ status: "completed"; cycleId: string; durationMs: number;
    media: GeneratedMediaScheduledWorkloadResult; multipart: MultipartCompletionReconciliationBatchResult }>
  | Readonly<{ status: "failed"; cycleId: string; durationMs: number; errors: ReadonlyArray<string> }>
  | Readonly<{ status: "skipped_lock_held"; cycleId: string; durationMs: number }>;

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message} [${error.errors.map(errorMessage).join("; ")}]`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function observationScope(service: BackendService, requestId: string): BackendObservationScope {
  return createBackendObservationScope(service, requestId, null, null, null, null, null, null, null, null, null);
}

function summarizeMedia(result: GeneratedMediaScheduledWorkloadResult): Record<string, unknown> {
  const { results: _promotionResults, ...promotion } = result.promotion;
  const { results: _cleanupResults, ...cleanup } = result.cleanup;
  return { promotion, cleanup, chatFileCleanup: result.chatFileCleanup };
}

function summarizeMultipart(result: MultipartCompletionReconciliationBatchResult): Record<string, unknown> {
  const { results: _results, ...counts } = result;
  return counts;
}

/**
 * One bounded cycle. Both workloads share the cycle deadline and run concurrently, as their two Lambdas
 * do; each keeps its own failure. Never throws: failures become a `failed` outcome for the next cycle to
 * retry, since every workload is idempotent behind its leases.
 */
export async function runStandaloneMediaMaintenanceCycle(
  config: StandaloneMediaMaintenanceConfig,
  dependencies: StandaloneMediaMaintenanceDependencies,
  stopSignal: AbortSignal,
): Promise<StandaloneMediaMaintenanceCycleOutcome> {
  const cycleId = dependencies.createCycleIdFn();
  const startedAtMs = dependencies.nowFn();
  const deadlineAtMs = startedAtMs + config.cycleBudgetMs;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error("Standalone media maintenance cycle deadline reached.")),
    config.cycleBudgetMs,
  );
  const signal = AbortSignal.any([stopSignal, deadline.signal]);
  const durationMs = (): number => dependencies.nowFn() - startedAtMs;
  try {
    const invocationId = `standalone:${config.workerId}:${cycleId}`;
    const settled = await dependencies.withExclusiveLockFn(signal, (lockedSignal) => Promise.allSettled([
      dependencies.runMediaFn({
        leaseOwner: `generated-media-promotion:${invocationId}`,
        deadlineAtMs,
        cleanupEnabled: config.cleanupEnabled,
        observationScope: observationScope("generated-media-promotion", invocationId),
        signal: lockedSignal,
      }),
      dependencies.runMultipartFn({
        invocationId,
        deadlineAtMs,
        observationScope: observationScope("multipart-completion-reconciliation", invocationId),
        signal: lockedSignal,
      }),
    ] as const));
    if (settled === maintenanceLockHeld) {
      return { status: "skipped_lock_held", cycleId, durationMs: durationMs() };
    }
    const [media, multipart] = settled;
    if (media.status === "fulfilled" && multipart.status === "fulfilled") {
      return { status: "completed", cycleId, durationMs: durationMs(), media: media.value, multipart: multipart.value };
    }
    const errors = [media, multipart].flatMap((item, index) => item.status === "rejected"
      ? [`${index === 0 ? "media" : "multipart"}: ${errorMessage(item.reason)}`]
      : []);
    return { status: "failed", cycleId, durationMs: durationMs(), errors };
  } catch (error) {
    return { status: "failed", cycleId, durationMs: durationMs(), errors: [`lock: ${errorMessage(error)}`] };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export type StandaloneMediaMaintenanceHealth = Readonly<{
  started: boolean;
  stopping: boolean;
  cycleRunning: boolean;
  lastCycleStatus: StandaloneMediaMaintenanceCycleOutcome["status"] | null;
  lastHealthyCycleAtMs: number | null;
  consecutiveFailures: number;
}>;

export type StandaloneMediaMaintenance = Readonly<{
  run: () => Promise<void>;
  /** Aborts the running cycle and resolves true once it has settled within the grace period. */
  stop: () => Promise<boolean>;
  health: () => StandaloneMediaMaintenanceHealth;
}>;

export function createStandaloneMediaMaintenance(
  config: StandaloneMediaMaintenanceConfig,
  dependencies: StandaloneMediaMaintenanceDependencies,
): StandaloneMediaMaintenance {
  const stopController = new AbortController();
  let started = false;
  let cycleRunning = false;
  let lastCycleStatus: StandaloneMediaMaintenanceCycleOutcome["status"] | null = null;
  let lastHealthyCycleAtMs: number | null = null;
  let consecutiveFailures = 0;
  let runPromise: Promise<void> | null = null;

  const loop = async (): Promise<void> => {
    while (!stopController.signal.aborted) {
      cycleRunning = true;
      const outcome = await runStandaloneMediaMaintenanceCycle(config, dependencies, stopController.signal);
      cycleRunning = false;
      lastCycleStatus = outcome.status;
      if (outcome.status === "failed") {
        consecutiveFailures += 1;
        dependencies.log({
          action: "media_maintenance_cycle_failed", cycleId: outcome.cycleId, durationMs: outcome.durationMs,
          consecutiveFailures, errors: outcome.errors, stopping: stopController.signal.aborted,
        });
      } else {
        consecutiveFailures = 0;
        lastHealthyCycleAtMs = dependencies.nowFn();
        dependencies.log(outcome.status === "completed"
          ? {
            action: "media_maintenance_cycle_completed", cycleId: outcome.cycleId, durationMs: outcome.durationMs,
            media: summarizeMedia(outcome.media), multipart: summarizeMultipart(outcome.multipart),
          }
          : { action: "media_maintenance_cycle_skipped", reason: "lock_held_elsewhere", cycleId: outcome.cycleId });
      }
      try {
        await dependencies.waitFn(config.intervalMs, stopController.signal);
      } catch {
        break;
      }
    }
  };

  return {
    run: () => {
      if (runPromise !== null) throw new Error("Standalone media maintenance is already running.");
      started = true;
      runPromise = loop();
      return runPromise;
    },
    stop: async () => {
      stopController.abort(new Error("Standalone media maintenance is stopping."));
      if (runPromise === null) return true;
      const grace = new AbortController();
      const settled = await Promise.race([
        runPromise.then(() => true, () => true),
        wait(config.shutdownGraceMs, false, { signal: grace.signal }).catch(() => false),
      ]);
      grace.abort();
      return settled;
    },
    health: () => ({
      started,
      stopping: stopController.signal.aborted,
      cycleRunning,
      lastCycleStatus,
      lastHealthyCycleAtMs,
      consecutiveFailures,
    }),
  };
}

/** Ready while a cycle completed (or found another holder of the lock) recently. */
export function isStandaloneMediaMaintenanceReady(
  health: StandaloneMediaMaintenanceHealth,
  config: StandaloneMediaMaintenanceConfig,
  nowMs: number,
): boolean {
  const windowMs = 2 * config.intervalMs + config.cycleBudgetMs;
  return health.started && !health.stopping && health.lastHealthyCycleAtMs !== null
    && nowMs - health.lastHealthyCycleAtMs <= windowMs;
}

export async function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  await wait(delayMs, undefined, { signal });
}

export function defaultCycleId(): string {
  return randomUUID();
}

export { lockAcquireTimeoutMs as standaloneMediaMaintenanceLockAcquireTimeoutMs };
export { lockPollIntervalMs as standaloneMediaMaintenanceLockPollIntervalMs };
