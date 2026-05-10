// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — runtime execution registry.
 *
 * AFPS describes the *packaging* of a provider (identity, OAuth endpoints,
 * authorized URIs, scopes). It does NOT describe how the runtime executes
 * LLM calls against that provider — that's Appstrate-specific behavior.
 *
 * This file is the single source of truth for that runtime config:
 *   - Public OAuth client_id (decision Q3 — shared with the official CLI)
 *   - Scopes requested at /authorize (in addition to manifest.availableScopes)
 *   - LLM API shape, base URL, force-stream/store knobs, URL rewriting
 *   - List of selectable models (decision Q9 — refreshed per Appstrate release)
 *
 * Whitelist (decision Q4): only packages registered here can be used as
 * OAuth model providers. The lookup is keyed by the AFPS package `name`.
 *
 * See docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §3.3 for rationale.
 */

export type ModelApiShape = "anthropic-messages" | "openai-responses";

export type ModelCapability = "text" | "image" | "reasoning" | "long-context-1m";

export interface ModelProviderApiConfig {
  /** Canonical base URL the sidecar forwards LLM traffic to. */
  baseUrl: string;
  /** Wire format the runtime serializes against. */
  apiShape: ModelApiShape;
  /** Force `stream: true` on outbound bodies. Required for Codex ChatGPT-account mode. */
  forceStream?: boolean;
  /** Force `store: false` on outbound bodies. Required for Codex ChatGPT-account mode. */
  forceStore?: false;
  /** Path rewriting applied at the proxy boundary. Both fields required when present. */
  rewriteUrlPath?: { from: string; to: string };
}

export interface ModelEntry {
  /** Canonical model identifier accepted by the provider's API. */
  id: string;
  /** Maximum input context window in tokens. */
  contextWindow: number;
  /** Maximum response tokens. */
  maxTokens?: number;
  /** Surfaced capabilities for selection UIs. */
  capabilities: readonly ModelCapability[];
}

export interface OAuthModelProviderConfig {
  /** Match the AFPS package `name` (registry lookup key). */
  packageId: string;
  /** Public client_id. Hardcoded — Q3/Q4. */
  clientId: string;
  /** PKCE code challenge method. All current providers require S256. */
  pkce: "S256";
  /** Scopes requested at /authorize. */
  scopes: readonly string[];
  /** LLM API endpoint config — drives sidecar behavior. */
  api: ModelProviderApiConfig;
  /** Selectable models. Updated per Appstrate release (Q9). */
  models: readonly ModelEntry[];
}

const codexConfig: OAuthModelProviderConfig = {
  packageId: "@appstrate/provider-codex",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  pkce: "S256",
  scopes: ["openid", "profile", "email"],
  api: {
    baseUrl: "https://chatgpt.com/backend-api",
    apiShape: "openai-responses",
    forceStream: true,
    forceStore: false,
    rewriteUrlPath: { from: "/v1/responses", to: "/codex/responses" },
  },
  models: [
    { id: "gpt-5.5", contextWindow: 200000, capabilities: ["text", "image", "reasoning"] },
    { id: "gpt-5.4", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.4-mini", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.3-codex", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.2", contextWindow: 200000, capabilities: ["text", "reasoning"] },
  ],
};

const claudeCodeConfig: OAuthModelProviderConfig = {
  packageId: "@appstrate/provider-claude-code",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  pkce: "S256",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  api: {
    baseUrl: "https://api.anthropic.com",
    apiShape: "anthropic-messages",
  },
  models: [
    {
      id: "claude-opus-4-7",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
    },
    {
      id: "claude-sonnet-4-6",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
    },
    {
      id: "claude-haiku-4-5",
      contextWindow: 200000,
      capabilities: ["text", "image"],
    },
  ],
};

/**
 * Provider token endpoints — used by both the platform-side refresh
 * worker and (historically) the now-removed authorization-code callback.
 * Kept here as the single source of truth so the CLI helper that does
 * the loopback OAuth dance and the platform-side refresh never drift.
 *
 * Claude: `platform.claude.com` is the canonical token host
 * (cf. @mariozechner/pi-ai/utils/oauth/anthropic.js). The first iteration
 * shipped `claude.ai/v1/oauth/token` which appears reachable but returns
 * a non-canonical schema and was the root cause of refresh failures in
 * the smoke tests.
 */
export const OAUTH_MODEL_PROVIDER_TOKEN_URLS: Readonly<Record<string, string>> = Object.freeze({
  "@appstrate/provider-codex": "https://auth.openai.com/oauth/token",
  "@appstrate/provider-claude-code": "https://platform.claude.com/v1/oauth/token",
});

export const OAUTH_MODEL_PROVIDERS: Readonly<Record<string, OAuthModelProviderConfig>> =
  Object.freeze({
    [codexConfig.packageId]: codexConfig,
    [claudeCodeConfig.packageId]: claudeCodeConfig,
  });

/** Returns the runtime config for an OAuth model provider, or null if unknown. */
export function getOAuthModelProviderConfig(packageId: string): OAuthModelProviderConfig | null {
  return OAUTH_MODEL_PROVIDERS[packageId] ?? null;
}

/** Whitelist check — true iff the package is registered as an OAuth model provider. */
export function isOAuthModelProvider(packageId: string): boolean {
  return packageId in OAUTH_MODEL_PROVIDERS;
}

/** Iterate all registered OAuth model providers (insertion order). */
export function listOAuthModelProviders(): readonly OAuthModelProviderConfig[] {
  return Object.values(OAUTH_MODEL_PROVIDERS);
}
