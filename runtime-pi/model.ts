// SPDX-License-Identifier: Apache-2.0

import { deriveProviderFromApi } from "@appstrate/runner-pi";
import type { Api, Model } from "./pi-sdk.ts";
import type { RuntimeEnv } from "./env.ts";

/**
 * Build the exact Pi model used by the container runtime.
 *
 * `modelBaseUrl` normally points at the per-run sidecar, so Pi cannot infer
 * provider compatibility from the URL. `MODEL_PROVIDER` preserves the real
 * upstream identity; the api-derived fallback keeps older/self-hosted
 * launchers compatible.
 */
export function buildRuntimeModel(env: RuntimeEnv): Model<Api> {
  const api = env.modelApi;
  const modelId = env.modelId;
  // Upstream identity is only a compatibility input for the OpenAI-compatible
  // adapter. Native APIs keep their historical AuthStorage provider key
  // (`codex` still authenticates under `openai`, Google under `google`, etc.).
  const provider =
    api === "openai-completions" && env.modelProvider
      ? env.modelProvider
      : deriveProviderFromApi(api);
  // Pi normally detects OpenAI-compatible quirks from the upstream URL. A
  // sidecar-backed model only exposes `http://sidecar/llm`, so that signal is
  // gone. Preserve the URL-derived flags Pi 0.73.1 cannot recover from our
  // provider ids (`deepseek` is only partially recognised and Appstrate names
  // Moonshot `moonshot`, while Pi expects `moonshotai`).
  const compat =
    api !== "openai-completions"
      ? undefined
      : provider === "deepseek"
        ? { supportsDeveloperRole: false, supportsStore: false }
        : provider === "moonshot"
          ? {
              supportsDeveloperRole: false,
              supportsStore: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens" as const,
              supportsStrictMode: false,
            }
          : undefined;
  return {
    id: modelId,
    name: modelId,
    api: api as Api,
    provider,
    baseUrl: env.modelBaseUrl ?? "",
    reasoning: env.modelReasoning,
    input: [...env.modelInput],
    cost: env.modelCost,
    contextWindow: env.modelContextWindow,
    maxTokens: env.modelMaxTokens,
    ...(compat ? { compat } : {}),
  };
}
