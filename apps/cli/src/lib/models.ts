// SPDX-License-Identifier: Apache-2.0

/**
 * Model-preset helpers for the CLI — list org models for `appstrate models`
 * and `appstrate run --model-source preset`.
 *
 * The CLI never sees upstream provider API keys. It only enumerates
 * **preset ids** exposed by `GET /api/models` — the platform's LLM proxy
 * (`/api/llm-proxy/<api>/…`) resolves the preset server-side and injects
 * the real upstream credentials.
 */

import { apiFetch } from "./api.ts";

export interface ModelPreset {
  id: string;
  label: string;
  /**
   * Protocol family the CLI must route through (selects the
   * `/api/llm-proxy/<api>/…` sub-route). Known values today:
   * `openai-completions`, `anthropic-messages`, `openai-responses`,
   * `google-generative-ai`, `google-vertex`, `azure-openai-responses`,
   * `bedrock-converse-stream`.
   */
  api: string;
  enabled: boolean;
  isDefault: boolean;
  source: "built-in" | "custom";
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  input: string[] | null;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
}

interface ListResponse {
  object?: "list";
  data?: ModelPreset[];
  hasMore?: boolean;
}

export async function listModelPresets(profileName: string): Promise<ModelPreset[]> {
  const res = await apiFetch<ListResponse>(profileName, "/api/models");
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Protocol families the **CLI** can route through `/api/llm-proxy/*`.
 *
 * Both `openai-completions` and `anthropic-messages` are wired today.
 * The Anthropic case takes a side-channel: pi-ai's Anthropic SDK sends
 * `x-api-key` natively, but the platform's auth pipeline reads
 * `Authorization: Bearer` — so the CLI's preset path injects the bearer
 * token via `model.headers["Authorization"]` and passes a placeholder
 * `apiKey` to keep pi-ai happy. The platform's anthropic adapter strips
 * the inbound `x-api-key` (it isn't in HEADERS_TO_FORWARD) and injects
 * the real upstream key from server-side storage, so the placeholder
 * never reaches Anthropic.
 */
export const PROXY_SUPPORTED_APIS = new Set<string>(["openai-completions", "anthropic-messages"]);
