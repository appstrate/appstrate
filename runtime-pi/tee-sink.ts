// SPDX-License-Identifier: Apache-2.0

/**
 * Tee sink + stdout bridge used by `runtime-pi/entrypoint.ts`.
 *
 * Two separate event streams feed the in-container runtime:
 *
 *   1. PiRunner's session bridge — emits Pi SDK lifecycle events (tool
 *      starts, assistant messages, metrics) to `eventSink.handle`.
 *   2. System tools (`@appstrate/report`, `@appstrate/add-memory`,
 *      `@appstrate/output`, `@appstrate/set-state`, `@appstrate/log`)
 *      emit canonical domain events via `process.stdout.write(JSON+\n)`
 *      — the legacy stdout-JSONL protocol.
 *
 * Under the unified HttpSink protocol neither channel is consumed by
 * the platform directly, so this module:
 *
 *   - Wraps the underlying sink into a "tee" that folds every event
 *     into an in-memory {@link RunResult} aggregator while still
 *     forwarding the event downstream.
 *   - Installs a stdout interceptor that parses JSON lines, feeds valid
 *     events through the tee, and passes non-JSON writes through to the
 *     original stream (so `console.log` debug output still reaches
 *     container logs).
 *   - On `finalize(result)`, merges PiRunner's terminal metadata
 *     (`status` / `error` / `durationMs`) with the tee's aggregate so
 *     the single finalize POST carries the complete shape. Without the
 *     merge, `result.report` / `result.output` / `result.state` /
 *     `result.memories` would be empty — PiRunner's internal reducer
 *     only sees session events, not tool-stdout events.
 *
 * Exported as a pure function so unit tests can exercise aggregation,
 * stdout parsing, and merge semantics without booting the whole runtime.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import { emptyRunResult, foldEvent, type RunResult } from "@appstrate/afps-runtime/runner";

export interface TeeSinkOptions {
  /** Underlying sink — typically {@link HttpSink} wired to the platform. */
  sink: EventSink;
  /** Run identifier — stamped onto every stdout-dispatched event. */
  runId: string;
  /**
   * Stdout stream to intercept. Pass a mutable `{ write }` shape so tests
   * can install the bridge against a fake stream. Defaults to
   * `process.stdout`.
   */
  stdout?: { write: NodeJS.WritableStream["write"] };
}

export interface TeeSinkHandle {
  /** Sink to hand to PiRunner / providers. Folds + forwards every event. */
  readonly sink: EventSink;
  /** Restore original stdout + flush the parser's line buffer. */
  restore(): void;
  /** Read-only accessor for tests — current aggregated result. */
  readonly aggregate: RunResult;
}

export function looksLikeRunEvent(value: unknown): value is RunEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Merge PiRunner's terminal metadata with a separately-aggregated
 * {@link RunResult}. Status/error/durationMs come from the runner;
 * per-event aggregates (output/report/state/memories/logs) come from
 * the aggregate. Fields on the aggregate take precedence only when
 * non-empty, so a runner that already produced the full result (CLI
 * case) keeps its values when the aggregate is untouched.
 */
export function mergeTerminalResult(aggregate: RunResult, runnerResult: RunResult): RunResult {
  return {
    memories: aggregate.memories.length > 0 ? aggregate.memories : runnerResult.memories,
    state: aggregate.state ?? runnerResult.state,
    output: aggregate.output ?? runnerResult.output,
    report: aggregate.report ?? runnerResult.report,
    logs: aggregate.logs.length > 0 ? aggregate.logs : runnerResult.logs,
    ...(runnerResult.status !== undefined ? { status: runnerResult.status } : {}),
    ...(runnerResult.error !== undefined ? { error: runnerResult.error } : {}),
    ...(runnerResult.durationMs !== undefined ? { durationMs: runnerResult.durationMs } : {}),
  };
}

/**
 * Attach the tee sink + install the stdout bridge. The returned
 * {@link TeeSinkHandle.sink} is the one to pass into PiRunner. Call
 * {@link TeeSinkHandle.restore} during teardown (tests) — production
 * processes don't need to restore, they exit immediately after finalize.
 */
export function attachTeeSink(opts: TeeSinkOptions): TeeSinkHandle {
  const stdout = opts.stdout ?? process.stdout;
  const originalWrite = stdout.write.bind(stdout);

  const aggregate: RunResult = emptyRunResult();
  let finalizeCalled = false;
  let partial = "";

  const sink: EventSink = {
    async handle(event) {
      if (looksLikeRunEvent(event)) foldEvent(aggregate, event);
      await opts.sink.handle(event);
    },
    async finalize(result) {
      if (finalizeCalled) return;
      finalizeCalled = true;
      await opts.sink.finalize(mergeTerminalResult(aggregate, result));
    },
  };

  function dispatchLine(line: string): boolean {
    if (line.length === 0) return false;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{")) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!looksLikeRunEvent(parsed)) return false;
    const event: RunEvent = { ...(parsed as RunEvent), runId: opts.runId };
    // Fire-and-forget — the underlying sink handles its own retries.
    void sink.handle(event).catch(() => {});
    return true;
  }

  type StdoutChunk = Parameters<typeof stdout.write>[0];

  stdout.write = ((chunk: StdoutChunk, ..._rest: unknown[]): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
    partial += text;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!dispatchLine(line) && line.length > 0) {
        (originalWrite as (...a: unknown[]) => boolean)(line + "\n");
      }
    }
    return true;
  }) as typeof stdout.write;

  return {
    sink,
    aggregate,
    restore() {
      stdout.write = originalWrite as typeof stdout.write;
      partial = "";
    },
  };
}
