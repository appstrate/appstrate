// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "@afps-spec/types";
import { narrowCanonicalEvent } from "../types/canonical-events.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Print events live to a writable stream. Default target is
 * `process.stdout`. Intended for local dev and CLI debugging — not a
 * replacement for structured sinks (`FileSink`, `HttpSink`).
 *
 * Output format is one human-readable line per event, newline-terminated.
 * The shape is not a stable contract and may change between versions.
 */
export interface ConsoleSinkOptions {
  /**
   * Writable with a `write(chunk: string): void` method. Defaults to
   * `process.stdout`. Tests inject a buffer to capture output without
   * touching real stdout.
   */
  out?: ConsoleWritable;
}

export interface ConsoleWritable {
  write(chunk: string): unknown;
}

export class ConsoleSink implements EventSink {
  private readonly out: ConsoleWritable;
  private sequence = 0;

  constructor(opts: ConsoleSinkOptions = {}) {
    this.out = opts.out ?? process.stdout;
  }

  async handle(event: RunEvent): Promise<void> {
    this.sequence += 1;
    this.out.write(this.formatEvent(event, this.sequence) + "\n");
  }

  async finalize(result: RunResult): Promise<void> {
    const summary =
      `▶ run complete — memories=${result.memories.length} logs=${result.logs.length}` +
      (result.output !== null ? " output=set" : "") +
      (result.pinned?.checkpoint !== undefined ? " checkpoint=set" : "") +
      (result.error ? ` ERROR=${result.error.message}` : "");
    this.out.write(summary + "\n");
  }

  private formatEvent(event: RunEvent, sequence: number): string {
    const seq = `#${sequence.toString().padStart(4, "0")}`;
    const canonical = narrowCanonicalEvent(event);
    if (canonical !== null) {
      switch (canonical.type) {
        case "memory.added": {
          const scopeTag = canonical.scope ? ` [${canonical.scope}]` : "";
          return `${seq} ✚ memory${scopeTag}: ${truncate(canonical.content, 200)}`;
        }
        case "pinned.set": {
          const scopeTag = canonical.scope ? ` [${canonical.scope}]` : "";
          return `${seq} ▲ pinned[${canonical.key}]${scopeTag}: ${truncate(safeStringify(canonical.content), 200)}`;
        }
        case "output.emitted":
          return `${seq} ◆ output: ${truncate(safeStringify(canonical.data), 200)}`;
        case "log.written":
          return `${seq} ${logMarker(canonical.level)} ${canonical.message}`;
        case "appstrate.progress":
          return `${seq} → ${canonical.message}`;
        case "appstrate.error":
          return `${seq} ✗ ${canonical.message}`;
        case "appstrate.metric": {
          const summary = {
            ...(canonical.usage !== undefined ? { usage: canonical.usage } : {}),
            ...(canonical.cost !== undefined ? { cost: canonical.cost } : {}),
            ...(canonical.durationMs !== undefined ? { durationMs: canonical.durationMs } : {}),
          };
          return `${seq} ⊘ metric: ${truncate(safeStringify(summary), 200)}`;
        }
        case "run.started":
          return `${seq} ▶ run.started${canonical.runnerKind ? ` (${canonical.runnerKind})` : ""}`;
        case "run.success":
          return `${seq} ✓ run.success`;
        case "run.failed":
          return `${seq} ✗ run.failed${canonical.error ? `: ${canonical.error.message}` : ""}`;
        case "run.timeout":
          return `${seq} ⏱ run.timeout`;
        case "run.cancelled":
          return `${seq} ⊘ run.cancelled${canonical.reason ? ` (${canonical.reason})` : ""}`;
        default: {
          const _exhaustive: never = canonical;
          void _exhaustive;
          break;
        }
      }
    }
    return `${seq} • ${event.type}: ${truncate(safeStringify(eventPayload(event)), 200)}`;
  }
}

function logMarker(level: "info" | "warn" | "error"): string {
  switch (level) {
    case "info":
      return "ℹ";
    case "warn":
      return "⚠";
    case "error":
      return "✗";
    default: {
      const _exhaustive: never = level;
      void _exhaustive;
      return "·";
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

const ENVELOPE_KEYS = new Set<string>(["type", "timestamp", "runId", "toolCallId"]);

function eventPayload(event: RunEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}
