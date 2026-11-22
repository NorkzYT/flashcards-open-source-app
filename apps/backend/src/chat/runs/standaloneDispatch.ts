import type { DatabaseExecutor, WorkspaceDatabaseScope } from "../../database";
import { unsafeQuery } from "../../database/unsafe";
import type { SealedStandaloneCredential, StandaloneCredentialBinding } from "./standaloneCredential";

/**
 * Standalone dispatch rows (`ai.chat_run_dispatches`, db/migrations/0255_chat_run_standalone_dispatch.sql).
 * The runtime role may only insert its own queued run; leasing, completion and recovery go through the
 * migration's SECURITY DEFINER functions, so no request scope can read or alter another tenant's queue.
 */

export type LeasedChatRunDispatch = Readonly<{
  runId: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
  chatRequestId: string;
  leaseToken: string;
  attemptCount: number;
}>;

export type RecoveredChatRunDispatchOutcome = "requeued" | "exhausted" | "ambiguous" | "settled";

export type RecoveredChatRunDispatch = Readonly<{
  runId: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
  chatRequestId: string;
  outcome: RecoveredChatRunDispatchOutcome;
  /** Set for `exhausted` and `ambiguous`: the recoverer now holds the row until it completes it. */
  leaseToken: string | null;
  attemptCount: number;
}>;

/**
 * The exact lease a standalone holder acts under. The claim and the recovery interruption assert it in
 * their own transaction (`ai.assert_chat_run_dispatch_lease`, 0258) before touching the run.
 */
export type StandaloneChatRunDispatchLease = Readonly<{
  runId: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
  leaseToken: string;
  leaseOwner: string;
}>;

type DispatchRow = Readonly<{
  run_id: string;
  session_id: string;
  user_id: string;
  workspace_id: string;
  chat_request_id: string;
  lease_token: string | null;
  attempt_count: number;
}>;

type RecoveredDispatchRow = DispatchRow & Readonly<{ outcome: string }>;

