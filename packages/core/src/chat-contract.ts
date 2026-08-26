// SPDX-License-Identifier: Apache-2.0

/**
 * Chat PLATFORM CONTRACT — the first-party, framework-neutral types the chat
 * module and the platform (apps/api) agree on through core alone.
 *
 * All agent RUNS execute on the single Pi engine, and so does EVERY chat turn:
 * `@appstrate/module-chat` owns ONE generic in-process Pi-SDK chat engine
 * (`runPiChat`) serving both credential modes. There is no per-provider
 * chat-handler seam and no second inference loop — the chat module resolves the
 * chosen model row through {@link PlatformServices}
 * (`resolveChatModel`) and drives Pi inline. An oauth2 row yields
 * the real token + provider baseUrl (the engine talks to the provider
 * directly); an API-key row yields no secret at all and the engine is pointed
 * at the platform llm-proxy instead.
 *
 * The types are framework-neutral (no `ai`/UI-stream/Pi-SDK types) so they cross
 * apps/api ↔ module-chat through `ctx.services` only.
 */

// Type-only imports (erased at emit), so the `module.ts` ↔ `chat-contract.ts`
// pair carries no runtime cycle. Both symbols are the canonical, already
// published ones — re-declaring them here is what let the chat surface drift
// from the model-provider surface it mirrors.
import type { ModelCost } from "./module.ts";
import type { ModelNativeReasoningLevel, ModelReasoningLevel } from "./model-generation.ts";
import type { ModelApiShape } from "./sidecar-types.ts";

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
  apiShape: ModelApiShape;
  /** Provider upstream base URL (`https://api.anthropic.com`, `https://chatgpt.com/backend-api`). */
  baseUrl: string;
  /** Per-1M-token catalog rates, or `null` when the catalog has none. */
  cost: ModelCost | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  /** Provider-native values for portable reasoning levels, when catalogued. */
  reasoningLevelMap?: Partial<Record<ModelReasoningLevel, ModelNativeReasoningLevel>>;
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
 *   - `{ subscription: false }` — an API-key / unknown provider → the same
 *     engine runs the turn, bound to the platform llm-proxy with an inert key.
 *   - `{ subscription: true, needsReconnection: true }` — a model whose stored
 *     credential is dead (oauth flagged needs-reconnection, or a stored secret
 *     that no longer decrypts) → the chat surfaces a reconnect prompt. Nothing
 *     is resolvable either way, so this is purely which error the user sees.
 *   - `{ subscription: true, model }` — an oauth2 model with a fresh token → the
 *     engine talks to the provider directly with it, instead of the llm-proxy.
 */
export type ChatModelResolution =
  | { subscription: false }
  | { subscription: true; needsReconnection: true }
  | { subscription: true; model: SubscriptionChatModel };

/**
 * A chat composer file attachment to resolve to a durable file. The chat
 * module has no DB access, so it hands these plain fields across `ctx.services`
 * and the platform builds the scope/actor + materializes/validates server-side.
 */
export interface ChatAttachmentRequest {
  orgId: string;
  spaceId: string;
  /** The chat session owner (chat sessions are per dashboard user). */
  userId: string;
  /** Container the materialized file is anchored to (session-scoped ACL). */
  chatSessionId: string;
  /**
   * `upload://upl_x` (materialize) or `appfile://file_x` (validate access).
   */
  uri: string;
}

/**
 * A chat attachment resolved to its stable `appfile://` URI + metadata. An
 * `upload://` was materialized into a chat-session-scoped file; an existing
 * `appfile://` was validated as readable by the session owner. The URI is what the message persists (stable for the session's
 * lifetime) and what the model is told the attached file is addressed by.
 */
export interface ResolvedChatAttachment {
  /** `appfile://file_x` — the durable, stable URI, always in canonical form. */
  uri: string;
  name: string;
  mime: string;
  size: number;
}

/** One chat turn's metered usage — inserted as an `llm_usage` row (runId null). */
export interface ChatUsageRecord {
  orgId: string;
  userId: string;
  /**
   * Chat session the turn belongs to — stored as `llm_usage.chat_session_id`.
   * Null for an ephemeral turn with no persisted session (the row is then
   * un-attributed to any context).
   */
  chatSessionId: string | null;
  /** Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  /** Real upstream model id — stored as `llm_usage.real_model`. */
  modelId: string;
  /** Pi `MODEL_API` shape — stored as `llm_usage.api`. */
  apiShape: ModelApiShape;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /**
   * Model's catalog per-1M-token rates, or null when the catalog has none. The
   * platform seam computes the equivalent USD cost from this + the token counts
   * using the SAME shared formula as the proxy/runner paths — the chat engine
   * passes rates, not a pre-computed dollar figure, so all three producers
   * can't drift.
   */
  cost: ModelCost | null;
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
