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
import type { ModelCost } from "@appstrate/core/module";
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
  /**
   * The preset's stored credential can no longer serve inference. Such a
   * preset is LISTED by `GET /api/models` (so it can be reconnected or
   * deleted) but resolving one would only fail later at the llm-proxy.
   * Optional + `!== true` semantics: an instance older than this CLI does
   * not send the field, and absent means live.
   */
  needs_reconnection?: boolean;
  source: "built-in" | "custom";
  /**
   * Backing provider id. Absent for an ALIASED preset — the platform strips a
   * model alias's binding before it reaches a non-loopback caller. When
   * present it keeps Pi's provider detection working through the llm-proxy
   * base URL (`derivePiProvider`).
   */
  providerId?: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  input: string[] | null;
  cost: ModelCost | null;
  /**
   * Anthropic-only: shape of the upstream credential. When `oauth`, the
   * CLI hands pi-ai an `sk-ant-oat-…`-shaped placeholder so pi-ai's
   * prefix-based OAuth detection fires locally and the body is reshaped
   * BEFORE it reaches the proxy. Anthropic gates OAuth tokens to that
   * body shape upstream, so the reshape has to happen client-side; the
   * proxy only swaps the placeholder secret for the real OAuth bearer.
   * null for non-Anthropic protocols and for Anthropic models whose
   * creds aren't loadable (treat as api-key). OSS ships no Anthropic
   * OAuth provider — this field stays as a contribution point for
   * external operator-installed modules.
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
