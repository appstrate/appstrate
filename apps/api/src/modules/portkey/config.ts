// SPDX-License-Identifier: Apache-2.0

/**
 * Translate Appstrate's `ResolvedModel` into the inline `x-portkey-config`
 * header value Portkey expects.
 *
 * Phase 1 covers the api_key surface — the OAuth-subscription providers
 * (Codex, Claude Pro) bypass Portkey entirely (see `pi.ts`). Each
 * `ModelProviderDefinition` declares its own Portkey gateway slug via
 * `portkeyProvider`; adding a new provider is a one-field change on the
 * provider definition, with no shared map to update.
 */

import { getModelProvider } from "../../services/model-providers/registry.ts";
import type { PortkeyModelInput, PortkeyRouting } from "../../services/portkey-router.ts";

/**
 * Per-shape path prefix appended to the gateway base URL so the final
 * URL matches Portkey's HTTP surface for each provider:
 *
 *   • OpenAI SDKs append `/chat/completions` (no `/v1`) to baseUrl, so
 *     we bake `/v1` into the routing baseUrl. Final URL:
 *     `<gateway>/v1/chat/completions`.
 *   • Anthropic SDK already includes `/v1` in the request path
 *     (`/v1/messages`), so the gateway baseUrl stays bare.
 *   • Mistral SDK (`@mistralai/mistralai` `chat.stream`) also appends
 *     `/v1/chat/completions` to its `serverURL`, so its prefix must
 *     stay empty too — otherwise the sidecar forwards
 *     `<gateway>/v1/v1/chat/completions` and Portkey 404s. Verified by
 *     reading `node_modules/@mistralai/mistralai/esm/funcs/chatStream.js`:
 *     `pathToFunc("/v1/chat/completions#stream")`.
 *
 * Shapes without an explicit entry use an empty prefix — the gateway
 * baseUrl is forwarded verbatim. Wiring a new shape whose SDK
 * convention diverges from that default requires an entry here (and
 * the path-contract integration test will catch the omission).
 */
const API_SHAPE_PORTKEY_PATH_PREFIX: Record<string, string> = {
  "openai-chat": "/v1",
  "openai-completions": "/v1",
  "openai-responses": "/v1",
};

/** HTTP status codes Portkey will retry on. Mirrors the smoke-test config. */
const RETRY_ON_STATUS = [429, 500, 502, 503, 504] as const;

/**
 * Optional per-build extras. Set by the module's `init()` based on env
 * vars; tests pass them inline. Keeping the env read out of `config.ts`
 * keeps it pure and easy to unit-test.
 */
export interface PortkeyRoutingOptions {
  /** When non-"off", emits `cache: { mode, maxAge }` in the inline payload. */
  cache?: {
    mode: "simple" | "semantic";
    maxAge: number;
  };
}

/**
 * Build the routing tuple the sidecar consumes. Returns `null` when the
 * model's `providerId` is not registered or its provider definition lacks
 * a `portkeyProvider` slug (e.g. OAuth-subscription providers that bypass
 * Portkey). Callers (run launcher / llm-proxy) raise
 * `LlmProxyUnroutableModelError` since Portkey is mandatory for api_key
 * flows and there is no direct-upstream fallback.
 *
 * Adding a new provider is a one-field change on its
 * `ModelProviderDefinition` (`portkeyProvider: "<slug>"`); if the SDK's
 * URL convention diverges from the default empty prefix, also add an
 * entry to `API_SHAPE_PORTKEY_PATH_PREFIX`.
 */
export function buildPortkeyRouting(
  model: PortkeyModelInput,
  baseUrl: string,
  options: PortkeyRoutingOptions = {},
): PortkeyRouting | null {
  const provider = getModelProvider(model.providerId)?.portkeyProvider;
  if (!provider) return null;

  const config: Record<string, unknown> = {
    provider,
    api_key: model.apiKey,
    retry: { attempts: 3, on_status_codes: [...RETRY_ON_STATUS] },
  };

  // Only thread custom_host through when the model carries a non-empty
  // override that isn't the Portkey slug's well-known default upstream
  // — otherwise Portkey's own provider defaults are more authoritative
  // than ours.
  if (model.baseUrl && !isPortkeyDefaultUpstream(provider, model.baseUrl)) {
    config.custom_host = model.baseUrl;
  }

  // Cache is opt-in via `PORTKEY_CACHE_MODE`. The bundle ships `simple`
  // (exact-hash) and `semantic` (embedding similarity) — the gateway
  // resolves the cache hit server-side and emits `x-portkey-cache-status`
  // on the response. We surface that header up to callers untouched.
  if (options.cache) {
    config.cache = {
      mode: options.cache.mode,
      max_age: options.cache.maxAge,
    };
  }

  const prefix = API_SHAPE_PORTKEY_PATH_PREFIX[model.apiShape] ?? "";
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: `${trimmedBase}${prefix}`,
    portkeyConfig: JSON.stringify(config),
  };
}

/**
 * Well-known upstreams Portkey's own provider slug defaults to. When the
 * caller's `baseUrl` matches, we skip `custom_host` so Portkey's
 * provider-aware path-rewriting takes over. Keyed on the **Portkey
 * slug** (NOT the Appstrate `providerId`) because the slug is what
 * determines the upstream Portkey will use — multiple Appstrate
 * providers can share one slug with different upstreams (cerebras /
 * groq / xai all route through `openai` with their own `custom_host`).
 */
const PORTKEY_DEFAULT_UPSTREAM: Record<string, RegExp> = {
  anthropic: /^https:\/\/api\.anthropic\.com\/?$/,
  openai: /^https:\/\/api\.openai\.com\/v1\/?$/,
  "mistral-ai": /^https:\/\/api\.mistral\.ai\/?$/,
  google: /^https:\/\/generativelanguage\.googleapis\.com\/?$/,
};

function isPortkeyDefaultUpstream(provider: string, baseUrl: string): boolean {
  const re = PORTKEY_DEFAULT_UPSTREAM[provider];
  return re ? re.test(baseUrl) : false;
}
