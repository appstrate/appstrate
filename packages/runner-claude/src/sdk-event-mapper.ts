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
 *   - runtime-tool events are journaled by the sidecar (single execution) and
 *     drained by the runner on its sink — the SDK's HTTP MCP client drops the
 *     result `_meta` those events would otherwise ride in (spike `META_DROPPED`),
 *   - the terminal status/usage/cost is captured from the `result` message via
 *     {@link SdkRunEventMapper.terminal}.
 *
 * Structural SDK types are declared locally (not imported from the SDK) so the
 * mapper is unit-testable on hand-built fixtures and resilient to non-breaking
 * SDK shape additions.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import {
  buildError,
  buildMetric,
  buildProgress,
  buildToolResultProgress,
  buildToolStartProgress,
  truncateToolResult,
  zeroTokenUsage,
  type RunError,
  type RunResult,
  type TokenUsage,
} from "@appstrate/afps-runtime/runner";
import { accumulateTokenUsage } from "@appstrate/core/token-usage";
import { parseToolResultBlocks } from "./claude-blocks.ts";

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
// `tool_result` blocks (on `user` messages) are parsed via the shared
// `parseToolResultBlocks`; this union covers only the `assistant` blocks
// `mapAssistant` walks.
type SdkContentBlock = SdkTextBlock | SdkToolUseBlock | { type: string };

// Anthropic usage counters are already snake_case and structurally identical
// to the canonical {@link TokenUsage}, so the SDK `usage` field is typed as
// `TokenUsage` directly — no parallel `SdkUsage` shape to keep in sync.

export interface SdkAssistantMessage {
  type: "assistant";
  message?: { content?: SdkContentBlock[] | unknown; usage?: TokenUsage };
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
  usage?: TokenUsage;
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
  private lastText: string | null = null;

  constructor(
    private readonly runId: string,
    private readonly now: () => number = Date.now,
  ) {}

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

  /**
   * Snapshot of usage accumulated from assistant turns SO FAR. Used to stamp a
   * best-effort usage figure on a run that FAILED before the SDK emitted its
   * authoritative `result` message (a thrown stream or a stream that ended
   * without a result) — so the tokens already spent are still billed/recorded
   * instead of being lost as zero.
   */
  liveUsageSnapshot(): TokenUsage {
    return { ...this.liveUsage };
  }

  /**
   * Last non-empty assistant text seen on the stream — the run's final
   * message once the stream has ended. Fallback source for the structured
   * deliverable when the SDK's `result.structured_output` is absent (the
   * model wrote the JSON as text instead of calling `StructuredOutput`,
   * issue #833). `null` until an assistant turn produces text.
   */
  lastAssistantText(): string | null {
    return this.lastText;
  }

  private mapAssistant(msg: SdkAssistantMessage): RunEvent[] {
    const events: RunEvent[] = [];
    const base = { runId: this.runId, timestamp: this.now() };

    // Per-turn provider error. Logged as a breadcrumb only — it does NOT decide
    // the run's status (the agent may recover on a later turn); the terminal
    // verdict comes from the `result` message. Mirrors the Pi bridge's
    // transient-error logging.
    const errMessage = assistantErrorMessage(msg.error);
    if (errMessage) events.push(buildError(base, errMessage));

    const blocks = asContentBlocks(msg.message?.content);
    const text = blocks
      .filter((b): b is SdkTextBlock => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    if (text) {
      this.lastText = text;
      events.push(buildProgress(base, text));
    }

    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const tool = b as SdkToolUseBlock;
      events.push(
        buildToolStartProgress(base, {
          tool: tool.name,
          args: tool.input,
          ...(tool.id !== undefined ? { toolCallId: tool.id } : {}),
        }),
      );
    }

    // Accumulate usage and surface a live (usage-only) metric so the UI can
    // stream token counts mid-run. Cost is authoritative only on `result`
    // (the SDK reports `total_cost_usd` once), so we omit it here rather than
    // emit a misleading $0.
    const usage = msg.message?.usage;
    if (usage && ((usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0)) {
      accumulateTokenUsage(this.liveUsage, usage);
      events.push(buildMetric(base, { ...this.liveUsage }));
    }
    return events;
  }

  private mapUser(msg: SdkUserMessage): RunEvent[] {
    const base = { runId: this.runId, timestamp: this.now() };
    // No tool name: an Anthropic `tool_result` references only the `tool_use`
    // id, so the shared builder omits the `: <tool>` suffix and `data.tool`.
    return parseToolResultBlocks(msg.message?.content).map(
      (r): RunEvent =>
        buildToolResultProgress(base, {
          result: truncateToolResult(r.content),
          isError: r.isError,
          ...(r.toolUseId !== undefined ? { toolCallId: r.toolUseId } : {}),
        }),
    );
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

    const events: RunEvent[] = [];

    // Terminal-failure breadcrumb. A FAILED result (error_max_turns /
    // error_max_budget_usd / output-schema unsatisfied / generic) records the
    // failure into terminalState above but, without this, would emit NO
    // `appstrate.error` RunEvent — leaving the event stream / run_logs silent on
    // why the run failed. The Codex sibling emits one on its turn.failed / non-
    // zero-exit branches, and the Claude per-turn assistant-error path emits one
    // too; mirror that shape here so the breadcrumb is consistent across runners.
    // This does NOT change the terminal status (decided above) — it only adds the
    // missing error event.
    if (!isSuccess) {
      events.push(
        buildError({ runId: this.runId, timestamp: this.now() }, terminalErrorMessage(msg)),
      );
    }

    // Final authoritative metric. The runner also stamps usage+cost onto the
    // RunResult at finalize, so this event is purely the live-UI signal.
    events.push(buildMetric({ runId: this.runId, timestamp: this.now() }, { ...usage }, cost));
    return events;
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
