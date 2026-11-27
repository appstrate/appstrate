// SPDX-License-Identifier: Apache-2.0

/**
 * Map the Pi SDK's `AgentSessionEvent` stream onto the AI SDK **UI message
 * stream** chunks — the exact protocol the chat client (assistant-ui /
 * `useChat`) consumes. The engine's loop is Pi's; the I/O contract stays the
 * one the client already speaks.
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
 * defensively so the client's tool UIs render consistently regardless.
 */

import type { ProviderMetadata, UIMessageChunk } from "ai";
import {
  omitTurnBudgetNote,
  type AppstrateToolPartMetadata,
} from "@appstrate/core/chat-turn-metadata";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import type {
  AgentSessionEvent,
  PiAssistantMessageEvent,
  PiCompactionEndEvent,
  PiCompactionResult,
  PiUsage,
  PiFinishReason,
} from "./pi-events.ts";

/**
 * Strip an `mcp__<server>__` prefix so tool names match the bare MCP names
 * (`mcp__platform__search` → `search`). Tool names may
 * themselves contain `__`, so we split on the delimiter and drop exactly the
 * `mcp` + server segments. Non-MCP names pass through.
 */
export function stripMcpToolPrefix(name: string): string {
  const parts = name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return name;
}

/** The space a platform tool call names (`space_id`), where it is dispatched; none when it names none. */
export function dispatchSpace(args: Record<string, unknown>): string | undefined {
  return typeof args.space_id === "string" ? args.space_id : undefined;
}

type OpenBlockKind = "text" | "reasoning" | "tool";
interface OpenBlock {
  kind: OpenBlockKind;
  id: string;
  toolCallId?: string;
  toolName?: string;
}

/** Session state for closing the turn. Provider usage is metered in the engine. */
interface PiChatResultMeta {
  finishReason: PiFinishReason;
  errorText?: string;
  /** Context usage of the last settled chat call. */
  lastSettledUsage?: PiUsage;
  /** The turn's last summary of the history, absent when Pi made none. */
  compaction?: PiCompaction;
  /**
   * Pi's estimate of the context left by a summary no settled call followed (its threshold
   * summary runs after the turn's last reply): the next request's size, which the last settled
   * call, measured before the summary, overstates.
   */
  contextAfterCompaction?: number;
}

/** What Pi's `compaction_end` result says about the summary it appended. */
export type PiCompaction = Pick<
  PiCompactionResult,
  "summary" | "firstKeptEntryId" | "tokensBefore"
>;

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

interface PiChatUiStreamMapperOptions {
  /**
   * Fired once per turn, on the first ASSISTANT `message_start`. pi-ai pushes
   * its `start` event only after the provider's response headers have arrived
   * (`pi-ai/dist/api/openai-completions.js`, `withResponse()` then `start`), and
   * pi-agent-core turns that into the assistant `message_start` — so this is
   * the turn's time-to-first-response, the point where waiting on the model
   * begins to pay out. The user echo's `message_start` fires at `prompt()` and
   * is not it.
   */
  onFirstModelEvent?: () => void;
  /**
   * The ids of the turn's spaces. A call naming one of them (`dispatchSpace`) is stamped with it
   * as `providerMetadata.appstrate.spaceId`, the one record every card reads where the call
   * acted, long after the conversation's limit has changed. A call naming another space is
   * refused before dispatch and acted nowhere: it is not stamped. None: nothing is stamped.
   */
  turnSpaces?: ReadonlySet<string>;
}

/**
 * Stateful translator. One instance per chat turn; {@link map} is called for
 * each Pi session event in arrival order and returns the UI chunks to write.
 */
export class PiChatUiStreamMapper {
  private readonly onFirstModelEvent: (() => void) | undefined;
  private readonly turnSpaces: ReadonlySet<string>;
  private lookupTools: ReadonlySet<string> = new Set();

  constructor(options: PiChatUiStreamMapperOptions = {}) {
    this.turnSpaces = options.turnSpaces ?? new Set();
    this.onFirstModelEvent = options.onFirstModelEvent;
  }

  /** Stamped `lookup` from a call's first chunk, so the UI folds it before its result arrives. */
  describeLookupTools(tools: ReadonlySet<string>): void {
    this.lookupTools = tools;
  }

