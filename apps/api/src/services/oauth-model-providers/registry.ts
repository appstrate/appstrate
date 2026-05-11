// SPDX-License-Identifier: Apache-2.0

/**
 * Model Providers — runtime execution registry.
 *
 * Single source of truth for every LLM model provider Appstrate knows how
 * to talk to (API-key + OAuth alike). Each entry pins:
 *   - identity & branding (provider id, display name, icon, docs)
 *   - inference wire format (apiShape, base URL, force-stream/store, URL rewriting)
 *   - auth metadata (api_key form OR OAuth2 client config)
 *   - selectable models (id, context window, capabilities, optional cost)
 *
 * Why in code rather than as AFPS packages: the wire format is provider-
 * specific (Anthropic stealth-mode headers, Codex Responses path rewriting,
 * forced stream/store on ChatGPT-account mode) and changes when upstreams
 * change enforcement — that risk belongs in CI, not in a remote package.
 * The non-LLM provider mechanism (gmail/slack/…) remains AFPS-packaged
 * because its surface IS generic (`provider_call` MCP tool).
 *
 * See docs/architecture/OAUTH_MODEL_PROVIDERS_SPEC.md §3.3 for rationale.
 */

import { getEnv } from "@appstrate/env";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";

/**
 * Re-export the canonical wire-format union from `@appstrate/core/sidecar-types`
 * so platform-side callers (token-resolver, refresh-worker, …) keep importing
 * `ModelApiShape` from this module while the actual definition stays in core
 * — preventing drift with the sidecar runtime's `LlmProxyOauthConfig.apiShape`.
 */
export type { ModelApiShape };

export type ModelCapability = "text" | "image" | "reasoning" | "long-context-1m";

export type AuthMode = "api_key" | "oauth2";

export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens (provider-specific). */
  cacheRead?: number;
  /** USD per 1M cache-write tokens (provider-specific). */
  cacheWrite?: number;
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
  /** Default per-token cost. Self-hosters can override via SYSTEM_PROVIDER_KEYS env. */
  cost?: ModelCost;
}

export interface OAuthConfig {
  /** Public OAuth client_id — shared with the official CLI. */
  clientId: string;
  /** /authorize endpoint. */
  authorizationUrl: string;
  /** Token exchange endpoint. */
  tokenUrl: string;
  /** Token refresh endpoint (often equal to tokenUrl). */
  refreshUrl: string;
  /** Scopes requested at /authorize. */
  scopes: readonly string[];
  /** PKCE code challenge method. All current providers require S256. */
  pkce: "S256";
}

export interface ModelProviderConfig {
  /** Stable id used as `provider_id` in DB rows and as registry lookup key. */
  providerId: string;
  displayName: string;
  /** Icon hint consumed by the UI (matches the existing AFPS provider iconUrl format). */
  iconUrl: string;
  description?: string;
  docsUrl?: string;

  // — Inference —
  /** Wire format the runtime serializes against. */
  apiShape: ModelApiShape;
  /** Default base URL the sidecar forwards LLM traffic to. */
  defaultBaseUrl: string;
  /** Whether the user can override `defaultBaseUrl` per credential row. */
  baseUrlOverridable: boolean;
  /** Force `stream: true` on outbound bodies (Codex ChatGPT-account mode). */
  forceStream?: true;
  /** Force `store: false` on outbound bodies (Codex ChatGPT-account mode). */
  forceStore?: false;
  /** Path rewriting applied at the proxy boundary. */
  rewriteUrlPath?: { from: string; to: string };

  // — Auth —
  authMode: AuthMode;
  /** Required iff authMode === "oauth2". */
  oauth?: OAuthConfig;

  // — Catalog —
  /** Selectable models. May be empty for providers whose model list is user-supplied. */
  models: readonly ModelEntry[];
}

/**
 * Decode the JWT payload of a Codex access token.
 *
 * Codex tokens are RS256 JWTs whose payload contains:
 *   - `https://api.openai.com/auth.chatgpt_account_id` (UUID)
 *   - `email`, `email_verified`
 *   - standard `iss`, `aud`, `exp`, `iat` claims
 *
 * The sidecar needs the account id as a per-request `chatgpt-account-id`
 * header. Returns `null` if the token is not a JWT or the payload is
 * malformed. Does NOT verify the signature — the runtime trusts that the
 * OAuth dance produced this token; downstream Codex calls verify it
 * server-side. Claude Code returns opaque `sk-ant-oat01-…` tokens with no
 * embedded claims, so no Claude equivalent exists.
 */
export function decodeCodexJwtPayload(accessToken: string): {
  chatgpt_account_id?: string;
  email?: string;
} | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(json) as Record<string, unknown>;

    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId =
      auth && typeof auth["chatgpt_account_id"] === "string"
        ? (auth["chatgpt_account_id"] as string)
        : undefined;
    const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;

    return { chatgpt_account_id: accountId, email };
  } catch {
    return null;
  }
}

