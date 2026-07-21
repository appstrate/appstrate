// SPDX-License-Identifier: Apache-2.0

/**
 * Chat PLATFORM CONTRACT — the first-party, framework-neutral types the chat
 * module and the platform (apps/api) agree on through core alone.
 *
 * All agent RUNS execute on the single Pi engine. The interactive chat surface
 * is likewise unified: `@appstrate/module-chat` owns ONE generic in-process
 * Pi-SDK chat engine (`runPiSubscriptionChat`) that serves EVERY
 * oauth-subscription provider (claude-code, codex). There is no per-provider
 * chat-handler seam — the chat module resolves the real OAuth token + provider
 * baseUrl for the chosen model row through {@link PlatformServices}
 * (`resolveSubscriptionChatModel`) and drives Pi inline.
 *
 * The types are framework-neutral (no `ai`/UI-stream/Pi-SDK types) so they cross
 * apps/api ↔ module-chat through `ctx.services` only.
 */

/**
 * A subscription (oauth2) model resolved for one chat turn: the real upstream
 * binding + a fresh access token. Everything the Pi SDK needs to build its
 * `Model<Api>` + `AuthStorage` server-side, with the real subscription token
 * injected in-process (never persisted, never handed to the client).
 */
export interface SubscriptionChatModel {
  /** Real upstream model id (e.g. `claude-haiku-4-5`) — NOT the preset id. */
  modelId: string;
  /** Pi `MODEL_API` shape (`anthropic-messages`, `openai-codex-responses`, …). */
  apiShape: string;
  /** Provider upstream base URL (`https://api.anthropic.com`, `https://chatgpt.com/backend-api`). */
  baseUrl: string;
  /** Per-token cost ({@link ModelCost} shape), or `null` when the catalog has none. */
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  /** Modality flags (`["text","image"]`), or `null` (defaults to text-only). */
  input: string[] | null;
  /**
   * Fresh subscription access token — pi-ai emits the OAuth request shape
   * from it natively, including any account routing header (codex decodes
   * `chatgpt_account_id` from the token itself), so no separate account id
   * rides this contract.
   */
  accessToken: string;
}

/**
 * Outcome of resolving the chosen model row for a chat turn.
 *   - `{ subscription: false }` — an API-key / unknown provider → the chat's
 *     generic ai-sdk (llm-proxy) path handles it.
 *   - `{ subscription: true, needsReconnection: true }` — an oauth2 model whose
 *     credential is dead → the chat surfaces a reconnect prompt.
 *   - `{ subscription: true, model }` — an oauth2 model with a fresh token → the
 *     Pi subscription chat engine drives it.
 */
export type SubscriptionChatResolution =
  | { subscription: false }
  | { subscription: true; needsReconnection: true }
  | { subscription: true; model: SubscriptionChatModel };

/**
 * A chat composer file attachment to resolve to a durable document. The chat
 * module has no DB access, so it hands these plain fields across `ctx.services`
 * and the platform builds the scope/actor + materializes/validates server-side.
 */
export interface ChatAttachmentRequest {
  orgId: string;
  applicationId: string;
  /** The chat session owner (chat sessions are per dashboard user). */
  userId: string;
  /** Container the materialized document is anchored to (session-scoped ACL). */
  chatSessionId: string;
  /** `upload://upl_x` (materialize) or `document://doc_x` (validate access). */
  uri: string;
}

/**
 * A chat attachment resolved to its stable `document://` URI + metadata. An
 * `upload://` was materialized into a chat-session-scoped document; an existing
 * `document://` was validated as readable by the session owner. The URI is what
 * the message persists (stable for the session's lifetime) and what the model
 * is told the attached document is addressed by.
 */
export interface ResolvedChatAttachment {
  /** `document://doc_x` — the durable, stable URI. */
  uri: string;
  name: string;
  mime: string;
  size: number;
}

/** One chat turn's metered usage — inserted as an `llm_usage` row (runId null). */
export interface ChatUsageRecord {
  orgId: string;
  userId: string;
  /** Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  /** Real upstream model id — stored as `llm_usage.real_model`. */
  modelId: string;
  /** Pi `MODEL_API` shape — stored as `llm_usage.api`. */
  apiShape: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd: number;
  durationMs: number;
}

/**
 * Markdown heading the MCP server emits before the cached operation index in
 * its server instructions, and the cut point the chat module slices on to drop
 * the (uncacheable) index for engines that don't benefit from it. Shared so the
 * emitter (`apps/api` MCP router) and the consumer (chat module) cut at the same
 * literal — a drift would silently leave the index in place, costing cache.
 */
export const OPERATION_INDEX_HEADING = "## Operation index";
