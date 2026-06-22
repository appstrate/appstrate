// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Translate the Claude Agent SDK message stream into the canonical AFPS
 * {@link RunEvent} stream the platform already consumes from the Pi runner —
 * the runner-side counterpart of the chat's `ui-stream-mapper.ts`.
 *
 * The chat mapper targets the AI-SDK *UI* message stream (token-level chunks
 * for a live transcript). A *run* is autonomous and fire-and-forget, so this
 * mapper mirrors {@link installSessionBridge} (Pi) instead: message-level
 * granularity only, emitting `appstrate.progress` / `appstrate.metric` /
 * `appstrate.error`. It deliberately does NOT consume `stream_event`
 * partial-message chunks — a 1000-token reply would otherwise produce ~1000
 * signed POSTs + `run_logs` rows describing content already delivered whole on
 * the `assistant` message.
 *
 * Structured deliverable, runtime-tool events (log/note/pin/report), and the
 * terminal verdict do NOT come through here:
 *   - the deliverable is read natively off `result.structured_output` by the
 *     runner (Phase-0 spike `OUTPUT_NATIVE_OK`),
 *   - runtime-tool events are emitted directly to the sink by the in-process
 *     MCP handlers (spike `INSTANCE_OK`; `_meta` over HTTP MCP is dropped —
 *     spike `META_DROPPED`),
 *   - the terminal status/usage/cost is captured from the `result` message via
 *     {@link SdkRunEventMapper.terminal}.
 *
 * Structural SDK types are declared locally (not imported from the SDK) so the
 * mapper is unit-testable on hand-built fixtures and resilient to non-breaking
 * SDK shape additions.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import {
  truncateToolResult,
  zeroTokenUsage,
  type RunError,
  type RunResult,
  type TokenUsage,
} from "@appstrate/afps-runtime/runner";

// ─── Minimal structural view of the SDK messages we read ───────────────

interface SdkTextBlock {
  type: "text";
  text?: string;
}
interface SdkToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}
interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
type SdkContentBlock = SdkTextBlock | SdkToolUseBlock | SdkToolResultBlock | { type: string };

/** A tool call observed to completion — name, the args passed, and outcome. */
export interface CompletedToolCall {
  name: string;
  input: unknown;
  isError: boolean;
}

/** Anthropic usage counters — already snake_case, maps 1:1 onto {@link TokenUsage}. */
export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SdkAssistantMessage {
  type: "assistant";
  message?: { content?: SdkContentBlock[] | unknown; usage?: SdkUsage };
  /** Per-turn assistant error (e.g. mid-loop provider failure the agent may recover from). */
  error?: { message?: string } | string;
}
export interface SdkUserMessage {
  type: "user";
  message?: { content?: SdkContentBlock[] | unknown };
}
export interface SdkResultMessage {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  usage?: SdkUsage;
  duration_ms?: number;
  structured_output?: unknown;
}
export type SdkRunMessage =
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | { type: string };

/** Terminal verdict + authoritative counters, captured from the `result` message. */
export interface SdkTerminal {
  status: NonNullable<RunResult["status"]>;
  error?: RunError;
  usage: TokenUsage;
  cost: number;
  durationMs?: number;
  /** Native structured deliverable (`outputFormat`); `undefined` when none. */
  structuredOutput?: unknown;
}

/** Map SDK error `result.subtype` → a stable {@link RunError.code}. */
function errorCodeForSubtype(subtype: string | undefined): string {
  switch (subtype) {
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
      return "max_budget";
    case "error_max_structured_output_retries":
      return "output_schema_unsatisfied";
    default:
      return "adapter_error";
  }
}

function addUsage(into: TokenUsage, delta: SdkUsage | undefined): void {
  if (!delta) return;
  into.input_tokens = (into.input_tokens ?? 0) + (delta.input_tokens ?? 0);
  into.output_tokens = (into.output_tokens ?? 0) + (delta.output_tokens ?? 0);
  into.cache_creation_input_tokens =
    (into.cache_creation_input_tokens ?? 0) + (delta.cache_creation_input_tokens ?? 0);
  into.cache_read_input_tokens =
    (into.cache_read_input_tokens ?? 0) + (delta.cache_read_input_tokens ?? 0);
}

function asContentBlocks(content: unknown): SdkContentBlock[] {
  return Array.isArray(content) ? (content as SdkContentBlock[]) : [];
}

function assistantErrorMessage(error: SdkAssistantMessage["error"]): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error.length > 0 ? error : undefined;
  return typeof error.message === "string" && error.message.length > 0 ? error.message : undefined;
}

/**
 * Stateful translator. One instance per run; {@link map} is called for each SDK
 * message in arrival order and returns the {@link RunEvent}s to emit. After the
 * `result` message has been mapped, {@link terminal} returns the authoritative
 * verdict + counters for the run's {@link RunResult}.
 */
export class SdkRunEventMapper {
  private readonly liveUsage = zeroTokenUsage();
  private terminalState: SdkTerminal | null = null;
  // Tool-call observation for runtime-tool replay capture: the `tool_use`
  // (name + args) and the matching `tool_result` (success/error) arrive in
  // separate SDK messages, so we hold the args by `tool_use_id` until the
  // result lands, then surface the completed call for the runner to replay.
  private readonly pendingToolInputs = new Map<string, { name: string; input: unknown }>();
  private completedCalls: CompletedToolCall[] = [];

