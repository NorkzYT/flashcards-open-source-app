import { listChatSessionFiles, type ChatFileDerivativeIndex, type prepareChatFileDerivatives } from "../../../chatFiles";
import { findChatFileDerivativeKind } from "../../../chatSandbox/contract";
import { isChatSandboxAvailable, STANDALONE_SANDBOX_UNAVAILABLE_MESSAGE } from "../../deployment";

/**
 * Without the isolated sandbox, attachments that need conversion are described to the model as not
 * converted, with the reason, instead of invoking the hosted sandbox. Nothing is written, so a later
 * deployment with a reviewed sandbox adapter still prepares them.
 */
export const prepareChatFileDerivativesWithoutSandbox: typeof prepareChatFileDerivatives = async (scope, sessionId) => {
  const files = await listChatSessionFiles(scope, sessionId);
  const derivedPathsBySource = new Map<string, Array<string>>();
  for (const file of files) {
    if (file.sourceFileId !== null) {
      derivedPathsBySource.set(file.sourceFileId, [...(derivedPathsBySource.get(file.sourceFileId) ?? []), file.path]);
    }
  }
  const index = new Map<string, Readonly<{ derivedPaths: ReadonlyArray<string>; error: string | null }>>();
  for (const file of files) {
    if (file.origin !== "attachment") continue;
    if (file.derivativesPrepared) {
      index.set(file.fileId, { derivedPaths: derivedPathsBySource.get(file.fileId) ?? [], error: file.derivativesError });
    } else if (findChatFileDerivativeKind(file.mediaType) !== null) {
      index.set(file.fileId, { derivedPaths: [], error: STANDALONE_SANDBOX_UNAVAILABLE_MESSAGE });
    }
  }
  return index satisfies ChatFileDerivativeIndex;
};

export const prepareChatFileDerivativesForDeployment = (
  prepareWithSandbox: typeof prepareChatFileDerivatives,
): typeof prepareChatFileDerivatives => async (scope, sessionId, signal, observationScope) => (
  isChatSandboxAvailable()
    ? prepareWithSandbox(scope, sessionId, signal, observationScope)
    : prepareChatFileDerivativesWithoutSandbox(scope, sessionId, signal, observationScope)
);
