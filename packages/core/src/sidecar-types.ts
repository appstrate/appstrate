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
 * (and `POST .../refresh`) endpoint. Carries only the fields that change per
 * refresh — provider invariants (baseUrl, rewriteUrlPath, forceStream,
 * forceStore, providerId, apiShape) live in {@link LlmProxyOauthConfig},
 * which the sidecar already received at boot.
 */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  /**
   * Abstract account/tenant identifier surfaced by the provider's
   * `extractTokenIdentity` hook. The sidecar's identity layer (per
   * `providerId`) decides which routing header to echo it as.
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

// Anthropic Consumer ToS (https://www.anthropic.com/legal/consumer-terms)
// forbids using OAuth subscription tokens with any third-party product,
// tool, or service — including the Agent SDK. The OSS default ships no
// Anthropic OAuth provider; operators who reviewed the ToS posture and
// want to wire their Claude Pro / Max / Team subscription enable the
// opt-in `claude-code` module (apps/api/src/modules/claude-code/) by
// appending it to `MODULES`. Operators who want plain API-key Anthropic
// stay on the `anthropic` provider in `core-providers`.
//
// The two constants below are the sidecar's wire-format knowledge for
// the `claude-code` providerId. They live in core (not the module) so
// the sidecar build doesn't depend on the optional module — when the
// module is not loaded no traffic carries `providerId="claude-code"`,
// so the sidecar branch reading these constants is dead at runtime.

/**
 * System-prompt prelude Anthropic's third-party-tier filter requires on
 * every OAuth-authenticated `/v1/messages` call. Reproduced verbatim from
 * `anthropic-ai/claude-code`'s `THIRD_PARTY_TIER_FILTER_PREFIX`; both the
 * platform's claude-code module and the sidecar runtime
 * (`runtime-pi/sidecar/oauth-identity.ts`) reference this constant —
 * paraphrasing it (even capitalisation) trips Anthropic's third-party
 * tier filter and silently 429s every request.
 */
export const CLAUDE_CODE_IDENTITY_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Static identity headers Anthropic enforces on every OAuth-authenticated
 * `/v1/messages` call. Lives here so the sidecar runtime can inject them
 * without taking a dependency on the optional `claude-code` module.
 * `accept` and `content-type` are NOT in this set — each call site picks
 * the right pair (`application/json` non-stream, `text/event-stream`
 * streaming).
 */
export const CLAUDE_CODE_IDENTITY_HEADERS = {
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
} as const;
