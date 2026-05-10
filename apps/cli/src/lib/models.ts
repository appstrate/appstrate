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

import type { ModelCost } from "@appstrate/shared-types";
import { apiList } from "./api.ts";

export interface ModelPreset {
  id: string;
  label: string;
  /**
   * Wire format / API shape the CLI must route through (selects the
   * `/api/llm-proxy/<apiShape>/…` sub-route). Known values today:
   * `openai-completions`, `anthropic-messages`, `openai-responses`,
   * `google-generative-ai`, `google-vertex`, `azure-openai-responses`,
   * `bedrock-converse-stream`.
   */
  apiShape: string;
  enabled: boolean;
  isDefault: boolean;
  source: "built-in" | "custom";
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  input: string[] | null;
  cost: ModelCost | null;
  /**
   * Anthropic-only: shape of the upstream credential. When `oauth`, the
   * CLI hands pi-ai an `sk-ant-oat-…`-shaped placeholder so pi-ai's
   * prefix-based OAuth detection fires locally and the body is reshaped
   * (Claude-Code system prompt + tool renaming) BEFORE it reaches the
   * proxy. Anthropic gates OAuth tokens to that body shape upstream, so
   * the reshape has to happen client-side; the proxy only swaps the
   * placeholder secret for the real OAuth bearer. null for non-Anthropic
   * protocols and for Anthropic models whose creds aren't loadable
   * (treat as api-key).
   */
  keyKind?: "oauth" | "api-key" | null;
}

export async function listModelPresets(profileName: string): Promise<ModelPreset[]> {
  return apiList<ModelPreset>(profileName, "/api/models");
}

/**
 * Protocol families the **CLI** can route through `/api/llm-proxy/*`.
 *
 * Three families wired today: `openai-completions`, `anthropic-messages`,
 * and `mistral-conversations`. Despite its name, `mistral-conversations`
 * (from pi-ai's registry) targets Mistral's OpenAI-compatible
 * `/v1/chat/completions` endpoint — NOT the Beta `/v1/conversations`
 * agentic API. Auth is `Authorization: Bearer` for OpenAI and Mistral.
 *
 * The Anthropic case takes a side-channel: pi-ai's Anthropic SDK sends
 * `x-api-key` natively, but the platform's auth pipeline reads
 * `Authorization: Bearer` — so the CLI's preset path injects the bearer
 * token via `model.headers["Authorization"]` and passes a placeholder
 * `apiKey` to keep pi-ai happy. The platform's anthropic adapter strips
 * the inbound `x-api-key` (it isn't in HEADERS_TO_FORWARD) and injects
 * the real upstream key from server-side storage, so the placeholder
 * never reaches Anthropic.
 */
export const PROXY_SUPPORTED_APIS = new Set<string>([
  "openai-completions",
  "anthropic-messages",
  "mistral-conversations",
]);
