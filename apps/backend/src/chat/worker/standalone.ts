import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  completeStandaloneChatRunDispatch,
  interruptAbandonedStandaloneChatRun,
  leaseStandaloneChatRunDispatches,
  recoverStandaloneChatRunDispatches,
  type LeasedChatRunDispatch,
  type RecoveredChatRunDispatch,
  type StandaloneChatRunDispatchLease,
} from "../runs";
import { runDatabaseOperationsWithPerCallCap } from "../../database";
import { purgeExpiredStandaloneChatRunDispatchCredentials } from "../runs/standaloneDispatch";
import { readStandaloneCredentialKeyring, type StandaloneCredentialKeyring } from "../runs/standaloneCredential";
import { readStandaloneAiFunding } from "../deployment";
import { CHAT_RUN_STALE_HEARTBEAT_MS } from "./lease";
import type { ChatWorkerEvent } from "./index";
import type { handleChatWorkerEvent } from "./index";

/**
 * The standalone chat worker: a long-running process that leases durable dispatch rows
 * (`ai.chat_run_dispatches`) and runs each through the same `handleChatWorkerEvent` the Lambda uses; the
 * claim asserts this worker's exact, unexpired dispatch lease in the claim transaction and accepts only a
 * `queued` run. Recovery is part of the same loop: an expired lease on a never-claimed run is
 * delivered again (bounded by `maxAttempts`); a claimed run whose heartbeat went stale is interrupted and
 * never executed a second time, because its model or tool calls may already have had effects.
 */

export type StandaloneChatWorkerConfig = Readonly<{
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseDurationMs: number;
  maxAttempts: number;
  recoveryIntervalMs: number;
  runTimeoutMs: number;
  shutdownGraceMs: number;
  /** From NIBOMO_CHAT_CREDENTIAL_KEY_FILE; absent/null = runs that need a personal key are interrupted. */
  credentialKeyring?: StandaloneCredentialKeyring | null;
  /** NIBOMO_STANDALONE_AI_FUNDING=user-key: runs without a sealed personal key end before the provider. */
  personalCredentialRequired?: boolean;
}>;

export type StandaloneChatWorkerLogRecord = Readonly<{
  action: string;
  runId?: string;
  sessionId?: string;
  workspaceId?: string;
  chatRequestId?: string;
  attemptCount?: number;
  outcome?: string;
  runStatus?: string | null;
  errorClass?: string;
  errorMessage?: string;
  count?: number;
}>;

export type StandaloneChatWorkerDependencies = Readonly<{
  leaseDispatches: typeof leaseStandaloneChatRunDispatches;
  completeDispatch: typeof completeStandaloneChatRunDispatch;
  recoverDispatches: typeof recoverStandaloneChatRunDispatches;
  purgeExpiredCredentials: typeof purgeExpiredStandaloneChatRunDispatchCredentials;
  interruptAbandonedRun: typeof interruptAbandonedStandaloneChatRun;
  handleEvent: typeof handleChatWorkerEvent;
  log: (record: StandaloneChatWorkerLogRecord) => void;
}>;

export type StandaloneChatWorkerHealth = Readonly<{
  started: boolean;
  stopping: boolean;
  inFlight: number;
  lastPollSucceededAtMs: number | null;
  lastPollFailed: boolean;
}>;

export type StandaloneChatWorker = Readonly<{
  /** Runs the poll/recovery loop until `stop` is called. */
  run: () => Promise<void>;
  /** Stops leasing and waits up to the grace period for in-flight runs; returns how many were left. */
  stop: () => Promise<number>;
  /** One lease round; starts the leased runs and returns their promises (used by tests). */
  pollOnce: () => Promise<ReadonlyArray<Promise<void>>>;
  recoverOnce: () => Promise<ReadonlyArray<RecoveredChatRunDispatch>>;
  health: () => StandaloneChatWorkerHealth;
}>;

