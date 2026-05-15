// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Stdout-JSONL → EventSink bridge.
 *
 * Two separate event streams feed an in-process AFPS runner:
 *
 *   1. Runner-emitted events (e.g. PiRunner's session bridge — tool
 *      starts, assistant messages, metrics) handed straight to the
 *      configured {@link EventSink}.
 *   2. System tools (`@appstrate/note`, `@appstrate/output`,
 *      `@appstrate/pin`, `@appstrate/log`, `@appstrate/report`)
 *      emit canonical domain events via `process.stdout.write(JSON+\n)`
 *      — the legacy stdout-JSONL protocol baked into every system tool
 *      ZIP. Without a bridge, those events never reach the configured
 *      sink: they only show up as raw JSON noise on stdout.
 *
 * This module:
 *
 *   - Wraps the underlying sink into a forwarder that folds every event
 *     into an in-memory {@link RunResult} aggregate while still
 *     delivering the event downstream.
 *   - Installs a stdout interceptor that parses JSON lines, validates
 *     them against the canonical event vocabulary, feeds matches through
 *     the forwarder, and passes everything else (logs, raw text, foreign
 *     JSON from subprocesses) through to the original stream so
 *     `console.log` debug output keeps reaching the terminal.
 *   - On `finalize(result)`, merges runner-side terminal metadata
 *     (`status` / `error` / `durationMs` / `usage` / `cost`) with the
 *     bridge's aggregate so the single finalize call carries the
 *     complete shape — `result.output`, `result.pinned`, and
 *     `result.memories` would otherwise be empty for any runner whose
 *     internal reducer only sees session events (PiRunner is the
 *     canonical case).
 *
 * Two correctness properties to keep in mind:
 *
 *   - **Strict matcher.** {@link isStdoutEventLine} only accepts JSON
 *     objects whose `type` is in the canonical event vocabulary AND
 *     whose payload satisfies the canonical shape. A subprocess
 *     printing `{ "type": "build.done" }` is left untouched.
 *   - **`writeRaw` escape hatch.** Sinks downstream of the bridge that
 *     re-emit canonical events on stdout (e.g. a CLI's `--json` mode
 *     that JSON-stringifies every received event) MUST route those
 *     writes through {@link StdoutBridgeHandle.writeRaw}; otherwise
 *     they would be re-parsed and re-dispatched, creating a feedback
 *     loop and event duplication.
 *
 * Exported as a pure function so unit tests can exercise aggregation,
 * stdout parsing, and merge semantics without booting any runner.
 */

import type { RunEvent } from "@afps-spec/types";
import type { EventSink } from "../interfaces/event-sink.ts";
import { emptyRunResult, foldEvent } from "../runner/reducer.ts";
import type { RunResult } from "../types/run-result.ts";
import { isCanonicalRunEvent } from "../types/canonical-events.ts";

