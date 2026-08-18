// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * RunEvent → RunResult reducer.
 *
 * Consumes {@link RunEvent}s whose `type` is one of the reserved core
 * domains (`memory.added` / `pinned.set` / `output.emitted` /
 * `log.written`). Events with any other `type` are
 * passed through silently — the sink still sees them, but they do not
 * contribute to the aggregated result.
 *
 * `foldEvent` is the single switch that knows how each canonical event
 * contributes to the aggregate; the batch reducer `reduceEvents` folds the
 * whole event list through it.
 */

import type { RunEvent } from "@afps-spec/types";
import { isCanonicalRunEvent } from "../types/canonical-events.ts";
import type { PinnedSlotEntry, RunError, RunResult, TokenUsage } from "../types/run-result.ts";

export interface ReduceOptions {
  /** Optional error to attach after reduction (populated by the runner). */
  error?: RunError;
}

export function emptyRunResult(): RunResult {
  return {
    memories: [],
    output: null,
    logs: [],
  };
}

/** A fresh all-zero {@link TokenUsage} accumulator — shared by the runner
 * event mappers so the empty-usage shape has one definition. */
export function zeroTokenUsage(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/**
 * Fold a single event into a mutable result accumulator. Consumers that
 * want an immutable pipeline can seed a fresh accumulator per call.
 *
 * Open-envelope `RunEvent`s flow in; `isCanonicalRunEvent` narrows the
 * four reserved namespaces (memory / pinned / output / log) + the
 * runner-internal `appstrate.*` namespace to a discriminated union, so the
 * switch is exhaustively typed. Third-party / unknown events are silently
 * passed through — the sink still sees them, they just do not contribute
 * to the aggregated result.
 */
export function foldEvent(result: RunResult, event: RunEvent): void {
  if (!isCanonicalRunEvent(event)) return;
  const canonical = event;

  switch (canonical.type) {
    case "memory.added":
      result.memories.push({
        content: canonical.content,
        ...(canonical.scope !== undefined ? { scope: canonical.scope } : {}),
        ...(canonical.operationId !== undefined ? { operationId: canonical.operationId } : {}),
      });
      return;
    case "pinned.set": {
      // Legacy aggregate: keyed by `key` alone. Kept verbatim so consumers
      // reading `result.pinned[key]` are unaffected.
      if (result.pinned === undefined) result.pinned = {};
      const slot: { content: unknown; scope?: "actor" | "shared" } = {
        content: canonical.content ?? null,
      };
      if (canonical.scope !== undefined) slot.scope = canonical.scope;
      result.pinned[canonical.key] = slot;

      // Corrected aggregate: `(scope, key)` identity, highest revision wins.
      //
      // Arrival order is NOT causal order — two concurrent runs finish in
      // whichever order their containers happen to close, so "last event
      // received" can be an older write. When the runtime reports a revision
      // (it committed through the command route) that revision is the only
      // reliable ordering signal; without one we fall back to last-write.
      if (result.pinnedSlots === undefined) result.pinnedSlots = [];
      const scope = canonical.scope ?? "actor";
      const existing = result.pinnedSlots.find(
        (entry) => entry.key === canonical.key && (entry.scope ?? "actor") === scope,
      );
      const incomingRevision = canonical.revision;
      if (existing === undefined) {
        const entry: PinnedSlotEntry = { key: canonical.key, content: canonical.content ?? null };
        if (canonical.scope !== undefined) entry.scope = canonical.scope;
        if (incomingRevision !== undefined) entry.revision = incomingRevision;
        if (canonical.operationId !== undefined) entry.operationId = canonical.operationId;
        result.pinnedSlots.push(entry);
      } else if (
        existing.revision === undefined ||
        incomingRevision === undefined ||
        incomingRevision >= existing.revision
      ) {
        existing.content = canonical.content ?? null;
        if (canonical.scope !== undefined) existing.scope = canonical.scope;
        if (incomingRevision !== undefined) existing.revision = incomingRevision;
        if (canonical.operationId !== undefined) existing.operationId = canonical.operationId;
      }
      return;
    }
    case "output.emitted":
      result.output = canonical.data ?? null;
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
      // Runner-internal lifecycle events — do not contribute to the
      // aggregated result. Terminal status comes from `RunResult.status`
      // set on `EventSink.finalize`. Listed here so adding a new variant
      // is caught by the exhaustiveness check below.
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
