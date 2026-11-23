import OpenAI from "openai";
import type { UserOpenAIApiKey } from "../userOpenAIApiKey";
import { getOpenAIProviderEndpoint } from "./providerEndpoint";

let client: OpenAI | null = null;

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  return apiKey;
}

export function getOpenAIClient(): OpenAI {
  if (client !== null) {
    return client;
  }

  client = new OpenAI({
    apiKey: getApiKey(),
    baseURL: getOpenAIProviderEndpoint().baseURL,
  });
  return client;
}

/**
 * Builds a client from the person's own key for one chat run or one request. It is never memoized, so the key
 * lives no longer than the run or request that carried it, and the platform's organization and project are
 * never attached to someone else's key. It uses the same validated endpoint as the operator client, so a
 * configured proxy never silently falls back to the default endpoint.
 */
export function createUserOpenAIClient(userOpenAIApiKey: UserOpenAIApiKey): OpenAI {
  return new OpenAI({
    apiKey: userOpenAIApiKey.revealRawValue(),
    baseURL: getOpenAIProviderEndpoint().baseURL,
    organization: null,
    project: null,
  });
}
