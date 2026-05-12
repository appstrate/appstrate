// SPDX-License-Identifier: Apache-2.0

/**
 * Shared sidecar configuration types.
 *
 * Defined in @appstrate/core so that both the backend orchestrator
 * (apps/api) and the sidecar runtime (runtime-pi/sidecar) reference
 * a single source of truth for the wire-level shape they exchange
 * via environment variables and the `POST /configure` endpoint.
 */

export interface SidecarConfig {
  runToken: string;
  platformApiUrl: string;
  proxyUrl?: string;
  llm?: LlmProxyConfig;
}

/**
 * Discriminated union covering the two LLM auth modes the sidecar can serve:
 *
 *   - `api_key`: the agent SDK builds the auth header with a placeholder and
 *     the sidecar swaps the placeholder for the real key.
 *   - `oauth`: the sidecar fetches a fresh access token from the platform
 *     (`GET /internal/oauth-token/:connectionId`) and injects it as the
 *     bearer + the per-provider identity headers + applies provider-specific
 *     body transforms (Claude identity prepend, Codex stream/store coercion).
 */
export type LlmProxyConfig = LlmProxyApiKeyConfig | LlmProxyOauthConfig;

/**
 * Canonical wire-format identifier for every LLM model provider Appstrate
 * proxies to. Lives here (in core) so that the sidecar runtime, the
 * platform's model-provider registry, and the OAuth token cache all reference
 * a single source of truth — drift between the three previously caused 401s
 * to surface as "unknown apiShape" rather than a real auth failure.
 */
export type ModelApiShape =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "openai-codex-responses";

/**
 * Subset of {@link ModelApiShape} reachable via the OAuth path. `openai-chat`
 * is intentionally excluded — chat-completions is an API-key-only surface
 * (BYO OpenAI key, openai-compatible endpoints), never authenticated via OAuth.
 */
export type OauthModelApiShape = Exclude<ModelApiShape, "openai-chat">;

export interface LlmProxyApiKeyConfig {
  authMode: "api_key";
  baseUrl: string;
  apiKey: string;
  placeholder: string;
}

export interface LlmProxyOauthConfig {
  authMode: "oauth";
  /** Fallback base URL — the sidecar prefers `baseUrl` returned by the platform's token endpoint. */
  baseUrl: string;
  /** ID of the `model_provider_credentials` row backing this OAuth connection. */
  credentialId: string;
  /** Canonical providerId — used for logging only. The sidecar never branches on this value. */
  providerId: string;
  /** Path rewrite applied to every outbound URL (e.g. `/v1/responses` → `/codex/responses` for chatgpt-account-mode Codex). */
  rewriteUrlPath?: { from: string; to: string };
  /** Force `stream: true` in JSON request bodies (required by some chat-account OAuth flows). */
  forceStream?: boolean;
  /** Force `store: false` in JSON request bodies (Codex ChatGPT-account mode). */
  forceStore?: boolean;
  /**
   * Declarative wire-format contract contributed by the provider module
   * (`ModelProviderDefinition.oauthWireFormat`). Drives identity-header
   * injection, body transforms, and adaptive header retries without the
   * sidecar needing to know any provider name. When absent, no identity
   * headers or transforms apply.
   */
  wireFormat?: OAuthWireFormat;
}

/**
 * Declarative wire-format quirks an OAuth model provider needs the sidecar
 * to apply on its behalf. Lives in {@link LlmProxyOauthConfig} (carried at
 * boot via env), so the sidecar runtime stays provider-agnostic — every
 * `claude-code`-style switch branch in the sidecar reads from this struct.
 *
 * All fields optional. An empty `OAuthWireFormat` is equivalent to "pass
 * the agent's request through with just the bearer attached."
 */
export interface OAuthWireFormat {
  /**
   * Static headers injected on every OAuth-authenticated upstream call.
   * Lower-cased keys recommended; the sidecar forwards verbatim. Used for
   * provider fingerprinting (e.g. Anthropic's `anthropic-dangerous-direct-
   * browser-access`, Codex's `originator: pi`).
   */
  identityHeaders?: Record<string, string>;
  /**
   * Header name to echo the resolved `accountId` as (when the token endpoint
   * surfaced one). Skipped when the cached token carries no `accountId`.
   * Example: `chatgpt-account-id` for Codex.
   */
  accountIdHeader?: string;
  /**
   * Anthropic-style system-prompt prelude prepended to outbound JSON
   * bodies. Applied only when the request body is a JSON object with a
   * `system` field — otherwise pass-through.
   */
  systemPrepend?: { type: "text"; text: string };
  /**
   * Single adaptive retry policy: when an upstream returns `status` and
   * the response body matches any of `bodyPatterns` (case-insensitive
   * regex), strip `removeToken` from the comma-separated header named
   * `headerName` and replay the request once. Used by Anthropic to fall
   * back when the long-context beta isn't available on the account.
   */
  adaptiveRetry?: OAuthAdaptiveRetryPolicy;
}

/** See {@link OAuthWireFormat.adaptiveRetry}. */
export interface OAuthAdaptiveRetryPolicy {
  /** HTTP status code triggering the retry (typically 400). */
  status: number;
  /** Body-text patterns (case-insensitive regex strings). Any match triggers retry. */
  bodyPatterns: readonly string[];
  /** Header name to mutate (case-insensitive lookup). */
  headerName: string;
  /** Comma-separated token to remove from the header value before retry. */
  removeToken: string;
}

/**
 * Wire-format response from the platform's `GET /internal/oauth-token/:credentialId`
 * (and `POST .../refresh`) endpoint. Carries only the fields that change per
 * refresh — provider invariants (baseUrl, rewriteUrlPath, forceStream,
 * forceStore, providerId, wireFormat) live in {@link LlmProxyOauthConfig},
 * which the sidecar already received at boot.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  /**
   * Abstract account/tenant identifier surfaced by the provider's
   * `extractTokenIdentity` hook. Echoed by the sidecar as the header
   * named by {@link OAuthWireFormat.accountIdHeader} (when both are set).
   */
  accountId?: string;
}

/**
 * Refresh lead time (epoch-ms): proactively refresh an OAuth access token when
 * its remaining lifetime drops below this threshold. Both the platform's
 * `resolveOAuthTokenForSidecar` and the sidecar's `OAuthTokenCache` honor this
 * value — keeping them in sync is critical: if the sidecar caches a token as
 * "fresh" while the platform considers it stale, the agent path 401s exactly
 * when the token expires.
 */
export const OAUTH_REFRESH_LEAD_MS = 5 * 60_000;
