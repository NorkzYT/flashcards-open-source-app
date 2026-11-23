import { isStandaloneChatDeployment } from "../deployment";

/** The SDK's own default, passed explicitly so an unset or empty setting can never be read twice. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
export const STANDALONE_OPENAI_MODEL_ENV = "NIBOMO_OPENAI_MODEL";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export type OpenAIProviderEndpoint = Readonly<{
  /** Where every OpenAI client of this process sends requests, operator and personal keys alike. */
  baseURL: string;
  /** False on the default endpoint; true when the operator pointed the process at a compatible proxy. */
  custom: boolean;
  /** Standalone-only model sent instead of the built-in chat and suggestion models; null = built-in. */
  modelOverride: string | null;
}>;

/**
 * Reads `OPENAI_BASE_URL` and `NIBOMO_OPENAI_MODEL` once and validates them. Errors never echo the raw
 * value: a malformed URL may carry credentials. The SDK would otherwise read `OPENAI_BASE_URL` on its own
 * and accept anything, so clients always receive the resolved URL explicitly.
 */
export function readOpenAIProviderEndpoint(env: NodeJS.ProcessEnv = process.env): OpenAIProviderEndpoint {
  const rawBaseURL = env[OPENAI_BASE_URL_ENV]?.trim() ?? "";
  const rawModel = env[STANDALONE_OPENAI_MODEL_ENV]?.trim() ?? "";
  if (rawModel !== "" && !isStandaloneChatDeployment(env)) {
    throw new Error(`${STANDALONE_OPENAI_MODEL_ENV} is only supported with NIBOMO_DEPLOYMENT=standalone`);
  }
  if (rawModel !== "" && !MODEL_PATTERN.test(rawModel)) {
    throw new Error(
      `${STANDALONE_OPENAI_MODEL_ENV} must be 1-128 characters of letters, digits and . _ : / - starting with a letter or digit`,
    );
  }
  if (rawBaseURL === "") {
    return { baseURL: OPENAI_DEFAULT_BASE_URL, custom: false, modelOverride: rawModel === "" ? null : rawModel };
  }
  return { baseURL: parseBaseURL(rawBaseURL), custom: true, modelOverride: rawModel === "" ? null : rawModel };
}

function parseBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${OPENAI_BASE_URL_ENV} must be an absolute http(s) URL such as http://proxy:8317/v1`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${OPENAI_BASE_URL_ENV} must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${OPENAI_BASE_URL_ENV} must not contain credentials; the key is read from OPENAI_API_KEY_FILE`);
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new Error(`${OPENAI_BASE_URL_ENV} must not contain a query string or fragment`);
  }
  return url.href.replace(/\/+$/u, "");
}

/**
 * Read on every client construction, never cached: personal-key clients are built per run and must follow the
 * process setting, and the memoized operator client reads it exactly once.
 */
export function getOpenAIProviderEndpoint(): OpenAIProviderEndpoint {
  return readOpenAIProviderEndpoint();
}

/** The model sent on the wire for a built-in model id: the standalone override when one is configured. */
export function resolveOpenAIRequestModel(builtInModelId: string): string {
  return getOpenAIProviderEndpoint().modelOverride ?? builtInModelId;
}