  /**
   * Id namespace for content blocks. Bumped on EVERY `message_start` — Pi emits
   * one per user, assistant AND tool-result message — which is what keeps
   * `${blockSeq}-${contentIndex}` unique across the turn.
   */
  private blockSeq = 0;
  /**
   * Number of MODEL calls in the turn: the only counter comparable to
   * `CHAT_MAX_STEPS`, and the one the step cap reads. Assistant `message_start`s
   * only — counting every `message_start` over-counts a tool-heavy turn
   * several-fold (the audited incident reported `stepCount: 20` for a turn that
   * never made 20 model calls, because each user echo and each tool result
   * counted as a step).
   */
  private modelCalls = 0;
  private readonly open = new Map<number, OpenBlock>();
  private finishReason: PiFinishReason = "stop";
  private lastError: string | undefined;
  private lastTool: string | undefined;
  private lastSettledUsage: PiUsage | undefined;
  private compaction: PiCompaction | undefined;
  private contextAfterCompaction: number | undefined;

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
      durationMs?: unknown;
    };
    switch (e.type) {
      case "message_start":
        this.blockSeq += 1;
        if (assistantView(e.message)) {
          this.modelCalls += 1;
          if (this.modelCalls === 1) this.onFirstModelEvent?.();
        }
        this.open.clear();
        return [{ type: "start-step" }];
      case "message_update":
        return e.assistantMessageEvent ? this.mapAssistantEvent(e.assistantMessageEvent) : [];
      case "tool_execution_end":
        return this.mapToolExecutionEnd({
          toolCallId: String(e.toolCallId ?? ""),
          result: e.result,
          isError: e.isError === true,
          ...(typeof e.durationMs === "number" && { durationMs: e.durationMs }),
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
        // Verdict on the LAST assistant message of the run, never on every
        // entry in the list. `agent_end.messages` is the run's `newMessages` —
        // everything it just produced — so replaying all of them through
        // `captureFailure` re-asserts a failure a later call already recovered
        // from, one event AFTER `captureMessageEnd` retired it, and drags
        // `finishReason` back to "error" with it.
        //
        // Last-assistant is the rule this stack already states in two places,
        // not a third one invented here: Pi's own retry decision scans back to
        // the last assistant message (`AgentSession._willRetryAfterAgentEnd`),
        // and the runner's terminal verdict is documented as "derived from the
        // LAST assistant turn … a transient error the agent recovered from
        // before a later clean turn" returns undefined (`getTerminalError` in
        // `@appstrate/runner-pi`). It also keeps the reason this branch exists:
        // a `handleRunFailure` message that never got a `message_end` is the
        // only assistant entry in its list, so it is still captured.
        this.captureFailure(lastAssistantMessage(e.messages ?? []));
        return [];
      case "compaction_end": {
        // The catch-all member defeats narrowing; the view is pinned to Pi's (`pi-events.ts`).
        const { result, aborted } = event as PiCompactionEndEvent;
        if (aborted || !result) return [];
        // A later summary in the same turn starts from the earlier one, so it replaces it.
        const { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter } = result;
        this.compaction = { summary, firstKeptEntryId, tokensBefore };
        this.contextAfterCompaction =
          estimatedTokensAfter !== undefined && estimatedTokensAfter > 0
            ? estimatedTokensAfter
            : undefined;
        return [];
      }
      default:
        return [];
    }
  }

  private blockId(index: number): string {
    return `${this.blockSeq}-${index}`;
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
        const lookup = this.lookupTools.has(toolName);
        return [
          {
            type: "tool-input-start",
            toolCallId,
            toolName,
            ...(lookup && { providerMetadata: toolPartMetadata({ lookup }) }),
          },
        ];
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
        const input = ev.toolCall.arguments ?? {};
        const named = dispatchSpace(input);
        const spaceId = named !== undefined && this.turnSpaces.has(named) ? named : undefined;
        const lookup = this.lookupTools.has(toolName);
        const appstrate: AppstrateToolPartMetadata = {
          ...(spaceId && { spaceId }),
          ...(lookup && { lookup }),
        };
        return [
          {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input,
            ...(Object.keys(appstrate).length > 0 && {
              providerMetadata: toolPartMetadata(appstrate),
            }),
          },
        ];
      }
      default:
        return [];
    }
  }

  /**
   * What the UI reads of an outcome rides `providerMetadata.appstrate`: the AI SDK stores it
   * (`resultProviderMetadata`) on a failure too, whose chunk carries no output.
   */
  private mapToolExecutionEnd(ev: {
    toolCallId: string;
    result: unknown;
    isError: boolean;
    durationMs?: number;
  }): UIMessageChunk[] {
    const { output, presentation, actedSpaceIds } = persistedToolOutput(ev.result);
    const appstrate: AppstrateToolPartMetadata = {
      ...(presentation && { presentation }),
      ...(actedSpaceIds && { actedSpaceIds }),
      ...(ev.durationMs !== undefined && { durationMs: ev.durationMs }),
    };
    const meta = Object.keys(appstrate).length > 0 && {
      providerMetadata: toolPartMetadata(appstrate),
    };
    if (ev.isError) {
      return [
        {
          type: "tool-output-error",
          toolCallId: ev.toolCallId,
          errorText: stringifyToolResult(output),
          ...meta,
        },
      ];
    }
    return [{ type: "tool-output-available", toolCallId: ev.toolCallId, output, ...meta }];
  }

  private captureMessageEnd(message: unknown): void {
    const m = assistantView(message);
    if (!m) return;
    // Pi's own rule for a call that measured something (`getLastAssistantUsage`).
    if (m.usage && m.stopReason !== "aborted" && m.stopReason !== "error") {
      this.lastSettledUsage = m.usage;
      this.contextAfterCompaction = undefined;
    }
    this.finishReason = mapStopReason(m.stopReason);
    // A model call that SETTLED retires the previous failure. Pi retries inside
    // one turn, so an early 503 the next call recovered from is no longer this
    // turn's cause — and `lastError`, which used to be write-once, kept being
    // reported as one. That is now visible: the client surfaces the persisted
    // category on a DEADLINE turn too, so a stale text would name a cause that
    // no longer applies for a turn that simply ran out of clock.
    //
    // Two stop reasons deliberately do NOT clear:
    //  - "error": the call failed; `captureFailure` records it right below.
    //  - "aborted": a stop / the deadline cut the call mid-flight, so it
    //    settled nothing — an earlier failure is still the last thing that
    //    actually went wrong and must keep reaching the user.
    //
    // Nothing genuine is silenced on the engine's `error`-chunk path: the same
    // `message_end` that clears the text also moves `finishReason` off "error",
    // and `clearFailure()` retires both at once before a file-refusal replay.
    if (m.stopReason !== "error" && m.stopReason !== "aborted") this.lastError = undefined;
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

  /** Retire the recorded failure: the engine replays the failed call (`file-refusal.ts`). */
  clearFailure(): void {
    if (this.finishReason === "error") this.finishReason = "stop";
    this.lastError = undefined;
  }

  /** Model calls completed so far in this turn (see {@link modelCalls}). */
  stepCount(): number {
    return this.modelCalls;
  }

  lastToolName(): string | undefined {
    return this.lastTool;
  }

  /** Terminal metadata accumulated over the turn. */
  result(): PiChatResultMeta {
    return {
      finishReason: this.finishReason,
      ...(this.lastError ? { errorText: this.lastError } : {}),
      ...(this.lastSettledUsage ? { lastSettledUsage: this.lastSettledUsage } : {}),
      ...(this.compaction ? { compaction: this.compaction } : {}),
      ...(this.contextAfterCompaction !== undefined
        ? { contextAfterCompaction: this.contextAfterCompaction }
        : {}),
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

/**
 * The run's terminal assistant message: the last one in arrival order, or
 * `undefined` when the list holds none. Scanning back past the tail is what
 * keeps trailing non-assistant entries (tool results, injected steering
 * messages) from masking the message that actually decided the run.
 */
function lastAssistantMessage(messages: readonly unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (assistantView(messages[i])) return messages[i];
  }
  return undefined;
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

/**
 * The tool output that crosses the wire and gets persisted: the Pi result
 * WITHOUT `details`.
 *
 * A Pi `AgentToolResult` carries its payload twice — `content[0].text` is the
 * JSON string the MODEL reads, `details` the same object for Pi's own in-memory
 * UI channel. Nothing in this module's UI reads `details` (`src/ui/tool-result.ts`
 * parses `content`; `src/ui/auth-offer.ts` reads the typed `connectOffers`),
 * and every tool output is persisted, served by the history GET and re-uploaded
 * by the client on every later turn — so the wire/persisted shape is the model
 * channel plus the typed offers: `content`, `connectOffers`, `isError` and
 * whatever else the result carries, minus `details`. The in-memory Pi result
 * itself is untouched (`mcp-tools.ts` builds it with `details`).
 */
function persistedToolOutput(result: unknown): {
  output: unknown;
  presentation?: ToolPresentation;
  actedSpaceIds?: string[];
} {
  if (result == null) return { output: null };
  if (typeof result !== "object" || Array.isArray(result)) return { output: result };
  const {
    details: _details,
    persistedContent,
    presentation,
    actedSpaceIds,
    ...rest
  } = result as Record<string, unknown> & { presentation?: ToolPresentation };
  return {
    output: Array.isArray(persistedContent) ? { ...rest, content: persistedContent } : rest,
    ...(presentation && { presentation }),
    ...(isStringArray(actedSpaceIds) && { actedSpaceIds }),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The AI SDK's provider metadata for a tool part: ours under `appstrate`. */
function toolPartMetadata(appstrate: AppstrateToolPartMetadata): ProviderMetadata {
  return { appstrate } as ProviderMetadata;
}

/** Flatten a Pi tool result (`AgentToolResult` content blocks) to text for error output. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      // The model's turn-budget note is marked: it is not the reader's.
      const texts = (omitTurnBudgetNote(content) as unknown[]).map((c) =>
        c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
      );
      return texts.join("");
    }
    return JSON.stringify(result);
  }
  return result == null ? "" : String(result);
}
