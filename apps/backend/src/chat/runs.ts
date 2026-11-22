/**
 * Public facade for backend-owned chat run lifecycle APIs.
 * Internal implementation is split across focused modules under `./runs/`.
 */
export type {
  ChatRunActor,
  ChatRunClaimToken,
  ChatRunHeartbeatState,
  ChatRunSnapshot,
  ChatRunStatus,
  ChatRunStopState,
  ClaimedChatRun,
  PreparedChatRun,
  RecoveredChatSession,
  RecoveredPaginatedSession,
} from "./runs/types";

export {
  recordAiLimitReachedAnalytics,
  recordAiMessageSentAnalytics,
  recordAiRunFailedAnalytics,
} from "./runs/analytics";

export {
  assertActiveChatRunClaimWithExecutor,
  getActiveChatRunClientDeviceWithExecutor,
  InactiveChatRunClaimError,
} from "./runs/claimFence";
export type { ChatRunClaimFenceParams, ChatRunClaimState } from "./runs/claimFence";

export { archiveChatSession } from "./runs/historyService";

export {
  claimChatLiveAttachOwnership,
  getChatRunSnapshot,
  getRecoveredChatSession,
  getRecoveredChatSessionSnapshot,
  getRecoveredPaginatedSession,
} from "./runs/readService";

export {
  claimChatRun,
  completeClaimedChatRun,
  failQueuedChatRun,
  interruptAbandonedStandaloneChatRun,
  interruptPreparedChatRun,
  markQueuedChatRunDispatchFailed,
  persistClaimedChatRunCancelled,
  persistClaimedChatRunTerminalError,
  prepareChatRun,
  reconcileInactiveClaimedChatRun,
  requestChatRunCancellation,
  touchClaimedChatRunHeartbeat,
} from "./runs/lifecycleService";
export type { ChatRunClaimMode } from "./runs/lifecycleService";

export {
  completeStandaloneChatRunDispatch,
  leaseStandaloneChatRunDispatches,
  recoverStandaloneChatRunDispatches,
} from "./runs/standaloneDispatch";
export type {
  LeasedChatRunDispatch,
  RecoveredChatRunDispatch,
  RecoveredChatRunDispatchOutcome,
  StandaloneChatRunDispatchLease,
} from "./runs/standaloneDispatch";