const INSERT_CHAT_RUN_DISPATCH_SQL = `
  INSERT INTO ai.chat_run_dispatches (run_id, session_id, user_id, workspace_id, chat_request_id, requires_user_credential)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

const INSERT_CHAT_RUN_DISPATCH_CREDENTIAL_SQL = `
  INSERT INTO ai.chat_run_dispatch_credentials
    (run_id, session_id, user_id, workspace_id, key_id, nonce, ciphertext, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * Runs inside the transaction that inserts the queued run, so the run, its dispatch and (for a personal
 * key) the sealed credential commit together. `sealCredential` receives the final binding, because the
 * ciphertext's AAD names the run.
 */
export async function enqueueStandaloneChatRunDispatchWithExecutor(
  executor: DatabaseExecutor,
  scope: WorkspaceDatabaseScope,
  params: Readonly<{ runId: string; sessionId: string; chatRequestId: string }>,
  sealCredential: ((binding: StandaloneCredentialBinding) => SealedStandaloneCredential) | null,
): Promise<void> {
  await executor.query(INSERT_CHAT_RUN_DISPATCH_SQL, [
    params.runId,
    params.sessionId,
    scope.userId,
    scope.workspaceId,
    params.chatRequestId,
    sealCredential !== null,
  ]);
  if (sealCredential === null) return;
  const sealed = sealCredential({
    runId: params.runId, sessionId: params.sessionId, userId: scope.userId, workspaceId: scope.workspaceId,
  });
  await executor.query(INSERT_CHAT_RUN_DISPATCH_CREDENTIAL_SQL, [
    params.runId,
    params.sessionId,
    scope.userId,
    scope.workspaceId,
    sealed.keyId,
    // bytea hex input: SqlValue carries no Buffer, and this keeps the parameter a plain string.
    `\\x${sealed.nonce.toString("hex")}`,
    `\\x${sealed.ciphertext.toString("hex")}`,
    sealed.expiresAt.toISOString(),
  ]);
}

type TakenCredentialRow = Readonly<{
  required: boolean;
  key_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  expires_at: Date | string | null;
}>;

/**
 * Inside the claim transaction, after the lease assertion: deletes and returns this run's sealed credential.
 * `required` true with `sealed` null means the person's key was expected but is gone, expired or mis-bound;
 * the caller must not fall back to the operator key. Throws when the lease is not held (SQLSTATE 55000).
 */
export async function takeStandaloneChatRunDispatchCredentialWithExecutor(
  executor: DatabaseExecutor,
  lease: StandaloneChatRunDispatchLease,
): Promise<Readonly<{ required: boolean; sealed: SealedStandaloneCredential | null }>> {
  const result = await executor.query<TakenCredentialRow>(
    `SELECT required, key_id, nonce, ciphertext, expires_at
     FROM ai.take_chat_run_dispatch_credential($1, $2, $3, $4, $5, $6)`,
    [lease.runId, lease.sessionId, lease.userId, lease.workspaceId, lease.leaseToken, lease.leaseOwner],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Credential take returned no row: ${lease.runId}`);
  if (row.key_id === null || row.nonce === null || row.ciphertext === null || row.expires_at === null) {
    return { required: row.required, sealed: null };
  }
  return {
    required: true,
    sealed: { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, expiresAt: new Date(row.expires_at) },
  };
}

export async function purgeExpiredStandaloneChatRunDispatchCredentials(limit: number): Promise<number> {
  const result = await unsafeQuery<Readonly<{ purged: number }>>(
    "SELECT ai.purge_expired_chat_run_dispatch_credentials($1) AS purged",
    [limit],
  );
  return result.rows[0]?.purged ?? 0;
}

/**
 * Locks the dispatch row and reports whether `lease` is still its exact, unexpired holder. Call it first
 * in the transaction that claims or interrupts the run (dispatch row before run row before session row).
 */
export async function assertStandaloneChatRunDispatchLeaseWithExecutor(
  executor: DatabaseExecutor,
  lease: StandaloneChatRunDispatchLease,
): Promise<boolean> {
  const result = await executor.query<Readonly<{ held: boolean }>>(
    "SELECT ai.assert_chat_run_dispatch_lease($1, $2, $3, $4, $5, $6) AS held",
    [lease.runId, lease.sessionId, lease.userId, lease.workspaceId, lease.leaseToken, lease.leaseOwner],
  );
  return result.rows[0]?.held === true;
}

export async function leaseStandaloneChatRunDispatches(
  leaseOwner: string,
  leaseDurationMs: number,
  limit: number,
): Promise<ReadonlyArray<LeasedChatRunDispatch>> {
  const result = await unsafeQuery<DispatchRow>(
    `SELECT run_id, session_id, user_id, workspace_id, chat_request_id, lease_token, attempt_count
     FROM ai.lease_chat_run_dispatches($1, $2, $3)`,
    [leaseOwner, leaseDurationMs, limit],
  );
  return result.rows.map((row) => {
    if (row.lease_token === null) {
      throw new Error(`Leased chat run dispatch has no lease token: ${row.run_id}`);
    }
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      chatRequestId: row.chat_request_id,
      leaseToken: row.lease_token,
      attemptCount: row.attempt_count,
    };
  });
}

/** Returns false when the lease was already taken over by recovery or the row was removed. */
export async function completeStandaloneChatRunDispatch(runId: string, leaseToken: string): Promise<boolean> {
  const result = await unsafeQuery<Readonly<{ completed: boolean }>>(
    "SELECT ai.complete_chat_run_dispatch($1, $2) AS completed",
    [runId, leaseToken],
  );
  return result.rows[0]?.completed === true;
}

function readRecoveredOutcome(value: string): RecoveredChatRunDispatchOutcome {
  if (value === "requeued" || value === "exhausted" || value === "ambiguous" || value === "settled") {
    return value;
  }
  throw new Error(`Unknown chat run dispatch recovery outcome: ${value}`);
}

export async function recoverStandaloneChatRunDispatches(
  params: Readonly<{
    leaseOwner: string;
    maxAttempts: number;
    staleHeartbeatMs: number;
    leaseDurationMs: number;
    limit: number;
  }>,
): Promise<ReadonlyArray<RecoveredChatRunDispatch>> {
  const result = await unsafeQuery<RecoveredDispatchRow>(
    `SELECT run_id, session_id, user_id, workspace_id, chat_request_id, outcome, lease_token, attempt_count
     FROM ai.recover_chat_run_dispatches($1, $2, $3, $4, $5)`,
    [params.leaseOwner, params.maxAttempts, params.staleHeartbeatMs, params.leaseDurationMs, params.limit],
  );
  return result.rows.map((row) => ({
    runId: row.run_id,
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    chatRequestId: row.chat_request_id,
    outcome: readRecoveredOutcome(row.outcome),
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
  }));
}
