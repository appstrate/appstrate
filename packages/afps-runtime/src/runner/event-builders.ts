// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { RunEvent } from "../types/index.ts";
import type { TokenUsage } from "../types/run-result.ts";

/**
 * Shared constructors for the `appstrate.*` RunEvents the Pi runner emits.
 * The Pi bridge (`runner-pi`) builds envelopes for assistant text, tool
 * start/result, usage metrics, and error breadcrumbs through these builders,
 * keeping the envelope shape in one place rather than inlined at each call
 * site.
 *
 * The runner owns its own input parsing (Pi events); it only hands the
 * extracted fields to these builders. `timestamp` is injected by the caller
 * (the runner uses `Date.now()` or an injectable clock), so this module stays
 * free of ambient time.
 */

interface EventBase {
  runId: string;
  timestamp: number;
}

/** Assistant text (or any lifecycle breadcrumb) as an `appstrate.progress` event. */
export function buildProgress(base: EventBase, message: string): RunEvent {
  return { type: "appstrate.progress", timestamp: base.timestamp, runId: base.runId, message };
}

/** Tool invocation start → `appstrate.progress` carrying `{ tool, args, toolCallId? }`. */
export function buildToolStartProgress(
  base: EventBase,
  input: { tool: string | undefined; args: unknown; toolCallId?: string },
): RunEvent {
  return {
    type: "appstrate.progress",
    timestamp: base.timestamp,
    runId: base.runId,
    message: `Tool: ${input.tool ?? "unknown"}`,
    data: {
      tool: input.tool,
      args: input.args,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    },
  };
}

/**
 * Tool result → `appstrate.progress` carrying `{ tool?, result, isError,
 * toolCallId?, durationMs? }`. `tool` is optional: the Pi SDK reports the tool
 * name on its end event, but a caller that only has a tool-use id can pass no
 * name — and the message then omits the `: <tool>` suffix and the `tool` data
 * field accordingly.
 *
 * `durationMs` is likewise optional and stamped by the caller (which owns the
 * clock and the start/end pairing). Emitting it here saves every operator from
 * self-joining the start row to the result row on `toolCallId` to get a
 * per-tool time breakdown; omitting it when the caller could not pair the two
 * is deliberate — a zero or a name-keyed guess would cross-attribute a
 * parallel batch.
 */
export function buildToolResultProgress(
  base: EventBase,
  input: {
    tool?: string;
    result: unknown;
    isError: boolean;
    toolCallId?: string;
    durationMs?: number;
  },
): RunEvent {
  const label = input.isError ? "Tool error" : "Tool result";
  return {
    type: "appstrate.progress",
    timestamp: base.timestamp,
    runId: base.runId,
    message: input.tool !== undefined ? `${label}: ${input.tool}` : label,
    data: {
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      result: input.result,
      isError: input.isError,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    },
  };
}

/** Token-usage metric. `cost` is omitted mid-run, before it is authoritative. */
export function buildMetric(base: EventBase, usage: TokenUsage, cost?: number): RunEvent {
  return {
    type: "appstrate.metric",
    timestamp: base.timestamp,
    runId: base.runId,
    usage,
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * `run_logs` event name carried in each turn breadcrumb's `data`, so context
 * growth is queryable without a second reporting path
 * (`SELECT data->>'contextTokens' FROM run_logs WHERE data->>'event' = 'turn'`).
 * Mirrors the `output_reprompt` / `deadline_nudge` discriminators in
 * `runner-pi`.
 */
export const TURN_PROGRESS_EVENT = "turn";

/**
 * One settled assistant turn → `appstrate.progress` carrying that turn's OWN
 * usage deltas. `appstrate.metric` only ever carries running totals and writes
 * no `run_logs` row, so a run's cost curve — the thing that makes a 100-turn
 * run expensive — is unreadable after the fact. Deltas, not totals: a growth
 * curve is what an author needs, and totals force the reader to difference
 * consecutive rows themselves.
 *
 * `contextTokens` is the prompt the provider actually saw for this turn:
 * `inputTokens + cacheReadTokens + cacheWriteTokens`. It deliberately EXCLUDES
 * `outputTokens` — output is generated, not re-read, and folding it in would
 * hide the re-read cost this metric exists to expose.
 *
 * Field casing is camelCase throughout, per the CloudEvents carve-out
 * (`docs/CASING_CONVENTIONS.md` §4i) that already governs `durationMs` /
 * `toolCallId` on this envelope. The snake_case counters on {@link TokenUsage}
 * are a different contract (the `usage` member of `appstrate.metric`, mirroring
 * the `runs.tokenUsage` JSONB shape) and are not reused here.
 */
export function buildTurnProgress(
  base: EventBase,
  input: {
    /** 1-based index of this settled assistant turn within the run. */
    index: number;
    /**
     * Wall time of the turn. Omitted when the runner could not observe the
     * turn's start — a zero would read as an instant turn.
     */
    latencyMs?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): RunEvent {
  const contextTokens = input.inputTokens + input.cacheReadTokens + input.cacheWriteTokens;
  return {
    type: "appstrate.progress",
    timestamp: base.timestamp,
    runId: base.runId,
    message: `Turn ${input.index} — ${contextTokens} context tokens, ${input.outputTokens} generated`,
    data: {
      event: TURN_PROGRESS_EVENT,
      index: input.index,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      contextTokens,
    },
  };
}

/** Terminal or per-turn error breadcrumb. */
export function buildError(base: EventBase, message: string): RunEvent {
  return { type: "appstrate.error", timestamp: base.timestamp, runId: base.runId, message };
}
