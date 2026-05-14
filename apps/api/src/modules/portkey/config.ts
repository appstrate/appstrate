// SPDX-License-Identifier: Apache-2.0

/**
 * Translate Appstrate's `ResolvedModel` into the inline `x-portkey-config`
 * header value Portkey expects.
 *
 * Phase 1 covers the api_key surface — the OAuth-subscription providers
 * (Codex, Claude Pro) bypass Portkey entirely (see `pi.ts`). The mapping
 * stays data-driven from `apiShape`; adding a Portkey-side provider is a
 * single entry here.
 */

import type { PortkeyModelInput, PortkeyRouting } from "../../services/portkey-router.ts";

/**
 * `apiShape` (Appstrate canonical) → Portkey provider slug. Slugs are
 * from Portkey's runtime catalog (see `@portkey-ai/gateway` build). The
 * subscription-OAuth shape `openai-codex-responses` is intentionally
 * absent — Codex never reaches Portkey.
 */
const API_SHAPE_TO_PORTKEY_PROVIDER: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-chat": "openai",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "mistral-conversations": "mistral-ai",
  "google-generative-ai": "google",
  "google-vertex": "vertex-ai",
  "azure-openai-responses": "azure-openai",
  "bedrock-converse-stream": "bedrock",
};

/**
 * Per-shape path prefix appended to the gateway base URL so the final
 * URL matches Portkey's HTTP surface for each provider:
 *
 *   • OpenAI / Mistral SDKs append `/chat/completions` to a `/v1`-baked
 *     baseUrl. Portkey serves them at `<gateway>/v1/chat/completions`,
 *     so we bake `/v1` into the routing baseUrl.
 *   • Anthropic SDK already includes `/v1` in the request path
 *     (`/v1/messages`), so the gateway baseUrl stays bare.
 *
 * Unmapped shapes default to empty — the gateway baseUrl is passed
 * through unchanged, matching the historical direct-upstream behavior.
 */
const API_SHAPE_PORTKEY_PATH_PREFIX: Record<string, string> = {
  "openai-chat": "/v1",
  "openai-completions": "/v1",
  "openai-responses": "/v1",
  "mistral-conversations": "/v1",
};

/** HTTP status codes Portkey will retry on. Mirrors the smoke-test config. */
const RETRY_ON_STATUS = [429, 500, 502, 503, 504] as const;

/**
 * Build the routing tuple the sidecar consumes. Returns `null` when the
 * model's `apiShape` is not yet wired (e.g. exotic OpenAI-compatible
 * endpoints under `openai-compatible`); the run launcher then falls
 * through to the legacy direct-upstream path. This keeps the rollout
 * incremental — adding a new provider is one map entry above without
 * breaking the existing path.
 */
export function buildPortkeyRouting(
  model: PortkeyModelInput,
  baseUrl: string,
): PortkeyRouting | null {
  const provider = API_SHAPE_TO_PORTKEY_PROVIDER[model.apiShape];
  if (!provider) return null;

  // `custom_host` is only emitted when the org provided one — leaving it
  // unset lets Portkey use its built-in default for the named provider
  // (e.g. https://api.openai.com/v1). For `openai-compatible` we'd want
  // it; that shape is currently excluded above and will be wired in a
  // follow-up alongside its dedicated provider slug.
  const config: Record<string, unknown> = {
    provider,
    api_key: model.apiKey,
    retry: { attempts: 3, on_status_codes: [...RETRY_ON_STATUS] },
  };

  // Only thread custom_host through when the model carries a non-empty
  // override that isn't the provider's default upstream — otherwise
  // Portkey's own provider defaults are more authoritative than ours.
  if (model.baseUrl && !isDefaultUpstream(model.apiShape, model.baseUrl)) {
    config.custom_host = model.baseUrl;
  }

  const prefix = API_SHAPE_PORTKEY_PATH_PREFIX[model.apiShape] ?? "";
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: `${trimmedBase}${prefix}`,
    portkeyConfig: JSON.stringify(config),
  };
}

/**
 * Heuristic: don't override Portkey's built-in upstream when the org's
 * baseUrl matches the well-known public endpoint. Keeps Portkey's own
 * provider-aware path-rewriting honest for the canonical hosts.
 */
const KNOWN_DEFAULT_HOSTS: Record<string, RegExp> = {
  "anthropic-messages": /^https:\/\/api\.anthropic\.com\/?/,
  "openai-chat": /^https:\/\/api\.openai\.com\/v1\/?$/,
  "openai-completions": /^https:\/\/api\.openai\.com\/v1\/?$/,
  "openai-responses": /^https:\/\/api\.openai\.com\/v1\/?$/,
  "mistral-conversations": /^https:\/\/api\.mistral\.ai\/?/,
  "google-generative-ai": /^https:\/\/generativelanguage\.googleapis\.com\/?/,
};

function isDefaultUpstream(apiShape: string, baseUrl: string): boolean {
  const re = KNOWN_DEFAULT_HOSTS[apiShape];
  return re ? re.test(baseUrl) : false;
}

/** @internal test helper */
export const _API_SHAPE_TO_PORTKEY_PROVIDER = API_SHAPE_TO_PORTKEY_PROVIDER;
