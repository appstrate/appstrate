// SPDX-License-Identifier: Apache-2.0

/**
 * Map the Pi SDK's `AgentSessionEvent` stream onto the AI SDK **UI message
 * stream** chunks — the exact protocol the chat client (assistant-ui /
 * `useChat`) already consumes from the `ai-sdk` path. This is what lets the
 * single generic Pi subscription chat engine share one client contract with the
 * `ai-sdk` engine (the loop differs; the I/O contract is shared).
 *
 * Pi emits (via `session.subscribe(cb)`):
 *   - `message_start` — a new assistant message → per-turn `start-step`.
 *   - `message_update` with `assistantMessageEvent` — token-level deltas
 *     (text / thinking / tool-call input), keyed by `contentIndex`.
 *   - `tool_execution_end` — a tool finished executing → tool-output chunk.
 *   - `message_end` — the assistant message closed → `finish-step`; carries the
 *     completed message's `usage` + `stopReason`.
 *
 * Framing: `createUIMessageStream` does NOT auto-emit `start`/`finish`, so the
 * engine writes {@link startChunk} first and the closing `finish` last (with the
 * merged turn metadata); this mapper emits the per-turn `start-step`/`finish-step`
 * boundaries (matching `streamText().toUIMessageStreamResponse()`).
 *
 * Tool-name parity: Pi tools are registered under their raw MCP names, so no
 * `mcp__<server>__` prefix is present — but {@link stripMcpToolPrefix} is applied
 * defensively so the client's tool UIs match the `ai-sdk` path regardless.
 */

import type { UIMessageChunk } from "ai";
import type {
  AgentSessionEvent,
  PiAssistantMessageEvent,
  PiUsage,
  PiFinishReason,
} from "./pi-events.ts";

/**
 * Strip an `mcp__<server>__` prefix so tool names match the `ai-sdk` path
 * (`mcp__platform__search_operations` → `search_operations`). Tool names may
 * themselves contain `__`, so we split on the delimiter and drop exactly the
 * `mcp` + server segments. Non-MCP names pass through.
 */
export function stripMcpToolPrefix(name: string): string {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return name;
}

type OpenBlockKind = "text" | "reasoning" | "tool";
interface OpenBlock {
  kind: OpenBlockKind;
  id: string;
  toolCallId?: string;
  toolName?: string;
}

/** Terminal metadata accumulated across the turn. */
export interface PiChatResultMeta {
  usage: PiUsage;
  costUsd: number;
  finishReason: PiFinishReason;
  errorText?: string;
}

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function mapStopReason(stop: string | undefined): PiFinishReason {
  switch (stop) {
    case "length":
      return "length";
    case "toolUse":
      return "tool-calls";
    case "error":
      return "error";
    case "aborted":
      return "other";
    case "stop":
    default:
      return "stop";
  }
}

/**
 * Stateful translator. One instance per chat turn; {@link map} is called for
 * each Pi session event in arrival order and returns the UI chunks to write.
 */
