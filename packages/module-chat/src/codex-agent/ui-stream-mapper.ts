// SPDX-License-Identifier: Apache-2.0

/**
 * Map the Codex CLI's `--json` event stream onto the AI SDK **UI message
 * stream** chunks — the same client contract the `ai-sdk` and `claude-code`
 * engines emit, so the chat client stays engine-agnostic.
 *
 * The CLI emits (codex-cli 0.141, `codex exec --json`):
 *   - `thread.started` { thread_id }            — ignored (framing is per-turn)
 *   - `turn.started`                            → `start-step`
 *   - `item.completed` { item: { id, type, text } }
 *        · `agent_message` (the assistant answer) → a complete text block
 *        · `reasoning`                            → a complete reasoning block
 *        · other item types (command_execution, file_change, …) → skipped in
 *          chat (they belong to codex's own coding sandbox, which is read-only
 *          here and irrelevant to a conversational answer)
 *   - `turn.completed` { usage }                → `finish-step` + captured usage
 *   - `turn.failed` / `error`                   → an `error` chunk
 *
 * Unlike the Claude path, codex's public event stream is item-grained, not
 * token-grained — each `item.completed` carries the full text, so we emit a
 * whole text/reasoning block at once (start+delta+end) rather than streaming
 * deltas. Messages therefore appear per-item rather than token-by-token.
 *
 * Framing: `createUIMessageStream` does NOT auto-emit `start`/`finish`; the
 * engine writes {@link startChunk} first and {@link finishChunk} last, and this
 * mapper emits the per-turn `start-step`/`finish-step` boundaries.
 */

import type { UIMessageChunk } from "ai";

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    // `mcp_tool_call` items (server-side tool calls codex makes to our platform
    // MCP). Present on `item.started` (status in_progress) and `item.completed`
    // (status completed/failed, with result or error).
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: unknown;
    error?: { message?: string } | null;
    status?: string;
  };
  usage?: CodexUsage;
  error?: { message?: string } | string;
  message?: string;
}

export interface CodexResultMeta {
  isError: boolean;
  errorText?: string;
  finishReason: "stop" | "error";
  usage?: CodexUsage;
}

export class CodexUiStreamMapper {
  private step = 0;
  private fallbackId = 0;
  private result: CodexResultMeta | null = null;

  /** The opening `start` chunk (engine writes this before iterating). */
  startChunk(messageId: string): UIMessageChunk {
    return { type: "start", messageId };
  }

  map(ev: CodexEvent): UIMessageChunk[] {
    switch (ev.type) {
      case "turn.started":
        this.step += 1;
        return [{ type: "start-step" }];
      case "item.started":
        // Only tool calls carry start-time info worth surfacing (their args are
        // complete here); text/reasoning arrive whole on item.completed.
        return this.mapToolStart(ev.item);
      case "item.completed":
        return this.mapItem(ev.item);
      case "turn.completed":
        this.result = { isError: false, finishReason: "stop", usage: ev.usage };
        return [{ type: "finish-step" }];
      case "turn.failed":
      case "error": {
        const text = this.errorText(ev);
        this.result = { isError: true, errorText: text, finishReason: "error" };
        return [{ type: "error", errorText: text }];
      }
      default:
        return [];
    }
  }

  /**
   * `item.started` for an `mcp_tool_call` → the tool-call card's input. codex
   * delivers the full arguments up front (not streamed), so we emit
   * `tool-input-start` + `tool-input-available` together. Tool names are already
   * unprefixed (`search_operations`), matching the ai-sdk/Claude paths' UIs.
   */
  private mapToolStart(item: CodexEvent["item"]): UIMessageChunk[] {
    if (item?.type !== "mcp_tool_call" || !item.id || !item.tool) return [];
    return [
      { type: "tool-input-start", toolCallId: item.id, toolName: item.tool },
      {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: item.tool,
        input: item.arguments ?? {},
      },
    ];
  }

  private mapItem(item: CodexEvent["item"]): UIMessageChunk[] {
    // mcp_tool_call result (or error) → the tool-call card's output.
    if (item?.type === "mcp_tool_call" && item.id) {
      if (item.error || item.status === "failed") {
        return [
          {
            type: "tool-output-error",
            toolCallId: item.id,
            errorText: item.error?.message ?? "Tool call failed",
          },
        ];
      }
      return [{ type: "tool-output-available", toolCallId: item.id, output: item.result ?? null }];
    }
    const text = item?.text;
    if (!text) return [];
    const id = item?.id ?? `codex-${this.step}-${this.fallbackId++}`;
    if (item?.type === "reasoning") {
      return [
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: text },
        { type: "reasoning-end", id },
      ];
    }
    // agent_message (and any future text-bearing assistant item) → assistant text.
    if (item?.type === "agent_message" || item?.type === "assistant_message") {
      return [
        { type: "text-start", id },
        { type: "text-delta", id, delta: text },
        { type: "text-end", id },
      ];
    }
    // command_execution / file_change / todo_list / … — codex's own coding
    // surface, not part of a conversational answer.
    return [];
  }

  private errorText(ev: CodexEvent): string {
    if (typeof ev.error === "string") return ev.error;
    return ev.error?.message ?? ev.message ?? "Codex a échoué (erreur inconnue).";
  }

  resultMeta(): CodexResultMeta | null {
    return this.result;
  }

  finishChunk(): UIMessageChunk {
    const meta = this.result;
    return {
      type: "finish",
      finishReason: meta?.finishReason === "error" ? "error" : "stop",
      messageMetadata: meta?.usage ? { usage: meta.usage } : undefined,
    };
  }
}
