// SPDX-License-Identifier: Apache-2.0

/**
 * Chat-engine PLATFORM CONTRACT — the first-party seam for an interactive chat
 * turn, owned by core (the platform contract), NOT by any module.
 *
 * This is deliberately separate from the run-engine routing contract
 * (`./subscription-engines.ts`): the `subscriptionEngine` binding is RUN-ONLY
 * (`{ engine }`) and carries no chat surface, so a future subscription engine
 * never has to be chat-shaped. The chat handler instead flows through the
 * platform contract: a provider module registers its handler at init via
 * {@link PlatformServices.registerChatHandler}, and the chat module resolves it
 * by provider id via {@link PlatformServices.chatHandlerForProvider} — neither
 * module imports the other (module isolation is preserved; everything crosses
 * through `ctx.services`).
 *
 * The type is framework-neutral (no `ai`/UI-stream types) so the implementing
 * provider module and the chat module agree on it through core alone.
 */

/**
 * One chat turn's inputs, handed to a registered chat handler. The caller (the
 * chat module) pre-assembles the transcript into `prompt`; the handler returns
 * a web `Response` (the UI-message-stream body). The vendor SDK and its
 * UI-stream mapping stay entirely inside the provider module.
 */
export interface ChatEngineInput {
  /** Pre-assembled transcript prompt for this turn (the caller builds it). */
  prompt: string;
  /** System persona (+ MCP instructions + host context), already assembled. */
  system: string;
  /** The real upstream model id (e.g. `claude-haiku-4-5`) — NOT a preset id. */
  modelId: string;
  /** Credential-injection gateway base URL (`…/<providerId>-sdk/:presetId`). */
  gatewayBaseUrl: string;
  /** Placeholder bearer the binary sends; the gateway swaps it server-side. */
  placeholderToken: string;
  /** Platform HTTP MCP server (meta-tools); omitted when the mcp module is off. */
  platformMcp?: { url: string; headers: Record<string, string> };
  /** Aborts when the engine's client disconnects. */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
}

/** A chat-turn handler a provider module contributes for its provider id. */
export type ChatEngineHandler = (input: ChatEngineInput) => Response;