export class PiChatUiStreamMapper {
  private step = 0;
  private readonly open = new Map<number, OpenBlock>();
  private accUsage: PiUsage = { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
  private accCost = 0;
  private finishReason: PiFinishReason = "stop";
  private lastError: string | undefined;
  private lastTool: string | undefined;

  /** The opening `start` chunk (engine writes this before iterating). */
  startChunk(messageId: string): UIMessageChunk {
    return { type: "start", messageId };
  }

  map(event: AgentSessionEvent): UIMessageChunk[] {
    // The `AgentSessionEvent` union carries a `{ type: string; [k]: unknown }`
    // catch-all member (unknown-but-tolerated Pi events), which defeats
    // discriminated narrowing on the specific members — so read the payload
    // fields off a widened view after switching on `type`.
    const e = event as {
      type: string;
      assistantMessageEvent?: PiAssistantMessageEvent;
      message?: unknown;
      messages?: unknown[];
      toolCallId?: string;
      result?: unknown;
      isError?: boolean;
    };
    switch (e.type) {
      case "message_start":
        this.step += 1;
        this.open.clear();
        return [{ type: "start-step" }];
      case "message_update":
        return e.assistantMessageEvent ? this.mapAssistantEvent(e.assistantMessageEvent) : [];
      case "tool_execution_end":
        return this.mapToolExecutionEnd({
          toolCallId: String(e.toolCallId ?? ""),
          result: e.result,
          isError: e.isError === true,
        });
      case "message_end":
        this.captureMessageEnd(e.message);
        return [{ type: "finish-step" }];
      // A run that fails OUTSIDE the assistant stream (tool exception, context
      // overflow — pi-agent-core's `handleRunFailure`) never emits a
      // `message_end`: the errored assistant message only rides `turn_end` /
      // `agent_end`. Capture it there too, or the turn would end silently.
      case "turn_end":
        this.captureFailure(e.message);
        return [];
      case "agent_end":
        for (const m of e.messages ?? []) this.captureFailure(m);
        return [];
      default:
        return [];
    }
  }

  private blockId(index: number): string {
    return `${this.step}-${index}`;
  }

  private mapAssistantEvent(ev: PiAssistantMessageEvent): UIMessageChunk[] {
    switch (ev.type) {
      case "text_start": {
        const id = this.blockId(ev.contentIndex);
        this.open.set(ev.contentIndex, { kind: "text", id });
        return [{ type: "text-start", id }];
      }
      case "text_delta": {
        const block = this.open.get(ev.contentIndex);
        if (!block || block.kind !== "text") return [];
        return [{ type: "text-delta", id: block.id, delta: ev.delta }];
      }
      case "text_end": {
        const block = this.open.get(ev.contentIndex);
        if (!block || block.kind !== "text") return [];
        this.open.delete(ev.contentIndex);
        return [{ type: "text-end", id: block.id }];
      }
      case "thinking_start": {
        const id = this.blockId(ev.contentIndex);
        this.open.set(ev.contentIndex, { kind: "reasoning", id });
        return [{ type: "reasoning-start", id }];
      }
      case "thinking_delta": {
        const block = this.open.get(ev.contentIndex);
        if (!block || block.kind !== "reasoning") return [];
        return [{ type: "reasoning-delta", id: block.id, delta: ev.delta }];
      }
      case "thinking_end": {
        const block = this.open.get(ev.contentIndex);
        if (!block || block.kind !== "reasoning") return [];
        this.open.delete(ev.contentIndex);
        return [{ type: "reasoning-end", id: block.id }];
      }
      case "toolcall_start": {
        const call = toolCallAt(ev.partial, ev.contentIndex);
        const toolCallId = call?.id || this.blockId(ev.contentIndex);
        const toolName = stripMcpToolPrefix(call?.name ?? "");
        this.lastTool = toolName;
        this.open.set(ev.contentIndex, { kind: "tool", id: toolCallId, toolCallId, toolName });
        return [{ type: "tool-input-start", toolCallId, toolName }];
      }
      case "toolcall_delta": {
        const block = this.open.get(ev.contentIndex);
        if (!block || block.kind !== "tool" || !block.toolCallId) return [];
        return [
          { type: "tool-input-delta", toolCallId: block.toolCallId, inputTextDelta: ev.delta },
        ];
      }
      case "toolcall_end": {
        const block = this.open.get(ev.contentIndex);
        this.open.delete(ev.contentIndex);
        const toolCallId = block?.toolCallId ?? ev.toolCall.id;
        const toolName = stripMcpToolPrefix(block?.toolName ?? ev.toolCall.name);
        this.lastTool = toolName;
        return [
          {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: ev.toolCall.arguments ?? {},
          },
        ];
      }
      default:
        return [];
    }
  }

  private mapToolExecutionEnd(ev: {
    toolCallId: string;
    result: unknown;
    isError: boolean;
  }): UIMessageChunk[] {
    if (ev.isError) {
      return [
        {
          type: "tool-output-error",
          toolCallId: ev.toolCallId,
          errorText: stringifyToolResult(ev.result),
        },
      ];
    }
    return [
      { type: "tool-output-available", toolCallId: ev.toolCallId, output: ev.result ?? null },
    ];
  }

  private captureMessageEnd(message: unknown): void {
    const m = assistantView(message);
    if (!m) return;
    if (m.usage) this.addUsage(m.usage);
    this.finishReason = mapStopReason(m.stopReason);
    this.captureFailure(message);
  }

  /**
   * Capture a genuine failure (`stopReason: "error"`) into the terminal meta.
   * An explicit stop (`aborted`) is NOT a failure — surfacing its message as an
   * error would flag every user stop as a fault.
   */
  private captureFailure(message: unknown): void {
    const m = assistantView(message);
    if (!m?.errorMessage || m.stopReason !== "error") return;
    this.finishReason = "error";
    this.lastError = m.errorMessage;
  }

  private addUsage(u: PiUsage): void {
    this.accUsage = {
      input: this.accUsage.input + (u.input ?? 0),
      output: this.accUsage.output + (u.output ?? 0),
      cacheRead: this.accUsage.cacheRead + (u.cacheRead ?? 0),
      cacheWrite: this.accUsage.cacheWrite + (u.cacheWrite ?? 0),
      totalTokens: this.accUsage.totalTokens + (u.totalTokens ?? 0),
      cost: {
        input: this.accUsage.cost.input + (u.cost?.input ?? 0),
        output: this.accUsage.cost.output + (u.cost?.output ?? 0),
        cacheRead: this.accUsage.cost.cacheRead + (u.cost?.cacheRead ?? 0),
        cacheWrite: this.accUsage.cost.cacheWrite + (u.cost?.cacheWrite ?? 0),
        total: this.accUsage.cost.total + (u.cost?.total ?? 0),
      },
    };
    this.accCost += u.cost?.total ?? 0;
  }

  stepCount(): number {
    return this.step;
  }

  lastToolName(): string | undefined {
    return this.lastTool;
  }

  /** Terminal metadata accumulated over the turn. */
  result(): PiChatResultMeta {
    return {
      usage: this.accUsage,
      costUsd: this.accCost,
      finishReason: this.finishReason,
      ...(this.lastError ? { errorText: this.lastError } : {}),
    };
  }
}

interface PiAssistantView {
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

/** Structural view of an assistant message, or null for anything else. */
function assistantView(message: unknown): PiAssistantView | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { role?: string } & PiAssistantView;
  return m.role === "assistant" ? m : null;
}

interface PiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Read the `toolCall` content block at `index` from a partial assistant message. */
function toolCallAt(partial: unknown, index: number): PiToolCallBlock | undefined {
  if (!partial || typeof partial !== "object") return undefined;
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content[index];
  if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
    return block as PiToolCallBlock;
  }
  return undefined;
}

/** Flatten a Pi tool result (`AgentToolResult` content blocks) to text for error output. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) =>
          c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
        )
        .join("");
    }
    return JSON.stringify(result);
  }
  return result == null ? "" : String(result);
}
