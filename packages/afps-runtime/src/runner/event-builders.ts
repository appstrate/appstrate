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
 * toolCallId? }`. `tool` is optional: the Pi SDK reports the tool name on its
 * end event, but a caller that only has a tool-use id can pass no name — and
 * the message then omits the `: <tool>` suffix and the `tool` data field
 * accordingly.
 */
export function buildToolResultProgress(
  base: EventBase,
  input: { tool?: string; result: unknown; isError: boolean; toolCallId?: string },
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

/** Terminal or per-turn error breadcrumb. */
export function buildError(base: EventBase, message: string): RunEvent {
  return { type: "appstrate.error", timestamp: base.timestamp, runId: base.runId, message };
}