const DATABASE_CALL_CAP_MS = 10_000;
const RECOVERY_BATCH_LIMIT = 50;
const CREDENTIAL_PURGE_BATCH_LIMIT = 500;

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return defaultValue;
  const value = /^[0-9]+$/u.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function readStandaloneChatWorkerConfig(env: NodeJS.ProcessEnv = process.env): StandaloneChatWorkerConfig {
  const explicitId = env.CHAT_WORKER_ID?.trim() ?? "";
  const workerId = explicitId !== "" ? explicitId : `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  if (workerId.length > 200 || /[\u0000-\u001f\u007f]/u.test(workerId)) {
    throw new Error("CHAT_WORKER_ID must be at most 200 printable characters");
  }
  return {
    workerId,
    concurrency: readBoundedInteger(env, "CHAT_WORKER_CONCURRENCY", 2, 1, 16),
    pollIntervalMs: readBoundedInteger(env, "CHAT_WORKER_POLL_INTERVAL_MS", 1_000, 100, 30_000),
    // Covers only lease -> claim. Once claimed, the run's own heartbeat decides what recovery may do.
    leaseDurationMs: readBoundedInteger(env, "CHAT_WORKER_LEASE_MS", 60_000, 5_000, 600_000),
    maxAttempts: readBoundedInteger(env, "CHAT_WORKER_MAX_ATTEMPTS", 3, 1, 10),
    recoveryIntervalMs: readBoundedInteger(env, "CHAT_WORKER_RECOVERY_INTERVAL_MS", 10_000, 1_000, 300_000),
    // The Lambda worker's own timeout; the runtime reserves its terminal-persistence margins inside it.
    runTimeoutMs: readBoundedInteger(env, "CHAT_WORKER_RUN_TIMEOUT_MS", 900_000, 240_000, 900_000),
    shutdownGraceMs: readBoundedInteger(env, "CHAT_WORKER_SHUTDOWN_GRACE_MS", 30_000, 0, 900_000),
    credentialKeyring: readStandaloneCredentialKeyring(env),
    personalCredentialRequired: readStandaloneAiFunding(env) === "user-key",
  };
}

function describeError(error: unknown): Readonly<{ errorClass: string; errorMessage: string }> {
  return error instanceof Error
    ? { errorClass: error.name, errorMessage: error.message }
    : { errorClass: "NonError", errorMessage: String(error) };
}

function createDispatchEvent(dispatch: LeasedChatRunDispatch): ChatWorkerEvent {
  return {
    runId: dispatch.runId,
    userId: dispatch.userId,
    workspaceId: dispatch.workspaceId,
    sessionId: dispatch.sessionId,
    chatRequestId: dispatch.chatRequestId,
    routeRequestId: null,
    // The claimed run row's own value decides; `true` only lets it through (`isGeneratedImageEligibleForWorker`),
    // which is what the Lambda path achieves by copying the same row value into its payload.
    initiatingAuthIsSignedIn: true,
    browserGuestSessionId: null,
    userOpenAIApiKey: null,
    traceContext: null,
  };
}

export function createStandaloneChatWorker(
  config: StandaloneChatWorkerConfig,
  dependencies: StandaloneChatWorkerDependencies,
): StandaloneChatWorker {
  const inFlight = new Set<Promise<void>>();
  let started = false;
  let stopping = false;
  let lastPollSucceededAtMs: number | null = null;
  let lastPollFailed = false;
  let nextRecoveryAtMs = 0;
  let wake: (() => void) | null = null;
  let loopDone: Promise<void> | null = null;

  const signalWake = (): void => {
    const current = wake;
    wake = null;
    current?.();
  };

  /** Every lease this worker holds (leased or re-leased by its recovery) is owned under `workerId`. */
  const leaseOf = (
    dispatch: Readonly<{ runId: string; sessionId: string; userId: string; workspaceId: string }>,
    leaseToken: string,
  ): StandaloneChatRunDispatchLease => ({
    runId: dispatch.runId,
    sessionId: dispatch.sessionId,
    userId: dispatch.userId,
    workspaceId: dispatch.workspaceId,
    leaseToken,
    leaseOwner: config.workerId,
  });

  const withCap = <Result>(operation: () => Promise<Result>): Promise<Result> =>
    runDatabaseOperationsWithPerCallCap(DATABASE_CALL_CAP_MS, operation);

  async function processDispatch(dispatch: LeasedChatRunDispatch): Promise<void> {
    const context = {
      runId: dispatch.runId,
      sessionId: dispatch.sessionId,
      workspaceId: dispatch.workspaceId,
      chatRequestId: dispatch.chatRequestId,
      attemptCount: dispatch.attemptCount,
    };
    const deadlineAtMs = Date.now() + config.runTimeoutMs;
    dependencies.log({ action: "chat_worker_dispatch_leased", ...context });
    try {
      await dependencies.handleEvent(createDispatchEvent(dispatch), {
        lambdaRequestId: config.workerId,
        getRemainingTimeInMillis: () => deadlineAtMs - Date.now(),
        claimMode: {
          mode: "standalone_dispatch_lease",
          lease: leaseOf(dispatch, dispatch.leaseToken),
          credentialKeyring: config.credentialKeyring ?? null,
          personalCredentialRequired: config.personalCredentialRequired === true,
        },
      });
    } catch (error) {
      // The lease is left to expire: recovery delivers a still-queued run again (bounded) and interrupts
      // a claimed one once its heartbeat is stale. Nothing here retries the provider.
      dependencies.log({ action: "chat_worker_dispatch_failed", ...context, ...describeError(error) });
      return;
    }
    try {
      const completed = await withCap(() => dependencies.completeDispatch(dispatch.runId, dispatch.leaseToken));
      dependencies.log({ action: "chat_worker_dispatch_done", ...context, outcome: completed ? "completed" : "lease_taken_over" });
    } catch (error) {
      dependencies.log({ action: "chat_worker_dispatch_complete_failed", ...context, ...describeError(error) });
    }
  }

  function track(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      inFlight.delete(tracked);
      signalWake();
    });
    inFlight.add(tracked);
    return tracked;
  }

  async function pollOnce(): Promise<ReadonlyArray<Promise<void>>> {
    const free = config.concurrency - inFlight.size;
    if (free <= 0 || stopping) return [];
    let leased: ReadonlyArray<LeasedChatRunDispatch>;
    try {
      leased = await withCap(() => dependencies.leaseDispatches(config.workerId, config.leaseDurationMs, free));
      lastPollSucceededAtMs = Date.now();
      lastPollFailed = false;
    } catch (error) {
      lastPollFailed = true;
      dependencies.log({ action: "chat_worker_poll_failed", ...describeError(error) });
      return [];
    }
    return leased.map((dispatch) => track(processDispatch(dispatch)));
  }

  async function settleRecovered(row: RecoveredChatRunDispatch): Promise<void> {
    const context = {
      runId: row.runId,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      chatRequestId: row.chatRequestId,
      attemptCount: row.attemptCount,
      outcome: row.outcome,
    };
    if (row.outcome !== "exhausted" && row.outcome !== "ambiguous") {
      dependencies.log({ action: "chat_worker_dispatch_recovered", ...context });
      return;
    }
    if (row.leaseToken === null) {
      throw new Error(`Recovered ${row.outcome} dispatch has no lease token: ${row.runId}`);
    }
    const leaseToken = row.leaseToken;
    const result = await withCap(() => dependencies.interruptAbandonedRun(leaseOf(row, leaseToken)));
    if (!result.leaseHeld) {
      // Another holder took the row over (or this lease expired): its holder settles it, not this one.
      dependencies.log({ action: "chat_worker_dispatch_recovered", ...context, outcome: "lease_lost" });
      return;
    }
    dependencies.log({
      action: "chat_worker_dispatch_recovered",
      ...context,
      runStatus: result.interrupted ? "interrupted" : result.foundStatus,
    });
    // A run whose heartbeat is fresh again still belongs to its worker; the row stays leased to this
    // recoverer and a later sweep settles it once the run ends.
    if (!result.interrupted && result.foundStatus === "running") {
      return;
    }
    await withCap(() => dependencies.completeDispatch(row.runId, leaseToken));
  }

  async function recoverOnce(): Promise<ReadonlyArray<RecoveredChatRunDispatch>> {
    // Sealed personal keys past their expiry are deleted whether or not their run was ever claimed.
    const purged = await withCap(() => dependencies.purgeExpiredCredentials(CREDENTIAL_PURGE_BATCH_LIMIT));
    if (purged > 0) dependencies.log({ action: "chat_worker_credentials_purged", count: purged });
    const recovered = await withCap(() => dependencies.recoverDispatches({
      leaseOwner: config.workerId,
      maxAttempts: config.maxAttempts,
      staleHeartbeatMs: CHAT_RUN_STALE_HEARTBEAT_MS,
      leaseDurationMs: config.leaseDurationMs,
      limit: RECOVERY_BATCH_LIMIT,
    }));
    for (const row of recovered) {
      try {
        await settleRecovered(row);
      } catch (error) {
        // Its new lease expires and the next sweep classifies it again.
        dependencies.log({
          action: "chat_worker_recovery_settle_failed", runId: row.runId, outcome: row.outcome, ...describeError(error),
        });
      }
    }
    return recovered;
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      if (Date.now() >= nextRecoveryAtMs) {
        nextRecoveryAtMs = Date.now() + config.recoveryIntervalMs;
        try {
          await recoverOnce();
        } catch (error) {
          dependencies.log({ action: "chat_worker_recovery_failed", ...describeError(error) });
        }
      }
      await pollOnce();
      if (stopping) break;
      // A finishing run wakes the loop early (`track`), so a full worker picks up waiting rows at once.
      const delayMs = config.pollIntervalMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, delayMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  return {
    run: async () => {
      if (started) throw new Error("The standalone chat worker is already running");
      started = true;
      dependencies.log({ action: "chat_worker_started", count: config.concurrency });
      loopDone = loop();
      await loopDone;
    },
    stop: async () => {
      stopping = true;
      signalWake();
      await loopDone;
      if (inFlight.size > 0 && config.shutdownGraceMs > 0) {
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise<void>((resolve) => setTimeout(resolve, config.shutdownGraceMs).unref()),
        ]);
      }
      dependencies.log({ action: "chat_worker_stopped", count: inFlight.size });
      return inFlight.size;
    },
    pollOnce,
    recoverOnce,
    health: () => ({
      started,
      stopping,
      inFlight: inFlight.size,
      lastPollSucceededAtMs,
      lastPollFailed,
    }),
  };
}

export const DEFAULT_STANDALONE_CHAT_WORKER_DEPENDENCIES: Omit<StandaloneChatWorkerDependencies, "handleEvent" | "log"> = {
  leaseDispatches: leaseStandaloneChatRunDispatches,
  completeDispatch: completeStandaloneChatRunDispatch,
  recoverDispatches: recoverStandaloneChatRunDispatches,
  purgeExpiredCredentials: purgeExpiredStandaloneChatRunDispatchCredentials,
  interruptAbandonedRun: interruptAbandonedStandaloneChatRun,
};
