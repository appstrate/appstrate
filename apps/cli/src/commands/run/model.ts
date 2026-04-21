// SPDX-License-Identifier: Apache-2.0

/**
 * Model + API-key resolution for `appstrate run`.
 *
 * The CLI lets users provide their own LLM credentials — we never pull
 * them from the Appstrate instance. This mirrors `bun run` philosophy:
 * the user is an operator of their own LLM accounts.
 *
 * Resolution order (first winner):
 *   1. `--model-api <api>` + `--model <id>` flags
 *   2. `APPSTRATE_MODEL_API` + `APPSTRATE_MODEL_ID` env vars
 *   3. Defaults: anthropic-messages + claude-sonnet-4-5
 *
 * For the API key we check provider-specific env vars in order:
 *   anthropic      → ANTHROPIC_API_KEY
 *   openai         → OPENAI_API_KEY
 *   mistral        → MISTRAL_API_KEY
 *   google         → GOOGLE_API_KEY
 * then the generic LLM_API_KEY / APPSTRATE_LLM_API_KEY.
 *
 * A missing key is a hard error before any network call — early exit
 * with an actionable message is better UX than a 401 from the upstream.
 */

import type { Api, Model } from "@mariozechner/pi-ai";

export interface ModelFlags {
  modelApi?: string;
  model?: string;
  llmApiKey?: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
}

const PROVIDER_BY_API: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
};

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export function resolveModel(flags: ModelFlags): ResolvedModel {
  const api = flags.modelApi ?? process.env.APPSTRATE_MODEL_API ?? "anthropic-messages";
  const modelId = flags.model ?? process.env.APPSTRATE_MODEL_ID ?? "claude-sonnet-4-5";

  const provider = PROVIDER_BY_API[api];
  if (!provider) {
    throw new ModelResolutionError(
      `Unknown --model-api "${api}"`,
      `Accepted values: ${Object.keys(PROVIDER_BY_API).join(", ")}`,
    );
  }

  const providerEnvKey = ENV_KEY_BY_PROVIDER[provider];
  const apiKey =
    flags.llmApiKey ??
    (providerEnvKey ? process.env[providerEnvKey] : undefined) ??
    process.env.APPSTRATE_LLM_API_KEY ??
    process.env.LLM_API_KEY;

  if (!apiKey) {
    const want = providerEnvKey ? `$${providerEnvKey}` : "$APPSTRATE_LLM_API_KEY";
    throw new ModelResolutionError(
      `No LLM API key resolved for provider "${provider}"`,
      `Set ${want} or pass --llm-api-key. (Model API: ${api})`,
    );
  }

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: api as Api,
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };

  return { model, apiKey };
}

/** Exported for tests. */
export const _PROVIDER_BY_API_FOR_TESTING = PROVIDER_BY_API;
