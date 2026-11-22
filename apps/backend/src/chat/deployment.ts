import { HttpError } from "../shared/errors";

/**
 * How chat turns reach a worker. `aws` (the default, also when NIBOMO_DEPLOYMENT is unset) keeps the
 * Lambda dispatch unchanged. `standalone` must be selected explicitly: it enqueues each run in
 * `ai.chat_run_dispatches` inside the run transaction and never falls back to Lambda or any other
 * ambient cloud resource, even when AWS credentials or function names happen to be present.
 */
export type ChatDeploymentMode = "aws" | "standalone";

export function readChatDeploymentMode(env: NodeJS.ProcessEnv = process.env): ChatDeploymentMode {
  const value = env.NIBOMO_DEPLOYMENT?.trim() ?? "";
  if (value === "" || value === "aws") {
    return "aws";
  }
  if (value === "standalone") {
    return "standalone";
  }
  throw new Error(`NIBOMO_DEPLOYMENT must be "aws" or "standalone"; got ${JSON.stringify(value)}`);
}

export function isStandaloneChatDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return readChatDeploymentMode(env) === "standalone";
}

/** Each person's monthly platform-key chat turns when the operator sets no other bound. */
export const STANDALONE_AI_MONTHLY_MESSAGES_DEFAULT = 100;
export const STANDALONE_AI_MONTHLY_MESSAGES_MAXIMUM = 100_000;

/**
 * The operator-funded allowance of a standalone deployment: every person gets the same explicit,
 * bounded number of chat turns a month on the operator's key, whatever their billing tier. No Stripe or
 * store subscription is consulted or implied; "uncapped" is not expressible here on purpose.
 */
export function readStandaloneAiMonthlyMessages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NIBOMO_STANDALONE_AI_MONTHLY_MESSAGES?.trim() ?? "";
  if (raw === "") {
    return STANDALONE_AI_MONTHLY_MESSAGES_DEFAULT;
  }
  const value = /^[0-9]+$/u.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > STANDALONE_AI_MONTHLY_MESSAGES_MAXIMUM) {
    throw new Error(
      `NIBOMO_STANDALONE_AI_MONTHLY_MESSAGES must be an integer from 1 to ${STANDALONE_AI_MONTHLY_MESSAGES_MAXIMUM}`,
    );
  }
  return value;
}

export function hasOperatorOpenAIApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENAI_API_KEY?.trim() ?? "") !== "";
}

export const standaloneOwnOpenAIKeyUnsupportedCode = "OPENAI_API_KEY_NOT_SUPPORTED_STANDALONE";
export const standaloneAiProviderNotConfiguredCode = "AI_PROVIDER_NOT_CONFIGURED";
export const standaloneOwnOpenAIKeyRequiredCode = "OPENAI_API_KEY_REQUIRED_STANDALONE";

/**
 * Who pays for a standalone chat turn (`NIBOMO_STANDALONE_AI_FUNDING`). `operator` (the default, also when
 * unset) runs keyless turns on the operator's `OPENAI_API_KEY` within the monthly allowance and accepts
 * sealed personal keys only when sealing is configured. `user-key` runs only turns that carry the person's
 * own key, sealed for the worker: it has no operator key at all (one being set is a configuration error,
 * so nothing can silently bill an operator), and a keyless turn is refused before anything is written.
 */
export type StandaloneAiFunding = "operator" | "user-key";
export const STANDALONE_AI_FUNDING_ENV = "NIBOMO_STANDALONE_AI_FUNDING";

export function readStandaloneAiFunding(env: NodeJS.ProcessEnv = process.env): StandaloneAiFunding {
  const value = env[STANDALONE_AI_FUNDING_ENV]?.trim() ?? "";
  if (value === "" || value === "operator") {
    return "operator";
  }
  if (value === "user-key") {
    return "user-key";
  }
  throw new Error(`${STANDALONE_AI_FUNDING_ENV} must be "operator" or "user-key"; got ${JSON.stringify(value)}`);
}

/**
 * Startup check shared by the API and the worker (both must agree). Throws when `user-key` funding is
 * selected without credential sealing (`NIBOMO_CHAT_CREDENTIAL_KEY_FILE`) or with an operator key present.
 */
export function assertStandaloneAiFundingConfigured(
  personalKeysSealable: boolean,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneAiFunding {
  const funding = readStandaloneAiFunding(env);
  if (funding === "user-key") {
    if (!personalKeysSealable) {
      throw new Error(
        `${STANDALONE_AI_FUNDING_ENV}=user-key needs NIBOMO_CHAT_CREDENTIAL_KEY_FILE and NIBOMO_INSTANCE_ID: personal keys can only reach the worker sealed`,
      );
    }
    if (hasOperatorOpenAIApiKey(env)) {
      throw new Error(
        `${STANDALONE_AI_FUNDING_ENV}=user-key must not be combined with OPENAI_API_KEY; use operator funding to run turns on the operator's key`,
      );
    }
  }
  return funding;
}

/**
 * Refuses a standalone chat turn before anything is written. A personal key must outlive the request in
 * the durable queue, so it is accepted only when the operator configured credential sealing
 * (`NIBOMO_CHAT_CREDENTIAL_KEY_FILE`, `./runs/standaloneCredential.ts`); otherwise the header is refused
 * rather than ignored (ignoring it would silently bill the operator). Operator funding without an operator
 * key says so instead of queuing a run no worker can execute; `user-key` funding refuses keyless turns.
 */
export function assertStandaloneChatTurnAdmissible(
  hasUserOpenAIApiKey: boolean,
  personalKeysSealable: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isStandaloneChatDeployment(env)) {
    return;
  }
  if (hasUserOpenAIApiKey && !personalKeysSealable) {
    throw new HttpError(
      400,
      "This self-hosted server does not accept a personal OpenAI API key for chat. Remove the key to use the server's configured AI provider.",
      standaloneOwnOpenAIKeyUnsupportedCode,
    );
  }
  if (readStandaloneAiFunding(env) === "user-key") {
    if (!hasUserOpenAIApiKey) {
      throw new HttpError(
        400,
        "This self-hosted server runs AI chat only with your own OpenAI API key. Add your key in AI settings and send the message again.",
        standaloneOwnOpenAIKeyRequiredCode,
      );
    }
    return;
  }
  if (!hasOperatorOpenAIApiKey(env)) {
    throw new HttpError(
      503,
      "AI chat is not configured on this self-hosted server: the operator has not set OPENAI_API_KEY.",
      standaloneAiProviderNotConfiguredCode,
    );
  }
  readStandaloneAiMonthlyMessages(env);
}

/**
 * Hosted capabilities that run in the isolated Lambda sandbox (the `bash` tool and attachment
 * derivatives) stay off in standalone mode until a separately reviewed isolated adapter exists. Code
 * must never run inside the API or worker process, which hold database credentials.
 */
export function isChatSandboxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isStandaloneChatDeployment(env);
}

export const STANDALONE_SANDBOX_UNAVAILABLE_MESSAGE =
  "File conversion and code execution are not available on this self-hosted server";
