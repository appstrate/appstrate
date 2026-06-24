// SPDX-License-Identifier: Apache-2.0

/**
 * Map the Claude Agent SDK's message stream onto the AI SDK **UI message
 * stream** chunks — the exact protocol the chat client (assistant-ui /
 * `useChat`) already consumes from the `ai-sdk` path. This is what lets the
 * `claude-code` subscription engine share one client contract with the
 * `ai-sdk` engine (plan §5.1: "the loop differs; the I/O contract is shared").
 *
 * The SDK emits (with `includePartialMessages: true`):
 *   - `stream_event` — raw Anthropic stream events (message_start,
 *     content_block_start/delta/stop, message_stop). We translate these into
 *     token-level UI chunks (text/reasoning/tool-input deltas).
 *   - `user` — tool_result blocks from tool execution → tool-output chunks.
 *   - `assistant` — a complete turn message; we read only its `error` field
 *     (text/tool_use already streamed via `stream_event`, so re-emitting would
 *     duplicate).
 *   - `result` — terminal; carries usage/cost and the error subtype.
 *
 * Framing: `createUIMessageStream` does NOT auto-emit `start`/`finish`, so the
 * engine calls {@link startChunk} first and {@link finishChunk} last; this
 * mapper emits the per-turn `start-step`/`finish-step` boundaries (matching
 * `streamText().toUIMessageStreamResponse()`).
 *
 * Tool-name parity: the SDK prefixes MCP tools as `mcp__<server>__<tool>`.
 * The `ai-sdk` path exposes them unprefixed (`search_operations`,
 * `invoke_operation`, …). We strip the prefix so the client's tool UIs match
 * regardless of engine — see {@link stripMcpToolPrefix}.
 */

import type { UIMessageChunk } from "ai";
import { parseToolResultBlocks } from "@appstrate/runner-claude";

/**
 * Strip the Agent SDK's `mcp__<server>__` prefix so tool names match the
 * `ai-sdk` path (`mcp__platform__search_operations` → `search_operations`).
 * Tool names may themselves contain `__`, so we split on the delimiter and
 * drop exactly the `mcp` + server segments. Non-MCP names pass through.
 */
export function stripMcpToolPrefix(name: string): string {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return name;
}

/** Minimal structural view of the SDK messages this mapper reads. */
interface RawStreamDelta {
  type: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
}
interface RawContentBlock {
  type: string;
  id?: string;
  name?: string;
}
interface RawStreamEvent {
  type: string;
  index?: number;
  content_block?: RawContentBlock;
  delta?: RawStreamDelta;
}
export interface ClaudeSdkMessage {
  type: string;
  event?: RawStreamEvent;
  message?: { content?: unknown; role?: string };
  error?: string;
  subtype?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: unknown;
  result?: string;
}

type OpenBlockKind = "text" | "reasoning" | "tool";
interface OpenBlock {
  kind: OpenBlockKind;
  id: string;
  toolCallId?: string;
  toolName?: string;
  json: string;
}

/** Terminal metadata captured from the SDK `result` message. */
export interface ClaudeResultMeta {
  isError: boolean;
  errorText?: string;
  finishReason: "stop" | "length" | "tool-calls" | "error" | "other";
  usage?: unknown;
  totalCostUsd?: number;
}

const SDK_ERROR_MESSAGES: Record<string, string> = {
  authentication_failed: "Authentification Claude échouée — reconnectez votre abonnement Claude.",
  // Anthropic's wire code for an auth failure (e.g. the gateway's 401 envelope
  // on a revoked subscription) — alias of the above so either surfaces cleanly.
  authentication_error: "Authentification Claude échouée — reconnectez votre abonnement Claude.",
  oauth_org_not_allowed: "Cet abonnement Claude n'autorise pas cette organisation.",
  billing_error: "Problème de facturation sur l'abonnement Claude.",
  rate_limit: "Limite de débit Claude atteinte — réessayez dans un instant.",
  overloaded: "Le service Claude est surchargé — réessayez dans un instant.",
  invalid_request: "Requête invalide envoyée au modèle Claude.",
  model_not_found: "Modèle Claude introuvable pour cet abonnement.",
  server_error: "Erreur serveur côté Claude.",
  max_output_tokens: "Réponse interrompue : limite de tokens de sortie atteinte.",
  unknown: "Le modèle Claude a échoué (erreur inconnue).",
};

function mapSdkError(code: string | undefined): string {
  return (code && SDK_ERROR_MESSAGES[code]) || SDK_ERROR_MESSAGES.unknown!;
}

/**
 * Stateful translator. One instance per chat turn; `map()` is called for each
 * SDK message in arrival order and returns the UI chunks to write.
 */
export class SdkUiStreamMapper {
  private step = 0;
  private readonly open = new Map<number, OpenBlock>();
  private result: ClaudeResultMeta | null = null;

  private blockId(index: number): string {
    return `${this.step}-${index}`;
  }

  /** The opening `start` chunk (engine writes this before iterating). */
  startChunk(messageId: string): UIMessageChunk {
    return { type: "start", messageId };
  }