  constructor(
    private readonly runId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Drain the tool calls that completed since the last drain — each with its
   * tool name, the args the model passed, and whether the result errored. The
   * Claude runner filters these to first-party runtime tools and replays the
   * shared pure handler to reconstruct their canonical events (the SDK's HTTP
   * MCP client drops the result `_meta` those events would otherwise ride in).
   */
  drainCompletedToolCalls(): CompletedToolCall[] {
    const calls = this.completedCalls;
    this.completedCalls = [];
    return calls;
  }

  map(msg: SdkRunMessage): RunEvent[] {
    switch (msg.type) {
      case "assistant":
        return this.mapAssistant(msg as SdkAssistantMessage);
      case "user":
        return this.mapUser(msg as SdkUserMessage);
      case "result":
        return this.mapResult(msg as SdkResultMessage);
      default:
        return [];
    }
  }

  /** Authoritative terminal verdict — `null` until a `result` message is mapped. */
  terminal(): SdkTerminal | null {
    return this.terminalState;
  }

  private mapAssistant(msg: SdkAssistantMessage): RunEvent[] {
    const events: RunEvent[] = [];
    const ts = this.now();

    // Per-turn provider error. Logged as a breadcrumb only — it does NOT decide
    // the run's status (the agent may recover on a later turn); the terminal
    // verdict comes from the `result` message. Mirrors the Pi bridge's
    // transient-error logging.
    const errMessage = assistantErrorMessage(msg.error);
    if (errMessage) {
      events.push({
        type: "appstrate.error",
        timestamp: ts,
        runId: this.runId,
        message: errMessage,
      });
    }

    const blocks = asContentBlocks(msg.message?.content);
    const text = blocks
      .filter((b): b is SdkTextBlock => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    if (text) {
      events.push({ type: "appstrate.progress", timestamp: ts, runId: this.runId, message: text });
    }

    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const tool = b as SdkToolUseBlock;
      // Hold (name, args) by id for runtime-tool replay once the result lands.
      if (tool.id !== undefined && tool.name !== undefined) {
        this.pendingToolInputs.set(tool.id, { name: tool.name, input: tool.input });
      }
      events.push({
        type: "appstrate.progress",
        timestamp: ts,
        runId: this.runId,
        message: `Tool: ${tool.name ?? "unknown"}`,
        data: {
          tool: tool.name,
          args: tool.input,
          ...(tool.id !== undefined ? { toolCallId: tool.id } : {}),
        },
      });
    }

    // Accumulate usage and surface a live (usage-only) metric so the UI can
    // stream token counts mid-run. Cost is authoritative only on `result`
    // (the SDK reports `total_cost_usd` once), so we omit it here rather than
    // emit a misleading $0.
    const usage = msg.message?.usage;
    if (usage && ((usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0)) {
      addUsage(this.liveUsage, usage);
      events.push({
        type: "appstrate.metric",
        timestamp: ts,
        runId: this.runId,
        usage: { ...this.liveUsage },
      });
    }
    return events;
  }

  private mapUser(msg: SdkUserMessage): RunEvent[] {
    const events: RunEvent[] = [];
    const ts = this.now();
    for (const b of asContentBlocks(msg.message?.content)) {
      if (b.type !== "tool_result") continue;
      const r = b as SdkToolResultBlock;
      const isError = r.is_error === true;
      // Match the result back to its `tool_use` args and surface the completed
      // call for the runner's runtime-tool replay.
      if (r.tool_use_id !== undefined) {
        const pending = this.pendingToolInputs.get(r.tool_use_id);
        if (pending) {
          this.completedCalls.push({ name: pending.name, input: pending.input, isError });
          this.pendingToolInputs.delete(r.tool_use_id);
        }
      }
      events.push({
        type: "appstrate.progress",
        timestamp: ts,
        runId: this.runId,
        message: isError ? "Tool error" : "Tool result",
        data: {
          result: truncateToolResult(r.content),
          isError,
          ...(r.tool_use_id !== undefined ? { toolCallId: r.tool_use_id } : {}),
        },
      });
    }
    return events;
  }

  private mapResult(msg: SdkResultMessage): RunEvent[] {
    // The SDK reports the FULL cumulative usage on the result — authoritative,
    // overriding the per-turn accumulation (which can miss usage the SDK only
    // settles at the end).
    const usage: TokenUsage = msg.usage
      ? {
          input_tokens: msg.usage.input_tokens ?? 0,
          output_tokens: msg.usage.output_tokens ?? 0,
          cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
        }
      : { ...this.liveUsage };
    const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    const isSuccess = msg.subtype === "success" && msg.is_error !== true;

    this.terminalState = {
      status: isSuccess ? "success" : "failed",
      usage,
      cost,
      ...(typeof msg.duration_ms === "number" ? { durationMs: msg.duration_ms } : {}),
      ...(msg.structured_output !== undefined ? { structuredOutput: msg.structured_output } : {}),
      ...(isSuccess
        ? {}
        : {
            error: {
              code: errorCodeForSubtype(msg.subtype),
              message: terminalErrorMessage(msg),
            },
          }),
    };

    // Final authoritative metric. The runner also stamps usage+cost onto the
    // RunResult at finalize, so this event is purely the live-UI signal.
    return [
      {
        type: "appstrate.metric",
        timestamp: this.now(),
        runId: this.runId,
        usage: { ...usage },
        cost,
      },
    ];
  }
}

/** Human-facing message for a failed `result` — SDK `errors` / `result`, else generic. */
function terminalErrorMessage(msg: SdkResultMessage): string {
  if (Array.isArray(msg.errors) && msg.errors.length > 0) {
    const joined = msg.errors.filter((e) => typeof e === "string" && e.length > 0).join("; ");
    if (joined.length > 0) return joined;
  }
  if (typeof msg.result === "string" && msg.result.trim().length > 0) return msg.result.trim();
  return "The agent's final model turn ended in an error";
}
