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

import { LLM_PROXY_ROUTES } from "@appstrate/runner-pi";
import type { OrgModelInfo } from "@appstrate/shared-types";
import { apiList } from "./api.ts";

/**
 * One row of `GET /api/models`, derived from the server's wire type so a renamed
 * field fails to compile. An aliased preset arrives with its backing nulled.
 */
export type ModelPreset = Pick<
  OrgModelInfo,
  | "id"
  | "label"
  | "apiShape"
  | "enabled"
  | "is_default"
  | "needs_reconnection"
  | "source"
  | "providerId"
  | "pi_provider"
  | "modelId"
  | "contextWindow"
  | "maxTokens"
  | "reasoning"
  | "input"
  | "cost"
>;

/** Whether `/api/llm-proxy/*` routes this preset's protocol (never an alias's nulled one). */
export function isProxySupported(apiShape: string | null): apiShape is string {
  return apiShape !== null && PROXY_SUPPORTED_APIS.has(apiShape);
}

export async function listModelPresets(profileName: string): Promise<ModelPreset[]> {
  return apiList<ModelPreset>(profileName, "/api/models");
}

/**
 * Protocol families the **CLI** can route through `/api/llm-proxy/*`.
 *
 * Families wired today: `openai-completions`, `openai-responses`,
 * `anthropic-messages` and `mistral-conversations`. Despite its name, `mistral-conversations`
 * (from pi-ai's registry) targets Mistral's OpenAI-compatible
 * `/v1/chat/completions` endpoint — NOT the Beta `/v1/conversations`
 * agentic API. Auth is `Authorization: Bearer` for both OpenAI shapes and Mistral.
 *
 * Derived from `LLM_PROXY_ROUTES` rather than restated. This paragraph used to
 * argue the opposite — "NOT a shared constant, and deliberately so", the set
 * being `platform-routed ∩ pi-ai-supported` — and named two sibling lists it
 * must not be merged with. Both of those are gone: `routes[]` in
 * `apps/api/src/routes/llm-proxy.ts` and `proxyBaseUrl()` in
 * `model-binding.ts` were deleted by the same change that made this a
 * derivation, so all three cross-references pointed at nothing.
 *
 * The weaker contract that replaced it, stated plainly: CLI preset support IS
 * platform routing. A shape the platform stops routing stops looking supported
 * here, which is the property worth having. The intersection with pi-ai's own
 * client support is not re-checked, because pi-ai carries a superset of the
 * shapes the proxy has adapters for — if that ever stops being true, the fix is
 * to intersect HERE and say so, not to spell the membership out by hand again.
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
export const PROXY_SUPPORTED_APIS: ReadonlySet<string> = new Set<string>(
  // Derived from the proxy's own route table rather than restated: a shape the
  // platform stops routing must not keep looking supported here.
  Object.keys(LLM_PROXY_ROUTES),
);
