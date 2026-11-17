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

import { z } from "zod";
import type { TokenUsageTier } from "@appstrate/afps-shared/token-usage";
// Type-only imports (erased at emit), so the `module.ts` ↔ `chat-contract.ts`
// pair carries no runtime cycle. Both symbols are the canonical, already
// published ones — re-declaring them here is what let the chat surface drift
// from the model-provider surface it mirrors.
import type { ModelCost, ModelInputModality } from "./module.ts";
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
  /** Modality flags (`["text","image"]`), or `null` (defaults to text-only). */
  input: ModelInputModality[] | null;
  /**
   * The personal `model_provider_credentials` row this token belongs to — the
   * ledger attributes the turn to it (`llm_usage.credential_id`).
   */
  credentialId: string;
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
  /** The chat session owner (chat sessions are per dashboard user). */
  userId: string;
  /** Container the materialized file is anchored to (session-scoped ACL). */
  chatSessionId: string;
  /**
   * `upload://upl_x` (materialize) or `appfile://file_x` (validate access).
   */
  uri: string;
  /**
   * The spaces the attachment may resolve in, each with the caller's effective
   * permission set there: every space the caller may chat in (the acting set). The attachment resolves in the
   * space its file (or upload) belongs to, which must be one of these; a
   * permission set decides how wide a container ACL reads there — with
   * `runs:read-all` an `appfile://` anchored to a colleague's run resolves,
   * which is what the file gallery the user picked it from already shows;
   * without it only the session owner's own runs.
   */
  spaces: readonly { id: string; permissions: ReadonlySet<string> }[];
  /**
   * Called with the space the attachment belongs to, once it is one of `spaces` and BEFORE
   * anything is created or read in it: a rejection refuses the attachment, so an upload is
   * never materialized into a space the caller was refused. The conversation records the
   * space as touched here.
   */
  beforeResolve: (spaceId: string) => Promise<void>;
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
  /** The space the file belongs to: where it resolved. */
  spaceId: string;
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
  /** The turn's tier bands (`TokenUsage.tiers`): its summed counters lose which call hit a tier. */
  tiers?: TokenUsageTier[];
  /**
   * Model's catalog per-1M-token rates, or null when the catalog has none. The
   * platform seam computes the equivalent USD cost from this + the token counts
   * using the SAME shared formula as the proxy/runner paths — the chat engine
   * passes rates, not a pre-computed dollar figure, so all three producers
   * can't drift.
   */
  cost: ModelCost | null;
  /** The credential that served the turn (`llm_usage.credential_id`), or null. */
  credentialId: string | null;
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

/**
 * What a conversation's turn needs in a space to act in it: the turn is the caller's to
 * run (`chat:write`), the conversation stays openable once the space is touched (`chat:read`), and the
 * tools can name the space (`mcp:read`). Read through {@link chatActsIn} alone.
 */
const CHAT_ACTING_PERMISSIONS = ["chat:write", "chat:read", "mcp:read"] as const;

/**
 * Whether a space's effective permissions let a conversation act in it: the one definition behind
 * the chat's acting set (`actingSpaces`) and the web shell's judgement.
 */
export function chatActsIn(permissions: readonly string[]): boolean {
  return CHAT_ACTING_PERMISSIONS.every((permission) => permissions.includes(permission));
}

/** The chat loopback strategy's auth method — the only source `skill://` reads trust for an injected-skills claim. */
export const CHAT_LOOPBACK_AUTH_METHOD = "chat-loopback";

/**
 * The web shell's query parameter that enters a space when an in-app link opens
 * (`?enterSpace=<space id>`). One definition for the two writers of such links: the shell's own
 * lists, and the chat, which persists run links into a conversation (the notice of a run that
 * ended after its turn) where no host renders them.
 */
export const ENTER_SPACE_PARAM = "enterSpace";

/**
 * The skills a chat turn injected, as served: a published version, or the draft
 * at the `lockVersion` it had. Each is bound to `spaceId`, the space its own
 * `skill://<spaceId>/…` URI names, and `resources/read` honours it in that space
 * only. Parsed when the chat strategy verifies the signed bearer, and again where
 * the platform reads it.
 */
export const injectedSkillsSchema = z.strictObject({
  skills: z.record(
    z.string(),
    z.discriminatedUnion("definition", [
      z.strictObject({
        definition: z.literal("published"),
        version: z.string().nullable(),
        spaceId: z.string(),
      }),
      z.strictObject({
        definition: z.literal("draft"),
        lockVersion: z.number().int(),
        spaceId: z.string(),
      }),
    ]),
  ),
});

export type InjectedSkills = z.infer<typeof injectedSkillsSchema>;

/** One skill of {@link InjectedSkills}. */
export type InjectedSkill = InjectedSkills["skills"][string];

/** `authExtra` key of the turn's MCP bearer carrying {@link InjectedSkills}. */
export const INJECTED_SKILLS_AUTH_EXTRA = "injectedSkills";
