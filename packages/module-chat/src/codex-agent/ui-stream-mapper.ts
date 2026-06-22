// SPDX-License-Identifier: Apache-2.0

/**
 * Map the Codex CLI's `--json` event stream onto the AI SDK **UI message
 * stream** chunks — the same client contract the `ai-sdk` and `claude-code`
 * engines emit, so the chat client stays engine-agnostic.
 *
 * The CLI emits (codex-cli 0.141, `codex exec --json`):
 *   - `thread.started` { thread_id }            — ignored (framing is per-turn)
 *   - `turn.started`                            → `start-step`
 *   - `item.started`   { item: { type: "mcp_tool_call", … } } → `tool-input-available`
 *   - `item.completed` { item: { id, type, text } }
 *        · `agent_message` (the assistant answer) → a complete text block
 *        · `reasoning`                            → a complete reasoning block
 *        · `mcp_tool_call`                        → `tool-output-available`/`-error`
 *          (the platform MCP tools — see mapToolInput/Complete)
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
import type { CodexEvent, CodexUsage } from "@appstrate/core/codex-binary";

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
  /** MCP tool-call ids whose `tool-input-available` chunk was already emitted. */
  private readonly toolInputSeen = new Set<string>();

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
        // Only MCP tool calls need an early chunk (input as soon as the call
        // starts). Text/reasoning items carry their full text on item.completed.
        return ev.item?.type === "mcp_tool_call" ? this.mapToolInput(ev.item) : [];
      case "item.completed":
        if (ev.item?.type === "mcp_tool_call") return this.mapToolComplete(ev.item);
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

  private mapItem(item: CodexEvent["item"]): UIMessageChunk[] {
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
    // command_execution / file_change / todo_list / … — codex's sandboxed
    // coding surface, not part of a conversational answer. (mcp_tool_call is
    // handled separately — see mapToolInput / mapToolComplete.)
    return [];
  }

  /**
   * `item.started` for an `mcp_tool_call` → a `tool-input-available` chunk so
   * the client renders the call (the same React tool UI the ai-sdk/Claude paths
   * use). Codex's `tool` field is the bare tool name (no `mcp__server__`
   * prefix), so it matches the client UIs directly — no stripping needed.
   */
  private mapToolInput(item: CodexEvent["item"]): UIMessageChunk[] {
    const id = item?.id;
    const toolName = item?.tool;
    if (!id || !toolName || this.toolInputSeen.has(id)) return [];
    this.toolInputSeen.add(id);
    return [
      { type: "tool-input-available", toolCallId: id, toolName, input: item?.arguments ?? {} },
    ];
  }

  /**
   * `item.completed` for an `mcp_tool_call` → a `tool-output-available` (or
   * `tool-output-error`) chunk. If `item.started` was missed, the input chunk is
   * emitted first so the tool still renders.
   */
  private mapToolComplete(item: CodexEvent["item"]): UIMessageChunk[] {
    const id = item?.id;
    if (!id) return [];
    const chunks = this.mapToolInput(item); // no-op if already emitted
    if (item?.status === "failed" || item?.error) {
      chunks.push({
        type: "tool-output-error",
        toolCallId: id,
        errorText: item?.error?.message ?? "MCP tool call failed.",
      });
      return chunks;
    }
    const output = item?.result?.structured_content ?? item?.result?.content ?? null;
    chunks.push({ type: "tool-output-available", toolCallId: id, output });
    return chunks;
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
