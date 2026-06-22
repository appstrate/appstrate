// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the `/api/llm-proxy/*` pipeline.
 *
 * Two protocol families live alongside each other (`openai-completions`,
 * `anthropic-messages`); each ships a small adapter module in this
 * directory implementing {@link LlmProxyAdapter}. The route layer picks
 * one adapter per endpoint and hands it to the shared core.
 */

/** Principal that minted the proxy call — mirrors credential-proxy. */
export type LlmProxyPrincipal =
  | { kind: "api_key"; apiKeyId: string; orgId: string; userId: string }
  | { kind: "jwt_user"; userId: string; orgId: string };

/**
 * Build the {@link LlmProxyPrincipal} from the resolved auth identity: an API
 * key (`apiKeyId` present) is an `"api_key"` principal, otherwise a cookie
 * session is a `"jwt_user"`. Shared by every proxy surface (core route +
 * subscription gateways) so the principal shape can't drift between them.
 */
export function buildLlmProxyPrincipal(args: {
  apiKeyId: string | null | undefined;
  orgId: string;
  userId: string;
}): LlmProxyPrincipal {
  return args.apiKeyId
    ? { kind: "api_key", apiKeyId: args.apiKeyId, orgId: args.orgId, userId: args.userId }
    : { kind: "jwt_user", userId: args.userId, orgId: args.orgId };
}

/** Usage numbers parsed from the upstream response. */
export interface UpstreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Protocol-specific hooks consumed by the shared core. Each concrete
 * adapter (OpenAI, Anthropic, Mistral) implements these three operations;
 * the core handles routing, auth wrapping, streaming, body rewrite, and
 * metering. Body rewrite (`body.model` substitution) is identical across
 * shapes and lives in `helpers.ts:substituteModelJson` — no adapter hook
 * needed.
 */
export interface LlmProxyAdapter {
  /** Protocol string — must match the route's apiShape and the resolved model's apiShape. */
  readonly apiShape: string;
  /**
   * Build the upstream request headers (auth + protocol-specific).
   * `accountId` is the credential's abstract identity slot (set for OAuth
   * credentials whose provider surfaced one) — subscription adapters echo
   * it as their routing header (e.g. codex `chatgpt-account-id`).
   */
  buildUpstreamHeaders(
    incoming: Headers,
    apiKey: string,
    accountId?: string,
  ): Record<string, string>;
  /** Extract usage from a non-streaming JSON body. Returns null if the shape is unexpected. */
  parseJsonUsage(body: unknown): UpstreamUsage | null;
  /** Extract usage from a streamed SSE payload. Returns null if none was observed. */
  parseSseUsage(accumulatedEvents: string[]): UpstreamUsage | null;
}