const codexConfig: ModelProviderConfig = {
  providerId: "codex",
  displayName: "Codex (ChatGPT)",
  iconUrl: "openai",
  description: "Run agents against your ChatGPT Plus / Pro / Business subscription via Codex.",
  docsUrl: "https://platform.openai.com/docs/guides/codex",
  // pi-ai's `openai-codex-responses` provider builds the request body the
  // chatgpt.com Codex backend actually accepts (`instructions`, `input`,
  // `include` — distinct from the standard openai-responses shape) and
  // resolves the URL to `${baseUrl}/codex/responses` natively. No
  // sidecar-side path rewrite needed.
  apiShape: "openai-codex-responses",
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  baseUrlOverridable: false,
  forceStream: true,
  forceStore: false,
  authMode: "oauth2",
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    refreshUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email"],
    pkce: "S256",
  },
  models: [
    { id: "gpt-5.5", contextWindow: 200000, capabilities: ["text", "image", "reasoning"] },
    { id: "gpt-5.4", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.4-mini", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.3-codex", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.2", contextWindow: 200000, capabilities: ["text", "reasoning"] },
  ],
};

/**
 * Claude: `platform.claude.com` is the canonical token host
 * (cf. @mariozechner/pi-ai/utils/oauth/anthropic.js). The first iteration
 * shipped `claude.ai/v1/oauth/token` which appears reachable but returns
 * a non-canonical schema and was the root cause of refresh failures.
 */
const claudeCodeConfig: ModelProviderConfig = {
  providerId: "claude-code",
  displayName: "Claude Code (Anthropic)",
  iconUrl: "anthropic",
  description:
    "Run agents against your Claude Pro / Max / Team subscription via the Claude Code OAuth client.",
  docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    refreshUrl: "https://platform.claude.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    pkce: "S256",
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

const openaiConfig: ModelProviderConfig = {
  providerId: "openai",
  displayName: "OpenAI",
  iconUrl: "openai",
  description: "Bring your own OpenAI API key.",
  docsUrl: "https://platform.openai.com/docs/api-reference",
  apiShape: "openai-chat",
  defaultBaseUrl: "https://api.openai.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  models: [],
};

const anthropicConfig: ModelProviderConfig = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  description: "Bring your own Anthropic API key.",
  docsUrl: "https://docs.anthropic.com/en/api",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  models: [],
};

const openaiCompatibleConfig: ModelProviderConfig = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "openai",
  description:
    "Self-hosted or third-party endpoint exposing the OpenAI chat-completions API (Ollama, vLLM, LiteLLM, …).",
  apiShape: "openai-chat",
  defaultBaseUrl: "http://localhost:11434",
  baseUrlOverridable: true,
  authMode: "api_key",
  models: [],
};

export const MODEL_PROVIDERS: Readonly<Record<string, ModelProviderConfig>> = Object.freeze({
  [codexConfig.providerId]: codexConfig,
  [claudeCodeConfig.providerId]: claudeCodeConfig,
  [openaiConfig.providerId]: openaiConfig,
  [anthropicConfig.providerId]: anthropicConfig,
  [openaiCompatibleConfig.providerId]: openaiCompatibleConfig,
});

/** Returns the runtime config for a model provider, or null if unknown. */
export function getModelProviderConfig(providerId: string): ModelProviderConfig | null {
  return MODEL_PROVIDERS[providerId] ?? null;
}

/** Whitelist check — true iff the id resolves to an OAuth model provider. */
export function isOAuthModelProvider(providerId: string): boolean {
  const config = getModelProviderConfig(providerId);
  return config?.authMode === "oauth2";
}

/** Iterate all registered model providers (insertion order). */
export function listModelProviders(): readonly ModelProviderConfig[] {
  return Object.values(MODEL_PROVIDERS);
}

/**
 * True iff `providerId` is NOT listed in `MODEL_PROVIDERS_DISABLED`.
 *
 * "Soft disable" — this check is consulted only at admin-facing surfaces
 * (UI picker, POST creation, OAuth initiate). The runtime hot path
 * (token-resolver, refresh-worker, llm-proxy, `executeProviderCall`)
 * deliberately uses the unfiltered accessors so existing credentials for
 * a disabled provider keep working until the admin deletes them.
 *
 * `getEnv()` is cached after first call so this is O(1) on the hot path.
 */
export function isModelProviderEnabled(providerId: string): boolean {
  return !getEnv().MODEL_PROVIDERS_DISABLED.includes(providerId);
}

/**
 * Iterate the subset of registered model providers that are enabled by env.
 *
 * Use this in admin/UI surfaces where disabled providers must NOT appear
 * (picker, validators, OpenAPI enums). Use `listModelProviders()` for any
 * runtime resolver that must keep operating on existing credentials.
 */
export function listEnabledModelProviders(): readonly ModelProviderConfig[] {
  return listModelProviders().filter((p) => isModelProviderEnabled(p.providerId));
}