export interface StdoutBridgeOptions {
  /** Underlying sink — typically composed (console + HTTP) by the caller. */
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

export interface StdoutBridgeHandle {
  /** Sink to hand to the runner. Folds + forwards every event. */
  readonly sink: EventSink;
  /**
   * Snapshot of the bridge's current aggregate. Mutates as events
   * arrive — read-only by convention, exposed for tests and for callers
   * who need to inspect partial state before finalize.
   */
  readonly aggregate: RunResult;
  /**
   * Write directly to the original (pre-hook) stdout, bypassing the
   * JSONL interceptor. The sole legitimate use is for downstream sinks
   * that re-emit canonical RunEvents on stdout (`--json` mode of a
   * console sink, machine-readable pipes, …) — without this escape
   * hatch their writes would be re-aspirated and dispatched a second
   * time, duplicating every event.
   */
  writeRaw(chunk: string | Uint8Array): boolean;
  /** Restore original stdout + clear the parser's line buffer. */
  restore(): void;
}

/**
 * True when the JSON-parsed value is a structurally valid canonical
 * RunEvent, eligible to be folded into the aggregate and forwarded to
 * the sink. Strict on purpose:
 *
 *   - Type must be in the canonical vocabulary
 *     (cf. `CANONICAL_EVENT_TYPES`). This rules out arbitrary
 *     subprocess JSON output (`npm --json`, `jq`, …) that happens to
 *     have a `type` field.
 *   - Payload must satisfy {@link isCanonicalRunEvent}'s structural
 *     check for that type. A canonical type with a malformed payload
 *     (`{type:"output.emitted"}` with no `data`) is rejected so it
 *     falls through to the original-stdout passthrough instead of
 *     poisoning the aggregate.
 */
export function isStdoutEventLine(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string") return false;
  // `isCanonicalRunEvent` operates on a `RunEvent` (which requires
  // `timestamp`/`runId` envelope fields); we only inspect `event.type`
  // and the type-specific payload fields, so the cast is safe — the
  // bridge re-stamps `runId` and a missing `timestamp` is already
  // tolerated by every canonical case.
  return isCanonicalRunEvent(candidate as unknown as RunEvent);
}

/**
 * Merge runner-emitted terminal metadata with a separately-aggregated
 * {@link RunResult}.
 *
 *   - Per-event aggregates (memories / pinned / output / logs) take the
 *     bridge's value when non-empty, otherwise fall back to the
 *     runner's. Lets a runner that already produced a complete result
 *     (anything that doesn't go through stdout-JSONL tools) pass through
 *     unchanged.
 *   - Terminal metadata (status / error / durationMs / usage / cost)
 *     comes from the runner exclusively — the bridge only sees AFPS
 *     domain events, never `appstrate.metric`-derived totals or the
 *     terminal status that the runner determines.
 */
export function mergeTerminalResult(aggregate: RunResult, runnerResult: RunResult): RunResult {
  const pinned =
    aggregate.pinned !== undefined && Object.keys(aggregate.pinned).length > 0
      ? aggregate.pinned
      : runnerResult.pinned;
  return {
    memories: aggregate.memories.length > 0 ? aggregate.memories : runnerResult.memories,
    ...(pinned !== undefined ? { pinned } : {}),
    output: aggregate.output ?? runnerResult.output,
    logs: aggregate.logs.length > 0 ? aggregate.logs : runnerResult.logs,
    // Append-only markdown report — bridge aggregate wins when set, else
    // fall back to whatever the runner produced (may also be undefined).
    ...(aggregate.report !== undefined
      ? { report: aggregate.report }
      : runnerResult.report !== undefined
        ? { report: runnerResult.report }
        : {}),
    ...(runnerResult.status !== undefined ? { status: runnerResult.status } : {}),
    ...(runnerResult.error !== undefined ? { error: runnerResult.error } : {}),
    ...(runnerResult.durationMs !== undefined ? { durationMs: runnerResult.durationMs } : {}),
    ...(runnerResult.usage !== undefined ? { usage: runnerResult.usage } : {}),
    ...(runnerResult.cost !== undefined ? { cost: runnerResult.cost } : {}),
  };
}

/**
 * Attach the bridge: install the stdout interceptor and return a sink
 * that the runner consumes. Call {@link StdoutBridgeHandle.restore}
 * during teardown (mandatory for tests; production processes typically
 * exit immediately after finalize and don't need it).
 */
export function attachStdoutBridge(opts: StdoutBridgeOptions): StdoutBridgeHandle {
  const stdout = opts.stdout ?? process.stdout;
  const originalWrite = stdout.write.bind(stdout);

  const aggregate: RunResult = emptyRunResult();
  let finalizeCalled = false;
  let partial = "";

  // Fire-and-forget POSTs kicked off by `dispatchLine` — the
  // monkey-patched `process.stdout.write` is synchronous and cannot
  // await `sink.handle(event)`, so each dispatch is tracked here and
  // drained by `finalize` before forwarding to the underlying sink.
  // Otherwise the server CAS-closes the sink and a late POST gets a
  // 410 the catch swallows.
  const pendingDispatches = new Set<Promise<void>>();

  const sink: EventSink = {
    async handle(event) {
      if (isStdoutEventLine(event)) foldEvent(aggregate, event);
      await opts.sink.handle(event);
    },
    async finalize(result) {
      // One-shot terminal: protects against runner + safety-net
      // double-finalize races (the platform-side ingestion is also
      // CAS-guarded, but we don't want to send the same payload twice).
      if (finalizeCalled) return;
      finalizeCalled = true;
      if (pendingDispatches.size > 0) {
        await Promise.allSettled([...pendingDispatches]);
      }
      await opts.sink.finalize(mergeTerminalResult(aggregate, result));
    },
  };

  function dispatchLine(line: string): boolean {
    if (line.length === 0) return false;
    const trimmed = line.trimStart();
    // Cheap reject for non-JSON lines — avoids a parse attempt on every
    // `console.log("hello")` the agent might emit.
    if (!trimmed.startsWith("{")) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!isStdoutEventLine(parsed)) return false;
    // Override `runId` with the bridge-configured value: the legacy
    // stdout-JSONL protocol stamps `runId` from `process.env.AGENT_RUN_ID`
    // which may be absent or stale (e.g. a CLI that didn't set the env
    // var). The bridge owns the canonical run identity here.
    const event: RunEvent = { ...(parsed as RunEvent), runId: opts.runId };
    const promise: Promise<void> = sink.handle(event).catch(() => {});
    pendingDispatches.add(promise);
    promise.finally(() => pendingDispatches.delete(promise));
    return true;
  }

  // Stdout's `write` is overloaded across runtimes (Node `Buffer`, Bun
  // `Uint8Array`, plain `string`). We type the chunk as the widest
  // accepted shape and decode bytes via `TextDecoder` — which handles
  // both `Uint8Array` and Node's `Buffer` (a subclass of `Uint8Array`).
  //
  // `{ stream: true }` is load-bearing: a multi-byte UTF-8 character
  // split across two chunk boundaries (e.g. `é` = 0xC3 0xA9 split into
  // chunk-A=[…0xC3] and chunk-B=[0xA9…]) would otherwise be replaced
  // with U+FFFD on each call. With streaming, partial sequences are
  // stashed across calls and join correctly. The line-level partial
  // buffer below handles split JSON envelopes; this handles split UTF-8.
  const decoder = new TextDecoder("utf-8", { fatal: false });

  stdout.write = ((chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
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
    writeRaw(chunk: string | Uint8Array): boolean {
      return (originalWrite as (...a: unknown[]) => boolean)(chunk);
    },
    restore() {
      stdout.write = originalWrite as typeof stdout.write;
      partial = "";
    },
  };
}
