// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Translate the Codex CLI's `--json` event stream into the canonical AFPS
 * {@link RunEvent} stream the platform already consumes from the Pi and Claude
 * runners — the runner-side counterpart of the chat's codex `ui-stream-mapper.ts`.
 *
 * Like the Claude `SdkRunEventMapper`, this is message-grained, not
 * token-grained: each `item.completed` already carries the whole text, so we
 * emit one `appstrate.progress` per item rather than streaming deltas. The chat
 * mapper targets the AI-SDK UI message stream (a live transcript); a *run* is
 * autonomous and fire-and-forget, so this emits `appstrate.progress` /
 * `appstrate.metric` / `appstrate.error` only.
 *
 * The terminal verdict is NOT decided here. Codex `exec` ends a turn with
 * `turn.completed` (carrying the authoritative usage) and ends the process by
 * closing stdout — there is no explicit "success" result message. So this
 * mapper accumulates usage and records any `turn.failed` / `error`, and the
 * RUNNER decides the status from the process exit code + {@link failure}
 * (mirrors how the Claude runner reads its `result` message, adapted to the
 * CLI's stream shape).
 *
 * Codex usage shape (`turn.completed.usage`, codex-cli 0.141):
 *   { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
 * `output_tokens` already includes reasoning tokens, so we do NOT add
 * `reasoning_output_tokens` again (it would double-count). `cached_input_tokens`
 * maps onto the cache-read counter.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import {
  truncateToolResult,
  zeroTokenUsage,
  type RunError,
  type TokenUsage,
} from "@appstrate/afps-runtime/runner";
import type { CodexEvent, CodexUsage } from "@appstrate/core/codex-binary";

/** Per-token cost rates for the resolved model (USD per 1e6 tokens). */
export interface CodexModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Compute equivalent cost (USD) from usage + the model's per-million rates. */
export function computeCodexCost(
  usage: TokenUsage,
  cost: CodexModelCost | null | undefined,
): number {
  if (!cost) return 0;
  const perMillion = 1_000_000;
  const inputCost = ((usage.input_tokens ?? 0) * cost.input) / perMillion;
  const outputCost = ((usage.output_tokens ?? 0) * cost.output) / perMillion;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) * (cost.cacheRead ?? 0)) / perMillion;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) * (cost.cacheWrite ?? 0)) / perMillion;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

function errorText(ev: CodexEvent): string {
  if (typeof ev.error === "string" && ev.error.length > 0) return ev.error;
  if (ev.error && typeof ev.error === "object" && typeof ev.error.message === "string") {
    return ev.error.message;
  }
  if (typeof ev.message === "string" && ev.message.length > 0) return ev.message;
  return "The Codex CLI reported an error";
}

/**
 * Stateful translator. One instance per run; {@link map} is called for each
 * Codex NDJSON event in arrival order and returns the {@link RunEvent}s to emit.
 */
export class CodexRunEventMapper {
  private readonly liveUsage = zeroTokenUsage();
  private failureState: RunError | null = null;

  constructor(
    private readonly runId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Authoritative cumulative usage (latest `turn.completed`). */
  usage(): TokenUsage {
    return { ...this.liveUsage };
  }

  /** A terminal failure recorded from `turn.failed` / `error`, else null. */
  failure(): RunError | null {
    return this.failureState;
  }

  map(ev: CodexEvent): RunEvent[] {
    switch (ev.type) {
      case "item.completed":
        return this.mapItem(ev.item);
      case "turn.completed":
        return this.mapTurnCompleted(ev.usage);
      case "turn.failed":
      case "error":
        return this.mapFailure(ev);
      default:
        // thread.started / turn.started / *.delta / … — no run-level signal.
        return [];
    }
  }

  private mapItem(item: CodexEvent["item"]): RunEvent[] {
    if (!item) return [];
    const ts = this.now();
    const text = typeof item.text === "string" ? item.text.trim() : "";

    switch (item.type) {
      case "agent_message":
      case "assistant_message":
        return text
          ? [{ type: "appstrate.progress", timestamp: ts, runId: this.runId, message: text }]
          : [];
      case "reasoning":
        // Surface the model's reasoning as a breadcrumb (tagged so the UI can
        // style it differently from the answer).
        return text
          ? [
              {
                type: "appstrate.progress",
                timestamp: ts,
                runId: this.runId,
                message: text,
                data: { reasoning: true },
              },
            ]
          : [];
      case "command_execution": {
        const command = typeof item.command === "string" ? item.command : undefined;
        return [
          {
            type: "appstrate.progress",
            timestamp: ts,
            runId: this.runId,
            message: command ? `Shell: ${command}` : "Shell command",
            data: { tool: "shell", ...(command ? { command } : {}) },
          },
        ];
      }
      case "file_change":
        return [
          {
            type: "appstrate.progress",
            timestamp: ts,
            runId: this.runId,
            message: "File change",
            data: { tool: "edit", result: truncateToolResult(item.text) },
          },
        ];
      case "mcp_tool_call": {
        const name = typeof item.name === "string" ? item.name : "mcp tool";
        return [
          {
            type: "appstrate.progress",
            timestamp: ts,
            runId: this.runId,
            message: `Tool: ${name}`,
            data: { tool: name },
          },
        ];
      }
      default:
        // web_search / todo_list / other surfaces — not run-level signal.
        return [];
    }
  }

  private mapTurnCompleted(usage: CodexUsage | undefined): RunEvent[] {
    if (usage) {
      // The CLI reports cumulative usage per turn; the latest is authoritative.
      this.liveUsage.input_tokens = usage.input_tokens ?? 0;
      this.liveUsage.output_tokens = usage.output_tokens ?? 0;
      this.liveUsage.cache_read_input_tokens = usage.cached_input_tokens ?? 0;
      this.liveUsage.cache_creation_input_tokens = 0;
    }
    return [
      {
        type: "appstrate.metric",
        timestamp: this.now(),
        runId: this.runId,
        usage: { ...this.liveUsage },
      },
    ];
  }

  private mapFailure(ev: CodexEvent): RunEvent[] {
    const message = errorText(ev);
    this.failureState = { code: "adapter_error", message };
    return [{ type: "appstrate.error", timestamp: this.now(), runId: this.runId, message }];
  }
}
