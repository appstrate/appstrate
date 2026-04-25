// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Discriminated union over the **canonical** {@link RunEvent} types the
 * runtime knows by name.
 *
 * Why this exists: `@afps-spec/types` ships {@link RunEvent} as an open
 * envelope (`type: string` + open index signature) so third-party tools
 * can emit any payload without amending the spec. That openness is
 * correct at the spec layer but defeats TypeScript exhaustiveness in
 * the runtime, where five reserved namespaces (`memory.*`, `state.*`,
 * `output.*`, `report.*`, `log.*`) carry stable, runtime-meaningful
 * shapes.
 *
 * {@link CanonicalRunEvent} narrows those five — and the `appstrate.*`
 * platform-internal events the runner emits — into a real discriminated
 * union. Switches over `event.type` get exhaustiveness via the standard
 * `_exhaustive: never` pattern. Unknown event types fall into the open
 * envelope branch and stay typed as `RunEvent` so the sink chain can
 * still route them.
 *
 * Use {@link narrowCanonicalEvent} to project an open `RunEvent` into
 * the union; `null` means "no canonical match — handle via the open
 * envelope".
 */

import type { RunEvent } from "@afps-spec/types";

interface BaseEnvelope {
  timestamp: number;
  runId: string;
  toolCallId?: string;
  // Match `RunEvent`'s open index signature so the discriminated
  // union remains a structural sub-type — sinks can pass a
  // `CanonicalRunEvent` anywhere a `RunEvent` is expected without a
  // cast.
  [key: string]: unknown;
}

/** `@afps/memory` — `add_memory()` tool. */
export interface MemoryAddedEvent extends BaseEnvelope {
  type: "memory.added";
  content: string;
}

/** `@afps/state` — `set_state()` tool. */
export interface StateSetEvent extends BaseEnvelope {
  type: "state.set";
  state: unknown;
}

/** `@afps/output` — `output()` tool. Replace-on-emit semantics. */
export interface OutputEmittedEvent extends BaseEnvelope {
  type: "output.emitted";
  data: unknown;
}

/** `@afps/report` — `report()` tool. Append-by-newline semantics. */
export interface ReportAppendedEvent extends BaseEnvelope {
  type: "report.appended";
  content: string;
}

/** `@afps/log` — `log()` tool. */
export interface LogWrittenEvent extends BaseEnvelope {
  type: "log.written";
  level: "info" | "warn" | "error";
  message: string;
}

/** `appstrate.progress` — runner-emitted lifecycle breadcrumb (container started, runtime ready, …). */
export interface AppstrateProgressEvent extends BaseEnvelope {
  type: "appstrate.progress";
  message: string;
  data?: Record<string, unknown>;
}

/** `appstrate.error` — fatal runtime error before/after the LLM loop. */
export interface AppstrateErrorEvent extends BaseEnvelope {
  type: "appstrate.error";
  message: string;
  data?: Record<string, unknown>;
}

/** `appstrate.metric` — token usage / cost / duration emitted by the runner at agent_end. */
export interface AppstrateMetricEvent extends BaseEnvelope {
  type: "appstrate.metric";
  data?: Record<string, unknown>;
  /** Sometimes inlined alongside `data` for legacy reasons. */
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Discriminated union over every canonical event the runtime owns. */
export type CanonicalRunEvent =
  | MemoryAddedEvent
  | StateSetEvent
  | OutputEmittedEvent
  | ReportAppendedEvent
  | LogWrittenEvent
  | AppstrateProgressEvent
  | AppstrateErrorEvent
  | AppstrateMetricEvent;

/** All canonical event-type strings — useful for prefix checks. */
export const CANONICAL_EVENT_TYPES = [
  "memory.added",
  "state.set",
  "output.emitted",
  "report.appended",
  "log.written",
  "appstrate.progress",
  "appstrate.error",
  "appstrate.metric",
] as const satisfies ReadonlyArray<CanonicalRunEvent["type"]>;

const CANONICAL_TYPE_SET: ReadonlySet<string> = new Set<string>(CANONICAL_EVENT_TYPES);

/**
 * True when the event's `type` is one of the canonical strings AND its
 * payload satisfies the canonical shape. Returns `false` for tampered
 * payloads (e.g. `memory.added` without a string `content`) so callers
 * can fall back to the open-envelope branch instead of trusting an
 * ill-formed event.
 *
 * Performs **structural** checks only — no deep clone, no mutation.
 */
export function isCanonicalRunEvent(event: RunEvent): event is CanonicalRunEvent {
  if (!CANONICAL_TYPE_SET.has(event.type)) return false;
  switch (event.type) {
    case "memory.added":
      return typeof (event as Record<string, unknown>).content === "string";
    case "state.set":
      return "state" in event;
    case "output.emitted":
      return "data" in event;
    case "report.appended":
      return typeof (event as Record<string, unknown>).content === "string";
    case "log.written": {
      const e = event as Record<string, unknown>;
      return (
        (e.level === "info" || e.level === "warn" || e.level === "error") &&
        typeof e.message === "string"
      );
    }
    case "appstrate.progress":
    case "appstrate.error":
      return typeof (event as Record<string, unknown>).message === "string";
    case "appstrate.metric":
      return true;
    default:
      return false;
  }
}

/**
 * Narrow an open `RunEvent` to the discriminated union, or `null` if
 * the event is third-party / unknown. Sinks should fold the canonical
 * branch via an exhaustive switch, then forward the original event to
 * downstream consumers regardless of canonicity (so third-party events
 * still flow through the pipeline).
 */
export function narrowCanonicalEvent(event: RunEvent): CanonicalRunEvent | null {
  return isCanonicalRunEvent(event) ? event : null;
}

/**
 * Compile-time exhaustiveness guard. Pass the discriminant value at the
 * `default` branch of a `switch (event.type)`; if a new variant is added
 * to {@link CanonicalRunEvent} without updating the switch, the assignment
 * fails to compile.
 *
 * Usage:
 *   default: { const _x: never = event; void _x; return; }
 */
export function assertExhaustive(value: never): never {
  throw new Error(`Unhandled canonical event type: ${JSON.stringify(value)}`);
}
