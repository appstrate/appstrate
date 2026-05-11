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
  /** Used to look up the identity-header / body-transform strategy. Canonical providerId ("codex", "claude-code"). */
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
  /** Codex only — extracted from JWT, used as `chatgpt-account-id` header by the sidecar. */
  accountId?: string;
  /** Canonical providerId, e.g. "codex" or "claude-code". */
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

/**
 * Claude Code stealth-mode identity — Anthropic enforces this verbatim for
 * any OAuth-authenticated `/v1/messages` call. The string must appear as the
 * first system message (or be prepended by the sidecar). Both the platform
 * inference probe (`apps/api/src/services/org-models.ts`) and the sidecar
 * runtime (`runtime-pi/sidecar/oauth-identity.ts`) reference this constant —
 * paraphrasing it (even capitalisation) trips Anthropic's third-party tier
 * filter and silently 429s every request.
 */
export const CLAUDE_CODE_IDENTITY_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Claude Code CLI version sent as `user-agent: claude-cli/<v>` for OAuth
 * Anthropic traffic. Must track `claudeCodeVersion` in pi-ai's anthropic
 * provider; an older value silently 429s. Bumping requires reading pi-ai's
 * CHANGELOG — see `apps/api/test/unit/build-inference-probe-request.test.ts`
 * "CLAUDE_CODE_CLI_VERSION sync with pi-ai" for the drift detector.
 */
export const CLAUDE_CODE_CLI_VERSION = "2.1.75";

/**
 * Beta tokens Anthropic gates `sk-ant-oat-*` tokens to at the OAuth identity
 * layer. Omitting any of these returns 401 `invalid x-api-key`. Both the
 * platform llm-proxy (`apps/api/src/services/llm-proxy/anthropic.ts`) and
 * the inference probe (`apps/api/src/services/org-models.ts`) MUST send
 * these on every OAuth call.
 *
 * The sidecar runtime does NOT inject `anthropic-beta` because pi-ai's
 * anthropic provider already supplies the beta header in-container (with
 * its own additional pi-ai performance betas like `fine-grained-tool-
 * streaming-2025-05-14`).
 */
export const CLAUDE_CODE_OAUTH_IDENTITY_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
] as const;

/**
 * Full OAuth beta set sent by the platform llm-proxy when forwarding agent
 * traffic — extends {@link CLAUDE_CODE_OAUTH_IDENTITY_BETAS} with the pi-ai
 * performance betas (`fine-grained-tool-streaming-2025-05-14`) because the
 * proxy sees only the placeholder bearer (pi-ai skips its local detection)
 * and must reproduce pi-ai's wire format exactly. Caller-supplied betas
 * (`prompt-caching-2024-07-31`, `context-1m-2025-08-07`, …) are merged on
 * top, not replaced.
 */
export const CLAUDE_CODE_OAUTH_BETAS = [
  ...CLAUDE_CODE_OAUTH_IDENTITY_BETAS,
  "fine-grained-tool-streaming-2025-05-14",
] as const;

/**
 * Static identity headers Anthropic enforces on every OAuth-authenticated
 * `/v1/messages` call (alongside `Authorization: Bearer …`, the OAuth betas
 * above, and `user-agent: claude-cli/<v>`). Shared by all three Claude Code
 * OAuth call sites:
 *
 *   - platform llm-proxy adapter (`apps/api/src/services/llm-proxy/anthropic.ts`)
 *   - inference probe (`apps/api/src/services/org-models.ts`)
 *   - sidecar runtime (`runtime-pi/sidecar/oauth-identity.ts`)
 *
 * Anthropic's third-party-tier filter rejects requests missing any of these
 * silently with 401/403 (`invalid x-api-key`) or 429 (claude-code-disabled),
 * so the constant lives here in core to prevent drift across the three.
 * `accept` and `content-type` are NOT in this set — each call site picks
 * the right pair (`application/json` for probe/proxy non-stream,
 * `text/event-stream` for streaming).
 */
export const CLAUDE_CODE_IDENTITY_HEADERS = {
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
} as const;
