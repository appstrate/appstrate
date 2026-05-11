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
  oauthConnectionId: string;
  /** Drives sidecar request shaping (URL rewrite, body transform, identity headers). */
  apiShape: "anthropic-messages" | "openai-responses" | "openai-codex-responses";
  /** Used to look up the identity-header / body-transform strategy. Canonical providerId ("codex", "claude-code"). */
  providerId: string;
  /** Optional URL rewriting (e.g. Codex `/v1/responses` → `/codex/responses`). */
  rewriteUrlPath?: { from: string; to: string };
  /** Codex: force `stream: true` in the request body. */
  forceStream?: boolean;
  /** Codex: force `store: false` in the request body. */
  forceStore?: boolean;
}
