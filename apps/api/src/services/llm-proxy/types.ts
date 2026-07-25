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

/**
 * Usage numbers parsed from the upstream response.
 *
 * Cost convention (`computeTokenCost` / `computeCostUsd`): the four token
 * buckets are DISJOINT and billed independently —
 * `input×input_rate + output×output_rate + cacheRead×cacheRead_rate +
 * cacheWrite×cacheWrite_rate`. `inputTokens` is therefore the cache-MISS input
 * only; it MUST NOT include the cache-read or cache-write tokens. Anthropic's
 * wire fields are already disjoint (`input_tokens` excludes
 * `cache_read_input_tokens` and `cache_creation_input_tokens`), but
 * OpenAI-compatible `prompt_tokens` is the TOTAL prompt (OpenAI:
 * `cached_tokens ⊂ prompt_tokens`; DeepSeek: `prompt_tokens = hit + miss`;
 * OpenRouter additionally folds `cache_write_tokens` into `cached_tokens`), so
 * the openai adapter subtracts both cache buckets out before populating this
 * field — using the SAME formula as the runner's pi-ai parser, so the two
 * ingestion paths price identical consumption identically.
 *
 * Every count is non-negative: adapters read wire numbers through
 * `helpers.tokenCount`, which floors at 0 so a misbehaving upstream cannot
 * produce a negative `cost_usd`.
 */
export interface UpstreamUsage {
  /** Cache-MISS input tokens only — excludes both cache buckets (see above). */
  inputTokens: number;
  outputTokens: number;
  /** Set only when the provider reported a cache-read count. */
  cacheReadTokens?: number;
  /** Set only when the provider reported a cache-write count. */
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
  /** Build the upstream request headers (auth + protocol-specific). */
  buildUpstreamHeaders(incoming: Headers, apiKey: string): Record<string, string>;
  /**
   * Mutate the outgoing request body so the upstream is REQUIRED to report
   * usage — the accounting counterpart of {@link parseJsonUsage} /
   * {@link parseSseUsage}. The core calls it on every forwarded request, for
   * every preset (system and org-owned alike): an unreported usage is a paid
   * call the ledger cannot price, so it must never depend on the caller SDK
   * asking nicely.
   *
   * Omitted by protocols that always report usage (anthropic-messages). Adding
   * a fifth apiShape therefore means implementing — or not implementing — this
   * hook on the new adapter; the core never branches on `apiShape`.
   */
  forceUsageReporting?(body: Record<string, unknown>): void;
  /** Extract usage from a non-streaming JSON body. Returns null if the shape is unexpected. */
  parseJsonUsage(body: unknown): UpstreamUsage | null;
  /** Extract usage from a streamed SSE payload. Returns null if none was observed. */
  parseSseUsage(accumulatedEvents: string[]): UpstreamUsage | null;
}
