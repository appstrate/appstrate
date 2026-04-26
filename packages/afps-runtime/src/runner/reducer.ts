// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * RunEvent → RunResult reducer.
 *
 * Consumes {@link RunEvent}s whose `type` is one of the reserved core
 * domains (`memory.added` / `pinned.set` / `output.emitted` /
 * `report.appended` / `log.written`). Events with any other `type` are
 * passed through silently — the sink still sees them, but they do not
 * contribute to the aggregated result.
 *
 * `foldEvent` is the single switch that knows how each canonical event
 * contributes to the aggregate. Both the batch reducer `reduceEvents`
 * and the incremental `createReducerSink` consume it.
 */

import type { RunEvent } from "@afps-spec/types";
import { narrowCanonicalEvent } from "../types/canonical-events.ts";
import type { RunError, RunResult } from "../types/run-result.ts";

export interface ReduceOptions {
  /** Optional error to attach after reduction (populated by the runner). */
  error?: RunError;
}

export function emptyRunResult(): RunResult {
  return {
    memories: [],
    output: null,
    report: null,
    logs: [],
  };
}

/**
 * Fold a single event into a mutable result accumulator. Consumers that
 * want an immutable pipeline can seed a fresh accumulator per call.
 *
 * Open-envelope `RunEvent`s flow in; the canonical narrower projects
 * the five reserved namespaces (memory / pinned / output / report / log)
 * + the runner-internal `appstrate.*` namespace into a discriminated
 * union, so the switch is exhaustively typed. Third-party / unknown
 * events are silently passed through — the sink still sees them, they
 * just do not contribute to the aggregated result.
 */
export function foldEvent(result: RunResult, event: RunEvent): void {
  const canonical = narrowCanonicalEvent(event);
  if (canonical === null) return;

  switch (canonical.type) {
    case "memory.added":
      result.memories.push({
        content: canonical.content,
        ...(canonical.scope !== undefined ? { scope: canonical.scope } : {}),
      });
      return;
    case "pinned.set": {
      if (result.pinned === undefined) result.pinned = {};
      const slot: { content: unknown; scope?: "actor" | "shared" } = {
        content: canonical.content ?? null,
      };
      if (canonical.scope !== undefined) slot.scope = canonical.scope;
      result.pinned[canonical.key] = slot;
      return;
    }
    case "output.emitted":
      result.output = canonical.data ?? null;
      return;
    case "report.appended":
      result.report =
        result.report === null ? canonical.content : `${result.report}\n${canonical.content}`;
      return;
    case "log.written":
      result.logs.push({
        level: canonical.level,
        message: canonical.message,
        timestamp: canonical.timestamp,
      });
      return;
    case "appstrate.progress":
    case "appstrate.error":
    case "appstrate.metric":
    case "run.started":
    case "run.success":
    case "run.failed":
    case "run.timeout":
    case "run.cancelled":
      // Runner-internal lifecycle / canonical run events — do not
      // contribute to the aggregated result. Terminal status comes from
      // `RunResult.status` set on `EventSink.finalize`. Listed here so
      // adding a new variant is caught by the exhaustiveness check below.
      return;
    default: {
      const _exhaustive: never = canonical;
      void _exhaustive;
      return;
    }
  }
}

export function reduceEvents(events: Iterable<RunEvent>, opts: ReduceOptions = {}): RunResult {
  const result = emptyRunResult();
  for (const event of events) foldEvent(result, event);
  if (opts.error) result.error = opts.error;
  return result;
}