  map(msg: ClaudeSdkMessage): UIMessageChunk[] {
    switch (msg.type) {
      case "stream_event":
        return msg.event ? this.mapStreamEvent(msg.event) : [];
      case "user":
        return this.mapToolResults(msg.message?.content);
      case "assistant":
        // Text/tool_use already streamed via stream_event; surface only errors.
        return msg.error ? [{ type: "error", errorText: mapSdkError(msg.error) }] : [];
      case "result":
        this.captureResult(msg);
        return [];
      default:
        return [];
    }
  }

  private mapStreamEvent(event: RawStreamEvent): UIMessageChunk[] {
    switch (event.type) {
      case "message_start":
        this.step += 1;
        this.open.clear();
        return [{ type: "start-step" }];
      case "content_block_start":
        return this.openBlock(event);
      case "content_block_delta":
        return this.deltaBlock(event);
      case "content_block_stop":
        return this.closeBlock(event);
      case "message_stop":
        return [{ type: "finish-step" }];
      default:
        return [];
    }
  }

  private openBlock(event: RawStreamEvent): UIMessageChunk[] {
    const index = event.index ?? 0;
    const cb = event.content_block;
    if (!cb) return [];
    if (cb.type === "text") {
      const id = this.blockId(index);
      this.open.set(index, { kind: "text", id, json: "" });
      return [{ type: "text-start", id }];
    }
    if (cb.type === "thinking") {
      const id = this.blockId(index);
      this.open.set(index, { kind: "reasoning", id, json: "" });
      return [{ type: "reasoning-start", id }];
    }
    if (cb.type === "tool_use" && cb.id && cb.name) {
      const toolName = stripMcpToolPrefix(cb.name);
      this.open.set(index, { kind: "tool", id: cb.id, toolCallId: cb.id, toolName, json: "" });
      return [{ type: "tool-input-start", toolCallId: cb.id, toolName }];
    }
    return [];
  }

  private deltaBlock(event: RawStreamEvent): UIMessageChunk[] {
    const block = this.open.get(event.index ?? 0);
    const delta = event.delta;
    if (!block || !delta) return [];
    if (delta.type === "text_delta" && block.kind === "text" && delta.text !== undefined) {
      return [{ type: "text-delta", id: block.id, delta: delta.text }];
    }
    if (
      delta.type === "thinking_delta" &&
      block.kind === "reasoning" &&
      delta.thinking !== undefined
    ) {
      return [{ type: "reasoning-delta", id: block.id, delta: delta.thinking }];
    }
    if (
      delta.type === "input_json_delta" &&
      block.kind === "tool" &&
      delta.partial_json !== undefined
    ) {
      block.json += delta.partial_json;
      return [
        {
          type: "tool-input-delta",
          toolCallId: block.toolCallId!,
          inputTextDelta: delta.partial_json,
        },
      ];
    }
    return [];
  }

  private closeBlock(event: RawStreamEvent): UIMessageChunk[] {
    const index = event.index ?? 0;
    const block = this.open.get(index);
    if (!block) return [];
    this.open.delete(index);
    if (block.kind === "text") return [{ type: "text-end", id: block.id }];
    if (block.kind === "reasoning") return [{ type: "reasoning-end", id: block.id }];
    // tool: the accumulated partial_json is the complete tool input.
    return [
      {
        type: "tool-input-available",
        toolCallId: block.toolCallId!,
        toolName: block.toolName!,
        input: safeJsonParse(block.json),
      },
    ];
  }

  private mapToolResults(content: unknown): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    for (const r of parseToolResultBlocks(content)) {
      if (!r.toolUseId) continue;
      chunks.push(
        r.isError
          ? {
              type: "tool-output-error",
              toolCallId: r.toolUseId,
              errorText: stringifyToolContent(r.content),
            }
          : {
              type: "tool-output-available",
              toolCallId: r.toolUseId,
              output: r.content ?? null,
            },
      );
    }
    return chunks;
  }

  private captureResult(msg: ClaudeSdkMessage): void {
    const isError = msg.subtype === "error" || msg.is_error === true;
    this.result = {
      isError,
      errorText: isError ? (msg.result && msg.result.trim()) || mapSdkError("unknown") : undefined,
      finishReason: mapStopReason(msg.stop_reason, isError),
      usage: msg.usage,
      totalCostUsd: msg.total_cost_usd,
    };
  }

  /** Terminal metadata captured from the `result` message (null if none seen). */
  resultMeta(): ClaudeResultMeta | null {
    return this.result;
  }

  /**
   * The closing `finish` chunk (engine writes this last). When the turn ended
   * in an SDK error the engine writes an `error` chunk before it; the finish
   * still closes the stream cleanly.
   */
  finishChunk(): UIMessageChunk {
    const meta = this.result;
    return {
      type: "finish",
      finishReason: meta?.finishReason ?? "stop",
      messageMetadata: meta ? { usage: meta.usage, costUsd: meta.totalCostUsd } : undefined,
    };
  }
}

function mapStopReason(
  stop: string | null | undefined,
  isError: boolean,
): ClaudeResultMeta["finishReason"] {
  if (isError) return "error";
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

function safeJsonParse(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Flatten an Anthropic tool_result `content` (string | block[]) to text. */
function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
      )
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}
