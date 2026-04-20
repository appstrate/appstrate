// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { EventSink } from "../interfaces/event-sink.ts";
import type { AfpsEventEnvelope } from "../types/afps-event.ts";
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

  constructor(opts: ConsoleSinkOptions = {}) {
    this.out = opts.out ?? process.stdout;
  }

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    this.out.write(this.formatEvent(envelope) + "\n");
  }

  async finalize(result: RunResult): Promise<void> {
    const summary =
      `▶ run complete — memories=${result.memories.length} logs=${result.logs.length}` +
      (result.output !== null ? " output=set" : "") +
      (result.report !== null ? " report=set" : "") +
      (result.state !== null ? " state=set" : "") +
      (result.error ? ` ERROR=${result.error.message}` : "");
    this.out.write(summary + "\n");
  }

  private formatEvent(envelope: AfpsEventEnvelope): string {
    const { event, sequence } = envelope;
    const seq = `#${sequence.toString().padStart(4, "0")}`;
    switch (event.type) {
      case "add_memory":
        return `${seq} ✚ memory: ${truncate(event.content, 200)}`;
      case "set_state":
        return `${seq} ▲ state: ${truncate(safeStringify(event.state), 200)}`;
      case "output":
        return `${seq} ◆ output: ${truncate(safeStringify(event.data), 200)}`;
      case "report":
        return `${seq} 📝 report: ${truncate(event.content, 200)}`;
      case "log":
        return `${seq} ${logMarker(event.level)} ${event.message}`;
    }
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
