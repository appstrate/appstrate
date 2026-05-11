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
 *   - `api_key`: legacy path. The agent SDK builds the auth header with a
 *     placeholder and the sidecar swaps the placeholder for the real key.
 *   - `oauth`: the sidecar fetches a fresh access token from the platform
 *     (`GET /internal/oauth-token/:connectionId`) and injects it as the
 *     bearer + the per-provider identity headers + applies provider-specific
 *     body transforms (Claude identity prepend, Codex stream/store coercion).
 *
 * Backward compat: a config object without `authMode` is treated as
 * `api_key` (the historical default) so existing pooled sidecars continue
 * to work after upgrade.
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
  authMode?: "api_key";
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
  /** Used to look up the identity-header / body-transform strategy. Canonical providerId (e.g. "codex"). */
  providerId: string;
  /** Fallback URL rewrite — overridden per request by the token-endpoint response (e.g. Codex `/v1/responses` → `/codex/responses`). */
  rewriteUrlPath?: { from: string; to: string };
  /** Codex fallback: force `stream: true` in the request body. */
  forceStream?: boolean;
  /** Codex fallback: force `store: false` in the request body. */
  forceStore?: boolean;
}

/**
 * Wire-format response from the platform's `GET /internal/oauth-token/:credentialId`
 * (and `POST .../refresh`) endpoint. Single source of truth — both the platform
 * resolver (`apps/api/src/services/oauth-model-providers/token-resolver.ts`) and
 * the sidecar cache (`runtime-pi/sidecar/oauth-token-cache.ts`) reference this
 * type so a new field added on either side cannot silently drift.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  apiShape: OauthModelApiShape;
  baseUrl: string;
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: boolean;
  /**
   * Abstract account/tenant identifier surfaced by the provider's
   * `extractTokenIdentity` hook. The sidecar's identity layer (per
   * `providerId`) decides which routing header to echo it as.
   */
  accountId?: string;
  /** Canonical providerId. */
  providerId: string;
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

// Anthropic Consumer ToS (https://www.anthropic.com/legal/consumer-terms)
// explicitly forbids using OAuth subscription tokens with any third-party
// product, tool, or service — including the Agent SDK. OSS therefore
// ships no Anthropic OAuth provider; operators who want to use Anthropic
// inside Appstrate route through the upstream API key flow (which IS
// supported) via the `anthropic` provider in the `core-providers` module.
